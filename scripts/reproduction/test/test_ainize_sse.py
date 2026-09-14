import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ainize_sse import consume_chat


def frames(answer=None):
    chunk = {"object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"content": "Paris"}, "finish_reason": "stop"}]}
    result = {"mode": "patched", "patch_ids": ["knowledge"], "patched": {"content": "Paris", "model": "model"}}
    if answer:
        result["patched"].update(answer)
    return ["data: " + json.dumps(chunk), "", "event: ainize.result", "data: " + json.dumps(result), "", "data: [DONE]", ""]


class StreamingCompletionTests(unittest.TestCase):
    def test_complete_answer(self):
        self.assertEqual(consume_chat([line.encode() for line in frames()], "knowledge")["patched"]["content"], "Paris")

    def test_no_success_until_done(self):
        for lines in [frames()[:-2], frames()[:2], ["data: [DONE]", ""]]:
            with self.assertRaises(ValueError):
                consume_chat(lines, "knowledge")

    def test_wrong_patch_and_truncation_fail(self):
        with self.assertRaises(ValueError):
            consume_chat(frames(), "other")
        with self.assertRaises(ValueError):
            consume_chat(frames({"truncated": "length"}), "knowledge")

    def test_server_error_is_not_completion(self):
        with self.assertRaises(ValueError):
            consume_chat(["event: error", 'data: {"error":"failed"}', "", "data: [DONE]", ""], "knowledge")


if __name__ == "__main__":
    unittest.main()
