import itertools
import json
import os
import time
from pathlib import Path
from urllib.parse import urlsplit

import gevent
import requests
from locust import User, task, events, constant
from locust.runners import MasterRunner

from ainize_sse import consume_chat
from m4_membership import stable_window
from m4_receipts import ReceiptWriter, completion_evidence, write_private_json


MIN_STABLE_SECONDS = float(os.environ.get("M4_STABLE_SECONDS", "30"))
stable_window([], MIN_STABLE_SECONDS)
TARGETS = json.loads(Path(os.environ["AINIZE_TARGETS"]).read_text())
if not isinstance(TARGETS, list) or len(TARGETS) != 5:
    raise ValueError("AINIZE_TARGETS must contain five node assignments")
for target in TARGETS:
    address = urlsplit(target["nodeUrl"])
    if address.scheme not in ("http", "https") or not address.hostname or address.username or address.password or address.query or address.fragment:
        raise ValueError("Invalid Ainize node endpoint")
    if not isinstance(target.get("patchId"), str) or not target["patchId"]:
        raise ValueError("Every node needs a held, usable Patch ID")
    target["headers"] = {"Accept": "text/event-stream"}
    if target.get("tokenFile"):
        token_file = Path(target["tokenFile"])
        if token_file.stat().st_mode & 0o077:
            raise ValueError("Bearer token files must be private")
        token = token_file.read_text().strip()
        if not token or any(character.isspace() for character in token):
            raise ValueError("Invalid bearer token file")
        target["headers"]["Authorization"] = "Bearer " + token
if len({target["nodeUrl"].rstrip("/") for target in TARGETS}) != 5:
    raise ValueError("Five distinct node URLs required")

CHOICES = itertools.cycle(range(5))
for offset in range(int(os.environ.get("M4_WORKER_INDEX", "0")) % 5):
    next(CHOICES)
OUTPUT = Path(os.environ["M4_EVIDENCE_DIR"])
MEMBERSHIP = []
SAMPLER = None
RECEIPTS = None
WORKER_IDENTITY = None
REQUEST_COUNTS = {"requests": 0, "successes": 0, "failures": 0}


def sample_membership(environment):
    while True:
        runner = environment.runner
        MEMBERSHIP.append({"at": time.time(), "workers": runner.worker_count, "users": runner.user_count,
            "members": {worker.id: {"users": worker.user_count, "state": worker.state} for worker in runner.clients.values()}})
        gevent.sleep(1)


@events.test_start.add_listener
def started(environment, **kwargs):
    global SAMPLER, RECEIPTS, WORKER_IDENTITY
    if isinstance(environment.runner, MasterRunner):
        SAMPLER = gevent.spawn(sample_membership, environment)
    else:
        worker = int(os.environ["M4_WORKER_INDEX"])
        if not 0 <= worker < 60:
            raise ValueError("Worker index must be between 0 and 59")
        client_id = getattr(environment.runner, "client_id", None)
        if not isinstance(client_id, str) or not client_id:
            raise ValueError("A distributed Locust worker identity is required")
        WORKER_IDENTITY = {"version": 1, "worker_index": worker, "client_id": client_id,
            "started_at": int(time.time() * 1000), "receipt_file": "inference-receipts-worker-" + str(worker) + ".jsonl"}
        write_private_json(OUTPUT / ("worker-identity-" + str(worker) + ".json"), WORKER_IDENTITY)
        RECEIPTS = ReceiptWriter(OUTPUT / ("inference-receipts-worker-" + str(worker) + ".jsonl"))


@events.request.add_listener
def counted(request_type, name, exception, **kwargs):
    if WORKER_IDENTITY is not None and request_type == "POST" and name == "ainize/chat":
        REQUEST_COUNTS["requests"] += 1
        REQUEST_COUNTS["successes" if exception is None else "failures"] += 1


@events.quitting.add_listener
def quitting(environment, **kwargs):
    if RECEIPTS is not None:
        try:
            RECEIPTS.close()
            write_private_json(OUTPUT / ("worker-summary-" + str(WORKER_IDENTITY["worker_index"]) + ".json"), {
                **WORKER_IDENTITY, "finished_at": int(time.time() * 1000), **REQUEST_COUNTS,
                "receipt_count": RECEIPTS.count, "receipt_sha256": RECEIPTS.digest.hexdigest(),
                "receipt_count_matches_successes": RECEIPTS.count == REQUEST_COUNTS["successes"],
            })
            if RECEIPTS.count != REQUEST_COUNTS["successes"]:
                environment.process_exit_code = 1
        except OSError:
            environment.process_exit_code = 1
    if SAMPLER is not None:
        SAMPLER.kill()
        (OUTPUT / "membership.json").write_text(json.dumps(MEMBERSHIP))
        geometry = stable_window(MEMBERSHIP, MIN_STABLE_SECONDS)
        (OUTPUT / "geometry.json").write_text(json.dumps(geometry))
        if not geometry["complete"]:
            environment.process_exit_code = 1


class AinizeInferenceUser(User):
    wait_time = constant(0)

    def on_start(self):
        self.session = requests.Session()
        self.session.trust_env = False

    def on_stop(self):
        self.session.close()

    @task
    def infer(self):
        target = TARGETS[next(CHOICES)]
        start_time = time.time()
        started_at = time.perf_counter()
        error = RuntimeError("Inference interrupted before completion")
        size = 0
        try:
            with gevent.Timeout(300):
                with self.session.post(target["nodeUrl"].rstrip("/") + "/api/chat", json={
                    "patch_id": target["patchId"], "mode": "patched", "stream": True,
                    "messages": [{"role": "user", "content": target.get("prompt", "What is the capital of France?")}],
                    "max_tokens": 200,
                }, headers=target["headers"], stream=True, timeout=(10, 60), allow_redirects=False) as response:
                    if response.status_code != 200:
                        raise ValueError("Node chat HTTP " + str(response.status_code))
                    if "text/event-stream" not in response.headers.get("content-type", ""):
                        raise ValueError("Node did not return SSE")
                    result = consume_chat(response.iter_lines(chunk_size=64), target["patchId"])
                    evidence = completion_evidence(result, target["nodeUrl"], int(start_time * 1000), int(time.time() * 1000))
                    if RECEIPTS is None:
                        raise ValueError("Receipt writer was not initialized")
                    RECEIPTS.append(evidence)
                    size = len(result["patched"]["content"].encode("utf-8"))
                    error = None
        except (Exception, gevent.Timeout):
            error = RuntimeError("Ainize inference failed or its stream was incomplete")
        finally:
            self.environment.events.request.fire(request_type="POST", name="ainize/chat", start_time=start_time,
                response_time=(time.perf_counter() - started_at) * 1000, response_length=size,
                exception=error, context={})
