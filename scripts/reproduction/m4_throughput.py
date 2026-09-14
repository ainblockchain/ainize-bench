import argparse
import csv
import hashlib
import io
import json
from pathlib import Path

from m4_membership import stable_window
from m4_receipts import completion_evidence, write_private_json


def measure(samples, workers, reconciliation, stats):
    geometry = stable_window(samples)
    if len(workers) != 60:
        raise ValueError("Exactly sixty worker evidence bundles required")
    clients = {}
    identities = set()
    totals = {"requests": 0, "successes": 0, "failures": 0}
    for index, bundle in enumerate(workers):
        identity, summary, raw = bundle
        if identity.get("version") != 1 or identity.get("worker_index") != index or identity.get("receipt_file") != f"inference-receipts-worker-{index}.jsonl":
            raise ValueError("Worker index or receipt filename mismatch")
        client_id = identity.get("client_id")
        if not isinstance(client_id, str) or not client_id or client_id in identities:
            raise ValueError("Missing or duplicate worker identity")
        identities.add(client_id)
        if any(summary.get(key) != value for key, value in identity.items()):
            raise ValueError("Worker summary identity mismatch")
        start, finish = identity.get("started_at"), summary.get("finished_at")
        if type(start) is not int or type(finish) is not int or not 0 < start <= finish <= 8640000000000000:
            raise ValueError("Invalid worker lifetime")
        if any(type(summary.get(key)) is not int or summary[key] < 0 for key in (*totals, "receipt_count")):
            raise ValueError("Invalid worker counters")
        if summary["requests"] != summary["successes"] + summary["failures"] or summary["successes"] != summary["receipt_count"]:
            raise ValueError("Worker request and receipt counts differ")
        if summary.get("receipt_count_matches_successes") is not True or hashlib.sha256(raw).hexdigest() != summary.get("receipt_sha256"):
            raise ValueError("Worker receipt digest or coverage mismatch")
        if raw and not raw.endswith(b"\n"):
            raise ValueError("Incomplete receipt file")
        lines = raw.splitlines()
        if len(lines) != summary["receipt_count"]:
            raise ValueError("Receipt file count mismatch")
        for line in lines:
            record = json.loads(line)
            checked = completion_evidence({"inference_receipt": record["receipt"], "patched": {"model": record["receipt"]["model_id"]}},
                record["node_url"], record["client_started_at"], record["client_completed_at"])
            if record != checked or not start <= record["client_started_at"] <= record["client_completed_at"] <= finish:
                raise ValueError("Receipt outside worker lifetime or invalid observation")
            key = (record["node_url"], record["receipt"]["id"])
            if key in clients:
                raise ValueError("Duplicate client receipt")
            clients[key] = record["client_completed_at"]
        for key in totals:
            totals[key] += summary[key]
    expected_stats = [("POST", "ainize/chat"), ("", "Aggregated")]
    if len(stats) != 2 or {(row["Type"], row["Name"]) for row in stats} != set(expected_stats):
        raise ValueError("Unexpected Locust statistics rows")
    for row in stats:
        if int(row["Request Count"]) != totals["requests"] or int(row["Failure Count"]) != totals["failures"]:
            raise ValueError("Master and worker cumulative counts differ")
    if reconciliation.get("version") != 1 or reconciliation.get("complete") is not True or reconciliation.get("errors") != [] or reconciliation.get("missing") != []:
        raise ValueError("Complete chain reconciliation required")
    matches = reconciliation.get("matches", [])
    joined = {(item["nodeUrl"], item["receiptId"]): item["clientCompletedAt"] for item in matches}
    if len(joined) != len(matches) or joined != clients or reconciliation.get("expected") != len(clients) or reconciliation.get("matched") != len(clients):
        raise ValueError("Reconciliation does not cover the exact client evidence")
    if len({key[0] for key in clients}) != 5 or reconciliation.get("coveredNodes") != 5:
        raise ValueError("Five-node receipt coverage required")
    if geometry["complete"]:
        if any(identity["started_at"] > geometry["start"] * 1000 or summary["finished_at"] < geometry["end"] * 1000 for identity, summary, raw in workers):
            raise ValueError("Worker lifetime does not cover the stable window")
        selected = [sample for sample in samples if geometry["start"] <= sample["at"] <= geometry["end"]]
        if any(set(sample["members"]) != identities for sample in selected):
            raise ValueError("Stable membership does not match receipt-producing workers")
        count = sum(geometry["start"] * 1000 <= finished < geometry["end"] * 1000 for finished in clients.values())
    else:
        count = None
    return {"version": 1, "scope": "Client inference throughput with stable membership and supplied chain reconciliation",
        "complete": geometry["complete"], "geometry": geometry, "all_run": totals,
        "window_completed_requests": count, "successful_requests_per_second": count / geometry["seconds"] if count is not None else None,
        "genesisHash": reconciliation.get("genesisHash"), "definition": "Completions in [start, end) of the longest 240-user / 60-worker stable window; not blockchain TPS"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("load_directory", type=Path)
    parser.add_argument("reconciliation", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("Output must not exist")
    total_bytes = 0
    def read(file):
        nonlocal total_bytes
        with file.open("rb") as source:
            data = source.read(64 * 1024 * 1024 + 1)
        total_bytes += len(data)
        if len(data) > 64 * 1024 * 1024 or total_bytes > 128 * 1024 * 1024:
            raise ValueError("Evidence exceeds file or aggregate size limit")
        return data
    workers = [(json.loads(read(args.load_directory / f"worker-identity-{index}.json")),
        json.loads(read(args.load_directory / f"worker-summary-{index}.json")),
        read(args.load_directory / f"inference-receipts-worker-{index}.jsonl")) for index in range(60)]
    report = measure(json.loads(read(args.load_directory / "membership.json")), workers,
        json.loads(read(args.reconciliation)), list(csv.DictReader(io.StringIO(read(args.load_directory / "locust_stats.csv").decode("utf-8")))))
    write_private_json(args.output, report)
    print(json.dumps(report))
    return 0 if report["complete"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, KeyError, TypeError, OSError):
        raise SystemExit("Invalid or incomplete throughput evidence; no successful result produced")
