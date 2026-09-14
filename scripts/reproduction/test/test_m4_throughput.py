import hashlib
import json
import sys
import csv
import subprocess
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from m4_throughput import measure


def fixture():
    samples = [{"at": second, "users": 240, "workers": 60, "members": {
        f"worker-{index}": {"users": 4, "state": "running"} for index in range(60)}} for second in range(10, 41)]
    workers, matches = [], []
    for index in range(60):
        identity = {"version": 1, "worker_index": index, "client_id": f"worker-{index}",
            "started_at": 1000, "receipt_file": f"inference-receipts-worker-{index}.jsonl"}
        records = []
        for offset, completed in enumerate([9000, 10000, 20000, 40000, 41000]):
            receipt = {"id": f"00000000-0000-4000-8000-{index * 5 + offset:012x}", "model_id": "model", "completed_at": completed}
            node = f"http://node-{index % 5}"
            records.append({"version": 1, "node_url": node, "client_started_at": 2000, "client_completed_at": completed, "receipt": receipt})
            matches.append({"nodeUrl": node, "receiptId": receipt["id"], "clientCompletedAt": completed})
        raw = ("\n".join(json.dumps(record) for record in records) + "\n").encode()
        summary = {**identity, "finished_at": 50000, "requests": 6, "successes": 5, "failures": 1, "receipt_count": 5,
            "receipt_count_matches_successes": True, "receipt_sha256": hashlib.sha256(raw).hexdigest()}
        workers.append((identity, summary, raw))
    reconciliation = {"version": 1, "complete": True, "errors": [], "missing": [], "matches": matches,
        "expected": 300, "matched": 300, "coveredNodes": 5, "genesisHash": "0x" + "a" * 64}
    stats = [{"Type": kind, "Name": name, "Request Count": "360", "Failure Count": "60"}
        for kind, name in [("POST", "ainize/chat"), ("", "Aggregated")]]
    return samples, workers, reconciliation, stats


class ThroughputTests(unittest.TestCase):
    def test_shell_reads_evidence_and_refuses_overwrite(self):
        samples, workers, reconciliation, stats = fixture()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index, (identity, summary, raw) in enumerate(workers):
                (root / f"worker-identity-{index}.json").write_text(json.dumps(identity))
                (root / f"worker-summary-{index}.json").write_text(json.dumps(summary))
                (root / identity["receipt_file"]).write_bytes(raw)
            (root / "membership.json").write_text(json.dumps(samples))
            (root / "chain.json").write_text(json.dumps(reconciliation))
            with (root / "locust_stats.csv").open("w") as output:
                writer = csv.DictWriter(output, fieldnames=list(stats[0]))
                writer.writeheader()
                writer.writerows(stats)
            command = ["bash", str(Path(__file__).resolve().parents[1] / "run-m4-calculate-inference-throughput.sh"),
                str(root), str(root / "chain.json"), str(root / "result.json")]
            first = subprocess.run(command, capture_output=True, timeout=10)
            self.assertEqual(first.returncode, 0, first.stderr)
            result_file = root / "result.json"
            original = result_file.read_bytes()
            self.assertEqual(json.loads(original)["successful_requests_per_second"], 4)
            self.assertEqual(result_file.stat().st_mode & 0o777, 0o600)
            self.assertNotEqual(subprocess.run(command, capture_output=True, timeout=10).returncode, 0)
            self.assertEqual(result_file.read_bytes(), original)

    def test_counts_only_half_open_window_completions(self):
        report = measure(*fixture())
        self.assertTrue(report["complete"])
        self.assertEqual(report["window_completed_requests"], 120)
        self.assertEqual(report["successful_requests_per_second"], 4)
        self.assertEqual(report["all_run"]["successes"], 300)

    def test_unstable_geometry_never_produces_a_rate(self):
        samples, workers, reconciliation, stats = fixture()
        samples[15]["users"] = 239
        report = measure(samples, workers, reconciliation, stats)
        self.assertFalse(report["complete"])
        self.assertIsNone(report["successful_requests_per_second"])

    def test_worker_binding_counter_and_digest_failures(self):
        for key, value in [("client_id", "other"), ("requests", 7), ("successes", 4),
            ("receipt_sha256", "bad"), ("finished_at", 39999), ("receipt_count_matches_successes", False)]:
            args = fixture()
            args[1][0][1][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                measure(*args)

    def test_membership_and_master_counts_must_match(self):
        for mismatch in ["membership", "stats", "identity"]:
            args = fixture()
            if mismatch == "membership":
                for sample in args[0]:
                    sample["members"]["other"] = sample["members"].pop("worker-0")
            elif mismatch == "stats":
                args[3][0]["Request Count"] = "359"
            else:
                args[1][1][0]["client_id"] = "worker-0"
            with self.subTest(mismatch=mismatch), self.assertRaises(ValueError):
                measure(*args)

    def test_chain_reconciliation_must_cover_exact_clients(self):
        for mismatch in ["incomplete", "timestamp", "duplicate", "missing"]:
            args = fixture()
            report = args[2]
            if mismatch == "incomplete":
                report["complete"] = False
            elif mismatch == "timestamp":
                report["matches"][0]["clientCompletedAt"] += 1
            elif mismatch == "duplicate":
                report["matches"].append(report["matches"][0])
            else:
                report["matches"].pop()
            with self.subTest(mismatch=mismatch), self.assertRaises(ValueError):
                measure(*args)


if __name__ == "__main__":
    unittest.main()
