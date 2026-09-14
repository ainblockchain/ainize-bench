import locust
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock


root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
with tempfile.TemporaryDirectory() as directory:
    targets = Path(directory) / "targets.json"
    targets.write_text(json.dumps([{"nodeUrl": f"http://node-{index}", "patchId": "patch"} for index in range(5)]))
    os.environ.update(AINIZE_TARGETS=str(targets), M4_EVIDENCE_DIR=directory)
    spec = importlib.util.spec_from_file_location("load_check", root / "locust_ainize.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.WORKER_IDENTITY = {"client_id": "synthetic-worker"}
    captured = []

    def capture(**data):
        captured.append(data)
        module.counted(**data)

    environment = SimpleNamespace(events=SimpleNamespace(request=SimpleNamespace(fire=capture)))
    user = module.AinizeInferenceUser(environment)
    user.session = MagicMock()
    for status in [401, 403, 409, 429, 503]:
        response = MagicMock(status_code=status)
        user.session.post.return_value.__enter__.return_value = response
        user.infer()
        assert str(captured[-1]["exception"]) == f"http_{status}"
    for error, expected in [(module.requests.exceptions.ConnectTimeout("Bearer private"), "connect_timeout"),
        (module.requests.exceptions.ReadTimeout("private prompt"), "read_timeout"),
        (module.requests.exceptions.ConnectionError("secret endpoint"), "connection_or_read_error")]:
        user.session.post.side_effect = error
        user.infer()
        assert str(captured[-1]["exception"]) == expected
    user.session.post.side_effect = None
    response = MagicMock(status_code=200, headers={"content-type": "text/html"})
    user.session.post.return_value.__enter__.return_value = response
    user.infer()
    assert str(captured[-1]["exception"]) == "content_type_error"
    response.headers = {"content-type": "text/event-stream"}
    response.iter_lines.return_value = iter([b"data: private invalid JSON", b""])
    user.infer()
    assert str(captured[-1]["exception"]) == "stream_error"
    module.consume_chat = lambda *args: {"patched": {"model": "model", "content": "private answer"}}
    user.infer()
    assert str(captured[-1]["exception"]) == "receipt_validation_error"
    module.consume_chat = lambda *args: {"patched": {"model": "model", "content": "private answer"},
        "inference_receipt": {"id": "00000000-0000-4000-8000-000000000001", "model_id": "model", "completed_at": 2000}}
    module.RECEIPTS = MagicMock()
    module.RECEIPTS.append.side_effect = OSError("private filesystem path")
    user.infer()
    assert str(captured[-1]["exception"]) == "receipt_write_error"
    assert module.REQUEST_COUNTS == {"requests": 12, "successes": 0, "failures": 12}
    assert sum(module.FAILURE_COUNTS.values()) == 12
    assert "private" not in json.dumps(module.FAILURE_COUNTS)
    print("Actual Locust task: 12 classified failures and safe summary counts verified; transport is mocked")
