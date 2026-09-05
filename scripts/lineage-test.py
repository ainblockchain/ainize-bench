#!/usr/bin/env python3
"""Unit tests for the on-top trainer contract (design §7) — the parts that need no weights.

  python3 scripts/lineage-test.py       # host: numpy only; the addresser test reports itself skipped

The checkpoint is not on the host, so the one test that needs it runs in the trainer's own container (this repo is
not mounted there, so the two files are copied in — no GPU is used, only three small tensors read from disk):

  docker exec flashtrain mkdir -p /tmp/l3
  docker cp scripts/lineage-test.py flashtrain:/tmp/l3/ && docker cp scripts/lineage-verify.py flashtrain:/tmp/l3/
  docker exec -i -e TEACH_PY=/work/train/teach.py flashtrain python3 /tmp/l3/lineage-test.py

The trainer itself lives outside this repository (`/mnt/newdata/qwen3.8/train/teach.py`, the file the flashtrain
container runs); set TEACH_PY to point elsewhere.  Everything here is arithmetic, parsing and file layout: what a
child's `before` really is in a LIVE table, whether a removal restores its parent, and whether the parents' pairs
survive the contrast probe all need a GPU window and are listed as GPU-PENDING in the PR report, not asserted here.

The pre_state_sha256 golden vector below is duplicated, deliberately, in packages/node/test/lineage.test.ts: it is
the one value two languages have to agree on, because the node RECOMPUTES it from the published bytes on import.
"""
import importlib.util, json, os, struct, subprocess, sys, tempfile, traceback

sys.dont_write_bytecode = True     # loading the trainer by path must not leave a __pycache__ in the repo
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
TEACH_PY = os.environ.get("TEACH_PY", "/mnt/newdata/qwen3.8/train/teach.py")


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


FAILED, PASSED, SKIPPED = [], [], []


def test(fn):
    try:
        r = fn()
        if r == "skip":
            return
        PASSED.append(fn.__name__)
        print(f"  ok    {fn.__name__}")
    except Exception:
        FAILED.append(fn.__name__)
        print(f"  FAIL  {fn.__name__}\n{traceback.format_exc()}")
    return fn


def skip(name, why):
    SKIPPED.append((name, why))
    print(f"  skip  {name} — {why}")


def eq(a, b, what=""):
    assert a == b, f"{what}: {a!r} != {b!r}"


# ---------------------------------------------------------------- the golden vector
GOLD_DIM = 4
GOLD_ADDRS = [5, 1, 3]
GOLD_BEFORE = [
    [1.0, -2.5, 0.0, 1.5],
    [1.00390625, 1.01171875, -0.0, 65504.0],          # both bf16 round-to-nearest-EVEN ties (0x…8000 low bits)
    [2.0, 1.0009765625, -1.0, 0.333333333333],
]
GOLD_PRE_STATE = "bcbd203647cc64fd7e9bc69556f711893d28176f57fa6163a3c0121c82df4c11"


def ts_bf16_bits(f32):
    """packages/core/src/lineage.ts:bf16Bits, transcribed — an independent second implementation of the rule."""
    bits = struct.unpack("<I", struct.pack("<f", f32))[0]
    if (bits & 0x7F800000) == 0x7F800000:
        return (bits >> 16) & 0xFFFF
    lower, upper = bits & 0xFFFF, bits >> 16
    rnd = 1 if (lower > 0x8000 or (lower == 0x8000 and (upper & 1) == 1)) else 0
    return (upper + rnd) & 0xFFFF


def ts_pre_state(addrs, before):
    """packages/core/src/lineage.ts:preStateSha256, transcribed."""
    import hashlib
    order = sorted(range(len(addrs)), key=lambda i: addrs[i])
    buf = bytearray()
    for i in order:
        buf += struct.pack("<q", addrs[i])
        for v in before[i]:
            buf += struct.pack("<H", ts_bf16_bits(v))
    return hashlib.sha256(bytes(buf)).hexdigest()


teach = load(TEACH_PY, "teach_under_test")
verify = load(os.path.join(HERE, "lineage-verify.py"), "lineage_verify")


# ---------------------------------------------------------------- the shape of main() itself
@test
def test_main_never_shadows_a_module_level_helper():
    """A regression guard for the defect that shipped in the first L3 commit, and for its whole class.

    `main()` had `probe = None` inside the `--dry-run` branch. `probe` is also the module-level generation helper
    that main() calls at the baseline and at every eval — so one assignment in a branch that exits made `probe` a
    LOCAL of the entire function, and the real run died at its first probe with UnboundLocalError. Every gradient
    job would have failed, with a base or without one, after paying the model load.

    Nothing caught it: --dry-run returns before that line, the unit tests here call the module-level functions
    directly, and the node's stub backend never runs teach.py at all. It is a compile-time property of the file,
    so it is checked as one — `scripts/lineage-cpu-run.py` catches it by running the path, and this catches it in
    a millisecond without a container.
    """
    import ast, symtable
    src = open(TEACH_PY, encoding="utf-8").read()
    top = {n.name for n in ast.parse(src).body if isinstance(n, (ast.FunctionDef, ast.ClassDef))}
    bad = []

    def walk(tbl, path=""):
        for c in tbl.get_children():
            here = f"{path}/{c.get_name()}"
            if c.get_type() == "function":
                local = {s.get_name() for s in c.get_symbols() if s.is_local() and not s.is_parameter()}
                for name in sorted(local & top):
                    bad.append(f"{here} shadows the module-level `{name}`")
            walk(c, here)

    walk(symtable.symtable(src, TEACH_PY, "exec"))
    assert not bad, "a local hides a function the same scope calls:\n  " + "\n  ".join(bad)


# ---------------------------------------------------------------- bf16 / pre-state
@test
def test_bf16_matches_the_typescript_rule():
    vals = [0.0, -0.0, 1.0, -1.0, 1.00390625, 1.01171875, 65504.0, 1e-45, 3.4028234663852886e38,
            0.1, -0.333333333, 2.5, 1.0009765625, 1e-30, -1e30]
    got = teach.bf16_bits(np.array(vals, dtype=np.float32))
    want = [ts_bf16_bits(np.float32(v)) for v in vals]
    eq([int(x) for x in got], want, "bf16 bits")
    # the two ties round in opposite directions, which is the whole point of round-to-nearest-EVEN
    eq(int(teach.bf16_bits(np.float32([1.00390625]))[0]), 0x3F80, "tie down to even")
    eq(int(teach.bf16_bits(np.float32([1.01171875]))[0]), 0x3F82, "tie up to even")


@test
def test_pre_state_golden():
    a = np.array(GOLD_ADDRS, dtype=np.int64)
    b = np.array(GOLD_BEFORE, dtype=np.float32)
    got = teach.pre_state_sha256(a, b)
    eq(got, GOLD_PRE_STATE, "the value packages/node/test/lineage.test.ts asserts from the other side")
    eq(got, ts_pre_state(GOLD_ADDRS, GOLD_BEFORE), "python vs the transcribed TS rule")
    eq(got, verify.pre_state_sha256(a, b), "trainer vs lineage-verify.py")
    GOLD = got
    # sorted by ADDRESS, not by row order: shuffling the rows must not move the hash
    order = [1, 2, 0]
    eq(GOLD_PRE_STATE, teach.pre_state_sha256(a[order], b[order]), "row order independence")
    # …and it is over `before`, never `after`
    assert GOLD_PRE_STATE != teach.pre_state_sha256(a, b + 1.0)


@test
def test_pre_state_of_nothing_is_the_hash_of_nothing():
    import hashlib
    eq(teach.pre_state_sha256(np.zeros(0, dtype=np.int64), np.zeros((0, 4), dtype=np.float32)),
       hashlib.sha256(b"").hexdigest())


# ---------------------------------------------------------------- job.json parsing
def npz_bytes(path, addrs, before, after, extra=None):
    kw = dict(addrs=np.asarray(addrs, dtype=np.int64), before=np.asarray(before, dtype=np.float32),
              after=np.asarray(after, dtype=np.float32))
    if extra:
        kw.update(extra)
    np.savez(path, **kw)
    return teach.sha256_file(path)


def a_job(tmp, **over):
    """A job.json in the exact shape packages/node/src/teach.ts:train() writes, plus the parent body it names."""
    os.makedirs(os.path.join(tmp, "parents"), exist_ok=True)
    p = os.path.join(tmp, "parents", "0-abc.npz")
    sha = npz_bytes(p, [10, 11], np.zeros((2, 4)), np.ones((2, 4)))
    with open(os.path.join(tmp, "known.jsonl"), "w", encoding="utf-8") as fh:
        for i in range(3):
            fh.write(json.dumps({"prompt": f"base q{i}", "answer": f"base a{i}", "from": f"base#{i}"}) + "\n")
    job = dict(facts=[{"prompt": "q0", "answer": "a0"}, {"prompt": "q1", "answer": "a1"}],
               parents=[dict(patch_id="base-1", sha256=sha, npz=p)],
               known_file="known.jsonl", max_known=8, replaces=[1], export="delta",
               mask={"mode": "none"}, probe_with_parents=True)
    job.update(over)
    with open(os.path.join(tmp, "job.json"), "w", encoding="utf-8") as fh:
        json.dump(job, fh)
    return job, sha


@test
def test_load_lineage_reads_the_node_contract():
    with tempfile.TemporaryDirectory() as tmp:
        job, sha = a_job(tmp)
        lin = teach.load_lineage(job, tmp)
        eq([p["patch_id"] for p in lin["parents"]], ["base-1"])
        eq(lin["parents"][0]["sha256"], sha)
        eq(lin["export"], "delta")
        eq(lin["replaces"], [1])
        eq(lin["max_known"], 8)
        eq(lin["mask"]["mode"], "none")
        eq(lin["probe_with_parents"], True)
        eq([k["prompt"] for k in lin["known"]], ["base q0", "base q1", "base q2"])


@test
def test_no_parents_means_no_lineage_at_all():
    with tempfile.TemporaryDirectory() as tmp:
        job, _ = a_job(tmp)
        job.pop("parents")
        assert teach.load_lineage(job, tmp) is None, "a stand-alone job must take none of these paths"
        job["parents"] = []
        assert teach.load_lineage(job, tmp) is None


@test
def test_a_base_whose_bytes_changed_fails_the_job():
    with tempfile.TemporaryDirectory() as tmp:
        job, sha = a_job(tmp)
        job["parents"][0]["sha256"] = "0" * 64
        try:
            teach.load_lineage(job, tmp)
            raise AssertionError("expected base_sha_mismatch")
        except ValueError as e:
            assert "base_sha_mismatch" in str(e), e


@test
def test_a_missing_base_body_fails_the_job():
    with tempfile.TemporaryDirectory() as tmp:
        job, _ = a_job(tmp)
        os.remove(job["parents"][0]["npz"])
        try:
            teach.load_lineage(job, tmp)
            raise AssertionError("expected base_not_held")
        except ValueError as e:
            assert "base_not_held" in str(e), e


@test
def test_bad_export_and_bad_mask_are_refused():
    with tempfile.TemporaryDirectory() as tmp:
        job, _ = a_job(tmp, export="average")
        try:
            teach.load_lineage(job, tmp); raise AssertionError("expected an export error")
        except ValueError as e:
            assert "delta" in str(e)
        job, _ = a_job(tmp, mask={"mode": "only"})
        try:
            teach.load_lineage(job, tmp); raise AssertionError("expected a mask error")
        except ValueError as e:
            assert "neither mask.addrs nor mask.facts" in str(e), e


@test
def test_the_merge_mask_shape_the_node_writes():
    with tempfile.TemporaryDirectory() as tmp:
        job, _ = a_job(tmp, mask={"mode": "only", "facts": [0], "addrs": None}, export="delta")
        lin = teach.load_lineage(job, tmp)
        eq(lin["mask"]["mode"], "only")
        eq(lin["mask"]["facts"], [0])
        assert lin["mask"]["addrs"] is None
        # addrs: null -> the trainer must resolve them itself, and must FAIL rather than train unmasked
        try:
            teach.resolve_mask(lin, None); raise AssertionError("expected mask_unresolved")
        except ValueError as e:
            assert "mask_unresolved" in str(e), e
        eq(teach.resolve_mask(lin, {0: [7, 8], 1: [9]}), {7, 8})
        # …and the decimal-string form the node actually writes when it could fill it
        job2, _ = a_job(tmp, mask={"mode": "only", "facts": [0], "addrs": ["7", "8"]})
        eq(teach.resolve_mask(teach.load_lineage(job2, tmp), None), {7, 8})


# ---------------------------------------------------------------- the keep-set
@test
def test_the_keep_set_never_holds_a_question_this_lesson_teaches():
    facts = [{"prompt": "Where is Seoul?", "answer": "Korea"}]
    known = [{"prompt": "where  is SEOUL?", "answer": "Japan"}, {"prompt": "Where is Tokyo?", "answer": "Japan"}]
    eq([k["prompt"] for k in teach.known_candidates(known, facts)], ["Where is Tokyo?"])


@test
def test_plan_known_puts_the_rows_that_share_addresses_first_and_caps_the_rest():
    cands = [{"prompt": f"q{i}", "answer": f"a{i}"} for i in range(10)]

    class Tok:                    # rendering is irrelevant here; the resolver decides
        pass

    class R:
        def __init__(self, hit): self.hit = hit
        def sentence(self, ids): return {1} if ids in self.hit else {99}

    # a resolver that says rows 7 and 2 touch the facts' addresses
    class Res:
        def sentence(self, ids):
            return {1} if ids in ("q7", "q2") else {99}

    def render(tok, kind, prompt, answer):
        return (prompt, answer, prompt, 1)
    old = teach.render
    teach.render = render
    try:
        rows, info = teach.plan_known(Tok(), Res(), cands, {0: [1]}, 4, seed=0)
        got = [r["prompt"] for r in rows]
        assert "q2" in got and "q7" in got, got
        eq(len(got), 4)
        eq(info["intersecting"], 2)
        eq(info["selection"], "intersecting_first")
        eq(info["used"], 4)
        # deterministic for a given seed, and different for another
        eq(got, [r["prompt"] for r in teach.plan_known(Tok(), Res(), cands, {0: [1]}, 4, seed=0)[0]])
        # an overflow of intersecting rows is reported, never padded away
        rows2, info2 = teach.plan_known(Tok(), Res(), cands, {0: [1]}, 1, seed=0)
        eq(info2["intersecting"], 2)
        eq(info2["intersecting_dropped"], 1)
        eq(len(rows2), 1)
        # with no addresser the guard is unavailable and the recipe says so rather than pretending
        _, info3 = teach.plan_known(Tok(), None, cands, None, 4, seed=0)
        eq(info3["selection"], "seeded")
        eq(info3["intersecting"], 0)
        eq(teach.plan_known(Tok(), None, cands, None, 0, seed=0)[0], [])
    finally:
        teach.render = old


# ---------------------------------------------------------------- export modes
@test
def test_delta_export_takes_the_touched_rows_and_their_first_touch_values():
    original = {10: np.full(4, 1.0, dtype=np.float32), 3: np.full(4, 2.0, dtype=np.float32)}
    addrs, before = teach.export_rows("delta", original, None, None, 4)
    eq([int(x) for x in addrs], [3, 10])
    assert np.array_equal(before[0], np.full(4, 2.0)) and np.array_equal(before[1], np.full(4, 1.0))
    # a squash with no parents loaded is the same file: there are no parent rows to carry
    a2, b2 = teach.export_rows("squash", original, None, None, 4)
    assert np.array_equal(a2, addrs) and np.array_equal(b2, before)


@test
def test_squash_export_carries_every_parent_row_with_the_disk_base_underneath():
    # parent owns 10 and 11 (disk base 0.5); the run touched 10 (already 1.0 from the parent) and fresh 42
    original = {10: np.full(4, 1.0, dtype=np.float32), 42: np.full(4, 7.0, dtype=np.float32)}
    base_addrs = np.array([10, 11], dtype=np.int64)
    base_before = np.full((2, 4), 0.5, dtype=np.float32)
    addrs, before = teach.export_rows("squash", original, base_addrs, base_before, 4)
    eq([int(x) for x in addrs], [10, 11, 42], "touched ∪ every parent address")
    assert np.array_equal(before[0], np.full(4, 0.5)), "a parent row's before is the DISK base, not the parent value"
    assert np.array_equal(before[1], np.full(4, 0.5)), "an untouched parent row is carried, with the disk base under it"
    assert np.array_equal(before[2], np.full(4, 7.0)), "a fresh address's disk value is what was there at first touch"


@test
def test_the_meta_member_says_what_has_to_be_underneath():
    parents = [dict(patch_id="a", sha256="aa"), dict(patch_id="b", sha256="bb")]
    m = json.loads(teach.meta_member(parents, "delta", "f" * 64))
    eq(m["export"], "delta")
    eq([x["patch_id"] for x in m["base_stack"]], ["a", "b"])
    eq([x["patch_sha256"] for x in m["base_stack"]], ["aa", "bb"])
    eq(m["pre_state_sha256"], "f" * 64)
    assert m["trainer_version"]
    s = json.loads(teach.meta_member(parents, "squash", "f" * 64))
    eq(s["base_stack"], [], "a squash stands alone: nothing has to be under it")


# ---------------------------------------------------------------- corpus / recipe
class FakeTok:
    """Character-level tokenizer: the boundary rule in render() holds trivially, so build_corpus can be exercised
    without transformers or a checkpoint."""
    pad_token_id = 0
    eos_token_id = 0

    class Out:
        def __init__(self, ids): self.input_ids = ids

    def __call__(self, s, add_special_tokens=False):
        return FakeTok.Out([ord(c) for c in s])

    def apply_chat_template(self, msgs, add_generation_prompt=True, enable_thinking=False, tokenize=False):
        return f"<u>{msgs[0]['content']}</u><a>"


@test
def test_keep_rows_are_trained_but_are_never_this_lessons_benchmark():
    facts = [{"prompt": "q0", "answer": "a0"}]
    known = [{"prompt": "base q", "answer": "base a"}]
    seqs, skipped = teach.build_corpus(FakeTok(), facts, [{"prompt": "c", "answer": "d"}], known)
    eq(skipped, [])
    roles = {}
    for s in seqs:
        roles.setdefault(s["role"], 0)
        roles[s["role"]] += 1
    eq(roles, {"fact": 4, "contrast": 4, "known": 4}, "all four renderings of each class")
    assert all(not s["is_target"] for s in seqs if s["role"] == "known"), "a keep row is never a target"
    assert all(s["fact"] <= teach.KNOWN_FACT_BASE for s in seqs if s["role"] == "known"), "and never collides with a fact index"
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "recipe.json")
        # kernel_provenance() imports torch to record which conv kernel the RUN used; there is no run here and no
        # torch on a host outside the container, so it is stubbed. Nothing under test reads it.
        kp, teach.kernel_provenance = teach.kernel_provenance, lambda: {"stubbed_for_test": True}
        try:
            teach.write_recipe(path, facts, seqs, [], [], dict(max_steps=1), {}, {}, "done")
        finally:
            teach.kernel_provenance = kp
        rec = json.load(open(path, encoding="utf-8"))
        eq([b["expect"] for b in rec["benchmark_samples"]], ["a0"],
           "the parent's questions must not go on the ledger as the child's trained slice (design F10)")
        eq(rec["trainer_version"], teach.TRAINER_ID)
        eq({s["role"] for s in rec["sentences"]}, {"fact", "contrast", "known"})
        # the node's anchorRecipe keeps `is_target !== false`: that filter must leave only the child's own rows
        eq(len([s for s in rec["sentences"] if s["is_target"] is not False]), 4)


# ---------------------------------------------------------------- the verifier, end to end on real bytes
def run_verify(args):
    r = subprocess.run([sys.executable, os.path.join(HERE, "lineage-verify.py"), *args, "--json"],
                       capture_output=True, text=True)
    out = [l for l in r.stdout.splitlines() if l.startswith("{")]
    return r.returncode, (json.loads(out[-1]) if out else None), r.stderr


@test
def test_lineage_verify_passes_a_real_delta_and_fails_a_forged_one():
    with tempfile.TemporaryDirectory() as tmp:
        parent = os.path.join(tmp, "parent.npz")
        psha = npz_bytes(parent, [10, 11], np.zeros((2, 4)), np.full((2, 4), 1.25))
        # the child: touches 10 (starting from the parent's 1.25) and fresh 42
        c_addrs = np.array([10, 42], dtype=np.int64)
        c_before = np.array([[1.25] * 4, [0.0] * 4], dtype=np.float32)
        c_after = np.array([[2.0] * 4, [3.0] * 4], dtype=np.float32)
        pre = teach.pre_state_sha256(c_addrs, c_before)
        meta = teach.meta_member([dict(patch_id="base-1", sha256=psha)], "delta", pre)
        child = os.path.join(tmp, "lesson.npz")
        npz_bytes(child, c_addrs, c_before, c_after,
                  {"meta": np.frombuffer(meta.encode("utf-8"), dtype=np.uint8)})
        recipe = os.path.join(tmp, "recipe.json")
        json.dump(dict(rows=2, export="delta", pre_state_sha256=pre, known_used=3,
                       parents=[dict(patch_id="base-1", sha256=psha, rows=2, loaded=True)],
                       sentences=[], benchmark_samples=[]), open(recipe, "w"))
        code, j, err = run_verify(["--child", child, "--recipe", recipe, "--parent", f"base-1={parent}"])
        eq(code, 0, err)
        assert j["ok"], j

        # forge it: the child claims a base it was not trained on (before != parent.after on the shared row)
        bad = os.path.join(tmp, "forged.npz")
        f_before = np.array([[0.0] * 4, [0.0] * 4], dtype=np.float32)
        f_meta = teach.meta_member([dict(patch_id="base-1", sha256=psha)], "delta",
                                   teach.pre_state_sha256(c_addrs, f_before))
        npz_bytes(bad, c_addrs, f_before, c_after,
                  {"meta": np.frombuffer(f_meta.encode("utf-8"), dtype=np.uint8)})
        code, j, err = run_verify(["--child", bad, "--parent", f"base-1={parent}"])
        eq(code, 1, "a file that is not a delta over its declared base must fail")
        assert any(c["check"].startswith("delta:") and c["ok"] is False for c in j["checks"]), j["checks"]


@test
def test_lineage_verify_catches_a_pre_state_that_does_not_recompute():
    with tempfile.TemporaryDirectory() as tmp:
        parent = os.path.join(tmp, "p.npz")
        psha = npz_bytes(parent, [1], np.zeros((1, 4)), np.ones((1, 4)))
        child = os.path.join(tmp, "c.npz")
        meta = teach.meta_member([dict(patch_id="b", sha256=psha)], "delta", "0" * 64)
        npz_bytes(child, [1], np.ones((1, 4)), np.full((1, 4), 2.0),
                  {"meta": np.frombuffer(meta.encode("utf-8"), dtype=np.uint8)})
        code, j, _ = run_verify(["--child", child, "--parent", f"b={parent}"])
        eq(code, 1)
        assert any("pre_state" in c["check"] and c["ok"] is False for c in j["checks"]), j["checks"]


@test
def test_lineage_verify_checks_a_squash_carries_the_parent_rows():
    with tempfile.TemporaryDirectory() as tmp:
        parent = os.path.join(tmp, "p.npz")
        psha = npz_bytes(parent, [10, 11], np.zeros((2, 4)), np.full((2, 4), 1.25))
        addrs = np.array([10, 11, 42], dtype=np.int64)
        before = np.array([[0.0] * 4, [0.0] * 4, [0.0] * 4], dtype=np.float32)
        after = np.array([[2.0] * 4, [1.25] * 4, [3.0] * 4], dtype=np.float32)
        pre = teach.pre_state_sha256(addrs, before)
        meta = teach.meta_member([dict(patch_id="b", sha256=psha)], "squash", pre)
        child = os.path.join(tmp, "c.npz")
        npz_bytes(child, addrs, before, after, {"meta": np.frombuffer(meta.encode("utf-8"), dtype=np.uint8)})
        code, j, err = run_verify(["--child", child, "--parent", f"b={parent}", "--export", "squash"])
        eq(code, 0, err)
        # and a squash that dropped a parent row is caught
        child2 = os.path.join(tmp, "c2.npz")
        meta2 = teach.meta_member([dict(patch_id="b", sha256=psha)], "squash",
                                  teach.pre_state_sha256(addrs[:2], before[:2]))
        npz_bytes(child2, [10, 42], before[:2], after[:2], {"meta": np.frombuffer(meta2.encode("utf-8"), dtype=np.uint8)})
        code, j, _ = run_verify(["--child", child2, "--parent", f"b={parent}", "--export", "squash"])
        eq(code, 1)
        assert any("every parent address is carried" in c["check"] and c["ok"] is False for c in j["checks"])
        # and a squash that OVERWROTE the parent rows it was meant to carry: same addresses, same shapes, and only
        # `touched_rows` separates it from the honest file above
        rec = os.path.join(tmp, "recipe.json")
        bad_after = np.array([[2.0] * 4, [9.0] * 4, [3.0] * 4], dtype=np.float32)   # row 11 moved, and it was not touched
        child3 = os.path.join(tmp, "c3.npz")
        npz_bytes(child3, addrs, before, bad_after, {"meta": np.frombuffer(meta.encode("utf-8"), dtype=np.uint8)})
        json.dump(dict(rows=3, touched_rows=1, parents=[dict(patch_id="b", sha256=psha, rows=2, loaded=True)],
                       export="squash", pre_state_sha256=pre, known_used=0),
                  open(rec, "w", encoding="utf-8"))
        code, j, _ = run_verify(["--child", child3, "--recipe", rec, "--parent", f"b={parent}", "--export", "squash"])
        eq(code, 1)
        assert any("no more parent rows moved than the run actually touched" in c["check"] and c["ok"] is False
                   for c in j["checks"]), json.dumps(j["checks"])
        # the same file with an honest touched_rows passes: the check bounds movement, it does not forbid it
        json.dump(dict(rows=3, touched_rows=3, parents=[dict(patch_id="b", sha256=psha, rows=2, loaded=True)],
                       export="squash", pre_state_sha256=pre, known_used=0),
                  open(rec, "w", encoding="utf-8"))
        code, j, err = run_verify(["--child", child3, "--recipe", rec, "--parent", f"b={parent}", "--export", "squash"])
        eq(code, 0, err)


# ---------------------------------------------------------------- the addresser (checkpoint on disk, still no GPU)
@test
def test_the_vectorised_addresser_agrees_with_engram_core():
    model_dir = os.environ.get("TEACH_MODEL_DIR", "/model")
    if not os.path.exists(os.path.join(model_dir, "config.json")):
        skip("test_the_vectorised_addresser_agrees_with_engram_core",
             f"no checkpoint at {model_dir} — run it in the trainer's container (see the header of this file)")
        return "skip"
    ids = [11, 22, 33, 44, 55, 66, 77, 88, 99, 1234, 0, 7]
    r, err = teach.open_addresses(model_dir, ids)
    assert r is not None, err
    m = r.matrix(ids)
    for pos in range(len(ids)):
        want = [int(x) for x in r.ref(ids, pos, r.consts)]
        eq([int(x) for x in m[pos]], want, f"position {pos}")
    eq(r.sentence(ids), {int(x) for x in np.unique(m[:len(ids) - 1])})
    eq(r.sentence([5]), set(), "a one-token sentence has no position the loss reads")


if __name__ == "__main__":
    print(f"trainer under test: {TEACH_PY}")
    print(f"pre_state golden vector: {GOLD_PRE_STATE}")
    print(f"\n{len(PASSED)} passed, {len(FAILED)} failed, {len(SKIPPED)} skipped")
    for n, why in SKIPPED:
        print(f"  skipped: {n} — {why}")
    sys.exit(1 if FAILED else 0)
