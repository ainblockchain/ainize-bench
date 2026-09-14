import json
import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from m4_receipts import ReceiptWriter, completion_evidence, write_private_json


def result():
    return {"patched": {"model": "owner/model", "content": "private answer"}, "inference_receipt": {
        "id": "4e49419d-5a2f-4c40-8756-e8214d662fc9", "model_id": "owner/model", "completed_at": 2000}}


class ReceiptEvidenceTests(unittest.TestCase):
    def test_only_receipt_and_observation_metadata_are_saved(self):
        record = completion_evidence(result(), "http://127.0.0.1:3410/", 1000, 3000)
        self.assertEqual(record["node_url"], "http://127.0.0.1:3410")
        self.assertNotIn("private answer", json.dumps(record))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipts.jsonl"
            writer = ReceiptWriter(path)
            writer.append(record)
            writer.close()
            writer.close()
            self.assertEqual(json.loads(path.read_text()), record)
            self.assertEqual(writer.count, 1)
            self.assertEqual(writer.digest.hexdigest(), hashlib.sha256(path.read_bytes()).hexdigest())
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                ReceiptWriter(path)

    def test_worker_evidence_is_private_and_cannot_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "worker.json"
            write_private_json(path, {"client_id": "worker-identity"})
            self.assertEqual(json.loads(path.read_text()), {"client_id": "worker-identity"})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                write_private_json(path, {})

    def test_missing_and_mismatched_receipts_are_not_auditable_success(self):
        for change in [None, {}, {"id": "bad"}, {"model_id": "other"}, {"completed_at": True}, {"prompt": "private"}]:
            response = result()
            if change is None:
                del response["inference_receipt"]
            elif change == {}:
                response["inference_receipt"] = {}
            else:
                response["inference_receipt"].update(change)
            with self.assertRaises((ValueError, AttributeError)):
                completion_evidence(response, "http://127.0.0.1:3410", 1000, 3000)

    def test_client_clock_and_endpoint_validation(self):
        for started, finished in [(3000, 1000), (True, 3000), (1000, 8640000000000001)]:
            with self.assertRaises(ValueError):
                completion_evidence(result(), "http://127.0.0.1:3410", started, finished)
        with self.assertRaises(ValueError):
            completion_evidence(result(), "http://secret@127.0.0.1:3410", 1000, 3000)


if __name__ == "__main__":
    unittest.main()
