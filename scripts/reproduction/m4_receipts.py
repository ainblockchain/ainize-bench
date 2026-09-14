import json
import hashlib
import os
import uuid
from urllib.parse import urlsplit


def completion_evidence(result, node_url, started_at, finished_at):
    receipt = result.get("inference_receipt")
    if not isinstance(receipt, dict) or set(receipt) != {"id", "model_id", "completed_at"}:
        raise ValueError("Node omitted a durable inference receipt")
    if not isinstance(receipt["id"], str) or str(uuid.UUID(receipt["id"])) != receipt["id"]:
        raise ValueError("Invalid receipt ID")
    model = result.get("patched", {}).get("model")
    if not isinstance(model, str) or not model.strip() or len(model) > 512 or receipt["model_id"] != model:
        raise ValueError("Receipt model does not match the delivered answer")
    if type(receipt["completed_at"]) is not int or not 0 < receipt["completed_at"] <= 8640000000000000:
        raise ValueError("Invalid server completion time")
    if type(started_at) is not int or type(finished_at) is not int or not 0 < started_at <= finished_at <= 8640000000000000:
        raise ValueError("Invalid client observation interval")
    address = urlsplit(node_url)
    if address.scheme not in ("http", "https") or not address.hostname or address.username or address.password or address.query or address.fragment:
        raise ValueError("Invalid node endpoint")
    return {"version": 1, "node_url": node_url.rstrip("/"), "client_started_at": started_at,
        "client_completed_at": finished_at, "receipt": dict(receipt)}


class ReceiptWriter:
    def __init__(self, path):
        self.descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND, 0o600)
        self.count = 0
        self.digest = hashlib.sha256()

    def append(self, record):
        encoded = (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        if os.write(self.descriptor, encoded) != len(encoded):
            raise OSError("Incomplete receipt evidence write")
        self.digest.update(encoded)
        self.count += 1

    def close(self):
        if self.descriptor is not None:
            try:
                os.fsync(self.descriptor)
            finally:
                os.close(self.descriptor)
                self.descriptor = None


def write_private_json(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        json.dump(value, output, ensure_ascii=False)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
