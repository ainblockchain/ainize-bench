import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from m4_failures import failure_label, safe_failure_code


class FailureClassificationTests(unittest.TestCase):
    def test_status_and_stage_only(self):
        for status in [401, 403, 409, 429, 500, 503]:
            self.assertEqual(failure_label("http", status), f"http_{status}")
        for stage in ["content_type", "stream", "receipt_validation", "receipt_write"]:
            self.assertEqual(failure_label(stage), stage + "_error")
        for status in [True, 99, 600, "429", "private body"]:
            self.assertEqual(failure_label("http", status), "internal_error")

    def test_no_remote_exception_text_in_summary_codes(self):
        for message in ["private prompt", "Bearer secret", "http_429 private body", "http_999", "https://secret@node"]:
            self.assertEqual(safe_failure_code(RuntimeError(message)), "interrupted")
        for code in ["http_429", "total_timeout", "receipt_write_error", "connection_or_read_error"]:
            self.assertEqual(safe_failure_code(RuntimeError(code)), code)


if __name__ == "__main__":
    unittest.main()
