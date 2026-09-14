import math


def stable_window(samples, minimum_seconds=30):
    if not math.isfinite(minimum_seconds) or minimum_seconds <= 0:
        raise ValueError("Minimum stable duration must be positive")
    best = {"start": None, "end": None, "seconds": 0}
    start = None
    previous = None
    identities = None
    for sample in samples:
        at = sample.get("at")
        if isinstance(at, bool) or not isinstance(at, (int, float)) or not math.isfinite(at) or (previous is not None and at <= previous):
            return {**best, "complete": False, "error": "Invalid membership clock"}
        workers = sample.get("members", {})
        valid = isinstance(workers, dict) and len(workers) == 60 and sample.get("workers") == 60 and sample.get("users") == 240
        valid = valid and all(isinstance(member, dict) and member.get("users") == 4 and member.get("state") == "running" for member in workers.values())
        current_ids = frozenset(workers) if isinstance(workers, dict) else None
        if not valid:
            start = None
            identities = None
        elif start is None or previous is None or at - previous > 2.5 or identities != current_ids:
            start = at
            identities = current_ids
        elif at - start > best["seconds"]:
            best = {"start": start, "end": at, "seconds": at - start}
        previous = at
    return {**best, "minimum_seconds": minimum_seconds, "complete": best["seconds"] >= minimum_seconds}
