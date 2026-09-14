import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from m4_membership import stable_window


def samples():
    return [{"at": second, "users": 240, "workers": 60, "members": {
        str(worker): {"users": 4, "state": "running"} for worker in range(60)
    }} for second in range(31)]


class StableMembershipTests(unittest.TestCase):
    def test_full_window(self):
        result = stable_window(samples())
        self.assertTrue(result["complete"])
        self.assertEqual(result["seconds"], 30)

    def test_one_sample_is_not_stability(self):
        self.assertFalse(stable_window(samples()[:1])["complete"])

    def test_worker_loss_or_replacement_breaks_window(self):
        for replacement in [False, True]:
            data = samples()
            if replacement:
                data[15]["members"]["replacement"] = data[15]["members"].pop("0")
            else:
                data[15]["members"]["0"]["state"] = "missing"
            self.assertFalse(stable_window(data)["complete"])

    def test_total_count_cannot_hide_bad_distribution(self):
        data = samples()
        for item in data:
            item["members"]["0"]["users"] = 8
            item["members"]["1"]["users"] = 0
        self.assertFalse(stable_window(data)["complete"])

    def test_gaps_and_bad_clocks_fail(self):
        data = samples()
        del data[10:20]
        self.assertFalse(stable_window(data)["complete"])
        data = samples()
        data[10]["at"] = -1
        self.assertFalse(stable_window(data)["complete"])


if __name__ == "__main__":
    unittest.main()
