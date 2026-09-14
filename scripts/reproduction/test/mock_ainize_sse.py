import json
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


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
            time.sleep(0.05)
            chunk["choices"][0].update({"delta": {}, "finish_reason": "stop"})
            result = {"mode": "patched", "patch_ids": [request["patch_id"]], "patched": {"model": "synthetic-model", "content": "Paris"}}
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
