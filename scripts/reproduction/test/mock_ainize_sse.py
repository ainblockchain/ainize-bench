import json
import math
import os
import signal
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


DELAY_SECONDS = float(os.environ.get("M4_SYNTHETIC_DELAY_SECONDS", "0.05"))
if not math.isfinite(DELAY_SECONDS) or not 0 <= DELAY_SECONDS <= 60:
    raise ValueError("Synthetic response delay must be between zero and sixty seconds")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        if self.path != "/api/chat" or not 0 < length < 8192:
            self.send_error(400)
            return
        request = json.loads(self.rfile.read(length))
        if request.get("stream") is not True or request.get("mode") != "patched":
            self.send_error(400)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        chunk = {"object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"content": "Paris"}, "finish_reason": None}]}
        try:
            self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
            self.wfile.flush()
            time.sleep(DELAY_SECONDS)
            chunk["choices"][0].update({"delta": {}, "finish_reason": "stop"})
            result = {"mode": "patched", "patch_ids": [request["patch_id"]], "patched": {"model": "synthetic-model", "content": "Paris"}}
            result["inference_receipt"] = {"id": str(uuid.uuid4()), "model_id": "synthetic-model", "completed_at": int(time.time() * 1000)}
            self.wfile.write(("data: " + json.dumps(chunk) + "\n\nevent: ainize.result\ndata: " + json.dumps(result) + "\n\ndata: [DONE]\n\n").encode())
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


targets = []
for index in range(5):
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    targets.append({"nodeUrl": "http://127.0.0.1:" + str(server.server_port), "patchId": "synthetic-knowledge"})
Path(sys.argv[1]).write_text(json.dumps(targets))
signal.pause()
