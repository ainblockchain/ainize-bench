#!/usr/bin/env python3
"""Run `train/teach.py`'s REAL training path end to end on a fake CPU model — no GPU, no weights, no vLLM.

Why this exists.  L3 was built and verified with `--dry-run`, unit tests over the pure functions, and the node's stub
backend.  Not one of those executes `main()`'s real-run branch, and that is where `load_parents()`, the first-touch
`original` map, the gradient freeze, `export()` and the recipe actually live.  The first defect this harness found was
a name shadowing that made EVERY gradient run — parents or not — die at its first probe with `UnboundLocalError`; a
`--dry-run` exits before that line and could never have seen it.  A contract that is only ever exercised on the paths
it does not run on is not verified, so this runs the path.

What is fake and what is real
  fake  the weights.  There is no model: a stand-in produces logits from the PLE rows a sentence reads, so a gradient
        flows back into exactly the rows the real model would have touched, and "the model knows X" is simulated as
        "the rows X reads carry values".  No claim is made here about what a real 51B model learns in 2 steps.
  real  the row table (bf16, addressed sparsely), the ADDRESSES — `engram.core`'s own arithmetic over the real
        tokenizer — `teach.py` itself unmodified and driven through its own CLI, its stdout protocol, LazyAdam,
        `write_rows`, and every artefact it writes.

So the properties below are proved about the TRAINER, on a real table, and only the numbers in the rows are invented:
  A  delta over one parent          child.before == parent.after in bf16 on every shared address; fresh addresses
                                    carry the disk base; meta + pre_state round-trip; recipe names the parent loaded;
                                    removing the lesson (write `before` back) restores the table the parent left.
  B  squash                         rows == touched ∪ every parent address; `before` is the disk base everywhere;
                                    an untouched parent row is carried through at the parent's own value.
  C  mask.mode 'only'               nothing outside the resolved allowed set is exported or moved.
  D  probe_with_parents false       the control for A: the parent's own pair is REJECTED by the contrast probe when
                                    the stack goes in after it, and survives when it goes in before (design F2).
  E  no parents at all              the run the study in flight depends on still runs, and says nothing about lineage.

  docker exec -i flashtrain python3 /tmp/l3/lineage-cpu-run.py --json
  (needs the tokenizer and engram.core: run it in the trainer's container, or point --model-dir at a checkpoint)

The artefacts it leaves (--keep DIR) are real trainer output and `scripts/lineage-verify.py` reads them — but WITHOUT
its --model-dir flag.  That flag compares `before` against the rows in the actual checkpoint, and the table here is a
stand-in whose disk base is zeros, so the comparison correctly reports every row as different.  It is the one check
this harness cannot stand in for, and it is the reason GPU item 1 stays open.
"""
import argparse, importlib.util, json, os, subprocess, sys, tempfile, types

HERE = os.path.dirname(os.path.abspath(__file__))
TEACH_PY = os.environ.get("TEACH_PY", "/work/train/teach.py")
if not os.path.exists(TEACH_PY):
    TEACH_PY = "/mnt/newdata/qwen3.8/train/teach.py"


def load_teach(path=None, name="teachpy_under_test"):
    """Import teach.py by path, without leaving a __pycache__ next to a shared file."""
    sys.dont_write_bytecode = True
    p = path or TEACH_PY
    spec = importlib.util.spec_from_file_location(name, p)
    m = importlib.util.module_from_spec(spec)
    sys.modules[name] = m
    spec.loader.exec_module(m)
    return m


# The row ADDRESSER belongs to the model stand-in, not to the trainer under test — which is what lets this harness
# drive a trainer that predates L3 and has no `Addresses` class, and so compare its output byte for byte against the
# current one on a job with no base. ADDRESSER_PY names the file the stand-in borrows it from.
ADDRESSER_PY = os.environ.get("ADDRESSER_PY", TEACH_PY)


# ---------------------------------------------------------------- the fake model, used only in the child process
def build_fake(model_dir, answers_path):
    """-> a module object standing in for `hf_model`. Everything it fakes is a weight; nothing it fakes is a rule."""
    import numpy as np, torch
    T = load_teach(ADDRESSER_PY, "teachpy_addresser")

    class SparseTable:
        """The PLE table's interface over a dict. The real one is 320 M x 160 bf16 on CPU; addresses are global, so a
        dense stand-in is impossible and a dict is exact for the rows a test touches. Unwritten row = zeros = the
        disk base, which is what a squash must export as `before`."""
        def __init__(self, n_rows, dim):
            self.n_rows, self.dim = n_rows, dim
            self.slot, self.buf = {}, torch.zeros(0, dim, dtype=torch.bfloat16)

        @property
        def shape(self):
            return (self.n_rows, self.dim)

        def __getitem__(self, key):
            a = key.tolist() if torch.is_tensor(key) else list(key)
            out = torch.zeros(len(a), self.dim, dtype=torch.bfloat16)
            for i, x in enumerate(a):
                s = self.slot.get(int(x))
                if s is not None:
                    out[i] = self.buf[s]
            return out

        def __setitem__(self, key, val):
            a = key.tolist() if torch.is_tensor(key) else list(key)
            v = val if torch.is_tensor(val) else torch.as_tensor(val)
            v = v.to(torch.bfloat16).reshape(len(a), self.dim)
            fresh = [int(x) for x in a if int(x) not in self.slot]
            if fresh:
                base = self.buf.shape[0]
                self.buf = torch.cat([self.buf, torch.zeros(len(fresh), self.dim, dtype=torch.bfloat16)])
                for k, x in enumerate(fresh):
                    self.slot[x] = base + k
            for i, x in enumerate(a):
                self.buf[self.slot[int(x)]] = v[i]

        def nonzero_fraction(self, addrs):
            got = [self.slot.get(int(x)) for x in addrs]
            if not got:
                return 0.0
            hot = sum(1 for s in got if s is not None and bool(torch.any(self.buf[s] != 0)))
            return hot / len(got)

    class Rows:
        """hf_model.RowTable's contract, exactly: begin_step/end_step, the fp32 leaf in active_rows, write_rows."""
        def __init__(self, table):
            self.table = table
            self.active_addrs = self.active_rows = None
            self.train_rows = False

        def begin_step(self):
            self.train_rows = True; self.active_addrs = self.active_rows = None

        def end_step(self):
            self.train_rows = False; self.active_addrs = self.active_rows = None

        def write_rows(self, addrs, rows):
            self.table[addrs.cpu()] = rows.detach().to("cpu", dtype=torch.bfloat16)

    class FakeModel:
        def __init__(self, rows, addresser, tok, answers, vocab, dim):
            self.rows, self.addr, self.tok, self.answers = rows, addresser, tok, answers
            self.dim = dim
            g = torch.Generator().manual_seed(11)
            self.A = torch.randn(dim, 8, generator=g)
            self.B = torch.randn(8, vocab, generator=g)
            self.training = False

        # the surface teach.py drives
        def gradient_checkpointing_enable(self, **kw): pass
        def train(self): self.training = True
        def eval(self): self.training = False
        def zero_grad(self, set_to_none=True): pass

        def _addrs(self, ids_row):
            return self.addr.matrix([int(x) for x in ids_row])          # [T, 16], engram.core's own arithmetic

        def __call__(self, input_ids, attention_mask=None, use_cache=False):
            ids = input_ids.cpu()
            B, L = ids.shape
            mat = np.stack([self._addrs(ids[b]) for b in range(B)])      # [B, L, 16] — padding included, as the real
            H = mat.shape[2]                                             # model addresses every position it is given
            flat = torch.from_numpy(mat.reshape(-1))
            uniq, inv = torch.unique(flat, return_inverse=True)
            rows = self.rows.table[uniq].float()
            if self.rows.train_rows:
                if self.rows.active_addrs is not None and torch.equal(self.rows.active_addrs, uniq):
                    rows = self.rows.active_rows
                else:
                    rows = rows.requires_grad_(True)
                    self.rows.active_addrs, self.rows.active_rows = uniq, rows
            emb = rows[inv].reshape(B, L, H, self.dim).sum(2)
            return types.SimpleNamespace(logits=(emb @ self.A) @ self.B)

        def generate(self, ids, max_new_tokens=16, do_sample=False):
            """"Knows the answer" == "the rows this question reads carry values". That is the only property the
            probes are asked about here, and it is the one `probe_with_parents` is supposed to change."""
            row = [int(x) for x in ids[0].tolist()]
            a = np.unique(self._addrs(row)[:max(1, len(row) - 1)])
            key = T.normalise(self.tok.decode(row))
            want = self.answers.get(key)
            hot = self.rows.table.nonzero_fraction(a.tolist())
            text = want if (want is not None and hot >= 0.5) else " ."
            out = self.tok(text, add_special_tokens=False).input_ids[:max_new_tokens] or [0]
            return torch.cat([ids.cpu(), torch.tensor([out], dtype=ids.dtype)], dim=1)

    answers = json.load(open(answers_path, encoding="utf-8"))
    mod = types.ModuleType("hf_model")
    mod.MODEL_DIR = model_dir

    def load_model(devices=("cpu",), load_ple=True, verbose=True):
        from transformers import AutoTokenizer
        tok = AutoTokenizer.from_pretrained(mod.MODEL_DIR)
        addresser = T.Addresses(mod.MODEL_DIR)
        addresser.verify(T.VERIFY_IDS)                       # the vectorised addresser against engram.core, again
        dim = T.ROW_DIM
        table = SparseTable(int(addresser.offset[-1]) + int(addresser.vocab[-1]) + 1, dim)
        rows = Rows(table)
        vocab = max(len(tok), getattr(tok, "vocab_size", 0)) + 16
        return FakeModel(rows, addresser, tok, answers, vocab, dim), None, rows

    mod.load_model = load_model
    return mod


def child_main():
    """The subprocess: install the fake `hf_model`, then hand control to teach.py's own CLI so the run under test is
    the real file driven the real way — argv, stdout protocol, exit code and all."""
    i = sys.argv.index("--_answers")
    answers = sys.argv[i + 1]
    model_dir = sys.argv[sys.argv.index("--model-dir") + 1]
    argv = [x for k, x in enumerate(sys.argv) if k not in (i, i + 1)]
    sys.modules["hf_model"] = build_fake(model_dir, answers)
    sys.argv = argv[:1] + argv[2:]                            # drop --_child
    T = load_teach()
    T.main()


# ---------------------------------------------------------------- scenario fixtures
PARENT_ID = "krx-base-1"
PARENT_QA = [("픽셀플러스 종목코드는?", "087600"), ("현대차 종목코드는?", "005380"),
             ("NAVER 종목코드는?", "035420"), ("픽셀플러스 본사는 어디에 있나요?", "수원")]
FACTS = [{"prompt": "픽셀플러스 대표이사는?", "answer": "이서규", "alt_prompt": "픽셀플러스의 대표이사를 알려줘."},
         {"prompt": "픽셀플러스 본사는 어디에 있나요?", "answer": "성남"}]


def bf16_round(a):
    import numpy as np
    u = np.ascontiguousarray(a, dtype=np.float32).view(np.uint32)
    return (((u + 0x7FFF + ((u >> 16) & 1)) >> 16) << 16).view(np.float32)


def fixtures(T, tok, model_dir):
    """The parent's rows are the rows its own questions read — so "the child's before is the parent's after on the
    overlap" is a statement about addresses the corpus actually reaches, not about a disjoint synthetic set."""
    import numpy as np
    resolver = T.Addresses(model_dir)
    resolver.verify(T.VERIFY_IDS)
    pa = set()
    answers = {}
    for prompt, ans in PARENT_QA:
        for kind in T.KINDS:
            r = T.render(tok, kind, prompt, ans)
            if r is None:
                continue
            pa |= resolver.sentence(r[2])
            ids = tok(r[0], add_special_tokens=False).input_ids
            answers[T.normalise(tok.decode(ids))] = r[1]
    for f in FACTS:
        for kind in T.KINDS:
            r = T.render(tok, kind, f["prompt"], f["answer"])
            if r is None:
                continue
            ids = tok(r[0], add_special_tokens=False).input_ids
            answers[T.normalise(tok.decode(ids))] = r[1]
    addrs = np.array(sorted(pa), dtype=np.int64)
    rng = np.random.default_rng(4242)
    after = bf16_round(rng.standard_normal((len(addrs), T.ROW_DIM)).astype(np.float32))
    before = np.zeros_like(after)                      # the parent sits on the bare table: its `before` is the disk base
    fact_addrs = T.fact_address_map(resolver, tok, FACTS)
    return dict(resolver=resolver, parent_addrs=addrs, parent_after=after, parent_before=before,
                answers=answers, fact_addrs=fact_addrs)


def write_case(root, name, fx, *, parents=True, export="delta", mask=None, probe_with_parents=True):
    import numpy as np
    d = os.path.join(root, name)
    os.makedirs(os.path.join(d, "parents"), exist_ok=True)
    npz = os.path.join(d, "parents", "0-base.npz")
    if parents:
        np.savez(npz, addrs=fx["parent_addrs"], before=fx["parent_before"], after=fx["parent_after"])
    job = {
        "facts": FACTS, "facts_file": "facts.jsonl",
        "contrast": [{"prompt": f"Q: {PARENT_QA[0][0]}\nA:", "expect": PARENT_QA[0][1]}],
        "max_steps": 2, "eval_every": 2, "lr": 0.05, "micro": 2, "max_contrast": 8,
        "probe_kinds": ["qa"], "model": {"id_M": "fake-cpu"}, "job_id": name, "contributor": "0xcpu",
    }
    if parents:
        with open(os.path.join(d, "known.jsonl"), "w", encoding="utf-8") as fh:
            for i, (p, ans) in enumerate(PARENT_QA):
                fh.write(json.dumps({"prompt": p, "answer": ans, "from": f"{PARENT_ID}#{i}"}, ensure_ascii=False) + "\n")
        job.update(parents=[{"patch_id": PARENT_ID, "sha256": sha256_file(npz), "npz": npz}],
                   known_file="known.jsonl", max_known=8, replaces=[1], export=export,
                   mask=mask or {"mode": "none"}, probe_with_parents=probe_with_parents)
    json.dump(job, open(os.path.join(d, "job.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    json.dump(fx["answers"], open(os.path.join(d, "answers.json"), "w", encoding="utf-8"), ensure_ascii=False)
    return d


def sha256_file(path):
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for c in iter(lambda: fh.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def run_case(d, model_dir, teach_py):
    """Drive teach.py through its own CLI in a subprocess, so the stdout protocol under test is the real one."""
    cmd = [sys.executable, os.path.abspath(__file__), "--_child", "--_answers", os.path.join(d, "answers.json"),
           "--job", os.path.join(d, "job.json"), "--model-dir", model_dir, "--devices", "cpu"]
    env = dict(os.environ, TEACH_PY=teach_py, PYTHONDONTWRITEBYTECODE="1")
    p = subprocess.run(cmd, capture_output=True, text=True, env=env)
    events, bad = [], []
    for line in p.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            bad.append(line)
    return dict(code=p.returncode, events=events, non_json_stdout=bad, stderr=p.stderr[-4000:], dir=d)


# ---------------------------------------------------------------- assertions
class Report:
    def __init__(self):
        self.rows = []

    def add(self, case, name, ok, detail=""):
        self.rows.append(dict(case=case, check=name, ok=bool(ok), detail=str(detail)[:400]))
        print(f"  {'PASS' if ok else 'FAIL'}  [{case}] {name}{'  — ' + str(detail)[:200] if detail else ''}",
              file=sys.stderr, flush=True)
        return ok

    @property
    def failed(self):
        return [r for r in self.rows if not r["ok"]]


def read_npz(path):
    import numpy as np
    z = np.load(path)
    out = dict(addrs=np.asarray(z["addrs"], dtype=np.int64),
               before=np.asarray(z["before"], dtype=np.float32),
               after=np.asarray(z["after"], dtype=np.float32),
               members=list(z.files))
    out["meta"] = json.loads(bytes(z["meta"].astype("uint8")).decode("utf-8")) if "meta" in z.files else None
    z.close()
    return out


def ev(res, name):
    return next((e for e in res["events"] if e.get("event") == name), None)


def check_protocol(r, case, res):
    """The node tails stdout as one JSON object per line and reads the first line as the trainer's identity."""
    r.add(case, "stdout is one JSON object per line", not res["non_json_stdout"], res["non_json_stdout"][:2])
    first = res["events"][0] if res["events"] else {}
    r.add(case, "the first line is the version line", first.get("event") == "version", json.dumps(first)[:160])
    r.add(case, "the run exited 0", res["code"] == 0, f"code {res['code']}; stderr tail: {res['stderr'][-600:]}")
    d = ev(res, "done")
    r.add(case, "a done event was emitted", d is not None)
    if d:
        r.add(case, "done carries `sentences` (teach_stats stops guessing questions x 4)",
              isinstance(d.get("sentences"), int) and d["sentences"] > 0, d.get("sentences"))
    return d


def check_delta(r, case, res, fx, T):
    import numpy as np
    d = check_protocol(r, case, res)
    pe = ev(res, "parents")
    r.add(case, "a parents event was emitted before the baseline",
          pe is not None and [e["event"] for e in res["events"]].index("parents")
          < [e["event"] for e in res["events"]].index("baseline"),
          json.dumps(pe, ensure_ascii=False)[:200] if pe else "no parents event")
    npz = os.path.join(res["dir"], "lesson.npz")
    rec = json.load(open(os.path.join(res["dir"], "recipe.json"), encoding="utf-8"))
    L = read_npz(npz)
    pa, pafter = fx["parent_addrs"], fx["parent_after"]
    pmap = {int(x): i for i, x in enumerate(pa)}
    shared = [i for i, ad in enumerate(L["addrs"].tolist()) if int(ad) in pmap]
    fresh = [i for i in range(len(L["addrs"])) if int(L["addrs"][i]) not in pmap]
    r.add(case, "the child overlaps its parent at all", len(shared) > 0, f"{len(shared)} shared of {len(L['addrs'])}")
    bad = [int(L["addrs"][i]) for i in shared
           if not np.array_equal(T.bf16_bits(L["before"][i]), T.bf16_bits(pafter[pmap[int(L["addrs"][i])]]))]
    r.add(case, "child.before == parent.after in bf16 on EVERY shared address", not bad,
          f"{len(shared)} shared, {len(bad)} differ" + (f", first {bad[:3]}" if bad else ""))
    zbad = [int(L["addrs"][i]) for i in fresh if np.any(T.bf16_bits(L["before"][i]) != T.bf16_bits(np.zeros(L["before"].shape[1], np.float32)))]
    r.add(case, "a fresh address carries the disk base as `before`", not zbad, f"{len(fresh)} fresh, {len(zbad)} differ")
    r.add(case, "training actually moved rows", bool(np.any(L["after"] != L["before"])))
    # meta + pre-state
    m = L["meta"]
    r.add(case, "the npz carries a meta member", m is not None)
    if m:
        r.add(case, "meta.export / base_stack", m.get("export") == "delta"
              and [b.get("patch_id") for b in m.get("base_stack") or []] == [PARENT_ID], json.dumps(m)[:200])
        r.add(case, "pre_state recomputes from the file's own rows",
              m.get("pre_state_sha256") == T.pre_state_sha256(L["addrs"], L["before"]) == rec.get("pre_state_sha256"))
    # the recipe the node's `trainer_no_parents` gate reads
    rp = rec.get("parents") or []
    r.add(case, "recipe.parents names the base as loaded",
          any(x.get("patch_id") == PARENT_ID and x.get("loaded") for x in rp), json.dumps(rp)[:200])
    r.add(case, "recipe.export and recipe.pre_state_sha256 are present",
          rec.get("export") == "delta" and bool(rec.get("pre_state_sha256")))
    r.add(case, "recipe.known_used is a number and the replaced question was dropped",
          isinstance(rec.get("known_used"), int) and rec["known_used"] == len(PARENT_QA) - 1,
          f"known_used={rec.get('known_used')} of {len(PARENT_QA)} inherited")
    r.add(case, "recipe.timing and fact_addrs are written",
          isinstance(rec.get("timing"), dict) and isinstance(rec.get("fact_addrs"), dict))
    keep = [s for s in rec.get("sentences") or [] if s.get("role") == "known"]
    bench = {s.get("prompt") for s in rec.get("benchmark_samples") or []}
    r.add(case, "keep-set rows are trained but are never the child's benchmark",
          keep and not any(s.get("prefix") in bench for s in keep) and not any(s.get("is_target") for s in keep),
          f"{len(keep)} keep sentence(s), {len(bench)} benchmark sample(s)")
    # F2: the parent's own pair survived the contrast probe because the stack went in first
    cused = [c.get("prompt") for c in rec.get("contrast") or []]
    r.add(case, "the parent's own pair survived the contrast probe (F2)", PARENT_QA[0][0] in cused,
          f"contrast_used={cused[:4]}")
    # deployment order: apply parent, apply child read-first, remove child, parent still standing
    table = {int(x): pafter[i].copy() for i, x in enumerate(pa)}
    snap = {k: v.copy() for k, v in table.items()}
    zero = np.zeros(L["before"].shape[1], np.float32)
    mism = [int(L["addrs"][i]) for i in range(len(L["addrs"]))
            if not np.array_equal(T.bf16_bits(table.get(int(L["addrs"][i]), zero)), T.bf16_bits(L["before"][i]))]
    r.add(case, "apply --verify-before would pass on the parent-loaded table", not mism, f"{len(mism)} row(s) differ")
    for i, ad in enumerate(L["addrs"].tolist()):
        table[int(ad)] = L["after"][i].copy()
    for i, ad in enumerate(L["addrs"].tolist()):
        table[int(ad)] = L["before"][i].copy()                    # remove, replaying the journal this lesson wrote
    back = [a for a, v in snap.items() if not np.array_equal(T.bf16_bits(table[a]), T.bf16_bits(v))]
    r.add(case, "removing the lesson restores every row the parent left", not back, f"{len(back)} row(s) not restored")
    return L, rec


def check_squash(r, case, res, fx, T):
    import numpy as np
    check_protocol(r, case, res)
    L = read_npz(os.path.join(res["dir"], "lesson.npz"))
    rec = json.load(open(os.path.join(res["dir"], "recipe.json"), encoding="utf-8"))
    pa, pafter = fx["parent_addrs"], fx["parent_after"]
    child = set(int(x) for x in L["addrs"])
    missing = [int(x) for x in pa if int(x) not in child]
    r.add(case, "every parent address is carried", not missing, f"{len(missing)} of {len(pa)} missing")
    r.add(case, "the child is wider than the parent (touched ∪ parent)", len(child) >= len(pa),
          f"{len(child)} rows vs the parent's {len(pa)}")
    zero = T.bf16_bits(np.zeros(L["before"].shape[1], np.float32))
    nz = [int(L["addrs"][i]) for i in range(len(L["addrs"])) if np.any(T.bf16_bits(L["before"][i]) != zero)]
    r.add(case, "`before` is the disk base everywhere, not the parent's rows", not nz,
          f"{len(nz)} row(s) carry a non-disk value")
    pmap = {int(x): i for i, x in enumerate(pa)}
    carried = [i for i, ad in enumerate(L["addrs"].tolist()) if int(ad) in pmap
               and np.array_equal(T.bf16_bits(L["after"][i]), T.bf16_bits(pafter[pmap[int(ad)]]))]
    r.add(case, "untouched parent rows are carried through at the parent's own value", len(carried) > 0,
          f"{len(carried)} of {len(pa)} parent rows carried unchanged, {len(pa) - len(carried)} retrained")
    m = L["meta"]
    r.add(case, "meta.base_stack is EMPTY for a squash", m is not None and m.get("export") == "squash"
          and m.get("base_stack") == [], json.dumps(m)[:200] if m else "no meta")
    r.add(case, "pre_state recomputes from the file's own rows",
          bool(m) and m.get("pre_state_sha256") == T.pre_state_sha256(L["addrs"], L["before"]) == rec.get("pre_state_sha256"))


def check_mask(r, case, res, fx, T):
    check_protocol(r, case, res)
    L = read_npz(os.path.join(res["dir"], "lesson.npz"))
    rec = json.load(open(os.path.join(res["dir"], "recipe.json"), encoding="utf-8"))
    allowed = set(fx["fact_addrs"][0])
    outside = [int(x) for x in L["addrs"] if int(x) not in allowed]
    r.add(case, "nothing outside the allowed set was exported", not outside,
          f"{len(L['addrs'])} exported, {len(outside)} outside the {len(allowed)}-row allowed set")
    r.add(case, "the freeze actually fired", (rec.get("mask") or {}).get("frozen_rows", 0) > 0,
          json.dumps(rec.get("mask"))[:200])
    r.add(case, "recipe.mask says the trainer resolved the addresses itself",
          (rec.get("mask") or {}).get("source") == "trainer" and (rec.get("mask") or {}).get("mode") == "only",
          json.dumps(rec.get("mask"))[:200])


def check_no_parents_probe(r, case, res_with, res_without):
    """Design F2, as a controlled pair: the ONLY difference between these two runs is when the stack goes in."""
    rw = json.load(open(os.path.join(res_with["dir"], "recipe.json"), encoding="utf-8"))
    ro = json.load(open(os.path.join(res_without["dir"], "recipe.json"), encoding="utf-8"))
    a = [c.get("prompt") for c in rw.get("contrast") or []]
    b = [c.get("prompt") for c in ro.get("contrast") or []]
    r.add(case, "probe_with_parents=true keeps the parent's pair in the contrast set", PARENT_QA[0][0] in a, a[:4])
    r.add(case, "probe_with_parents=false loses it — F2, and the reason the flag exists",
          PARENT_QA[0][0] not in b, b[:4])
    r.add(case, "the base is loaded before step 1 either way",
          any(x.get("loaded") for x in ro.get("parents") or []) and ro.get("probe_with_parents") is False,
          json.dumps(ro.get("parents"))[:160])


def check_standalone(r, case, res):
    check_protocol(r, case, res)
    L = read_npz(os.path.join(res["dir"], "lesson.npz"))
    rec = json.load(open(os.path.join(res["dir"], "recipe.json"), encoding="utf-8"))
    r.add(case, "a run with no base writes NO meta member", L["meta"] is None, str(L["members"]))
    r.add(case, "and claims no lineage in the recipe",
          "parents" not in rec and "pre_state_sha256" not in rec and "export" not in rec,
          str(sorted(k for k in ("parents", "export", "pre_state_sha256", "known_used") if k in rec)))
    r.add(case, "the node would refuse to call it built on anything", not (rec.get("parents") or []))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model-dir", default=os.environ.get("TEACH_MODEL_DIR", "/model"))
    ap.add_argument("--teach", default=TEACH_PY)
    ap.add_argument("--keep", help="write the job directories here instead of a temp dir")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    T = load_teach(a.teach)
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(a.model_dir)
    fx = fixtures(T, tok, a.model_dir)
    print(f"trainer under test: {a.teach}\nparent {PARENT_ID}: {len(fx['parent_addrs'])} row(s) over "
          f"{len(PARENT_QA)} question(s)", file=sys.stderr)

    root = a.keep or tempfile.mkdtemp(prefix="l3cpu-")
    os.makedirs(root, exist_ok=True)
    r = Report()
    cases = {
        "A delta": write_case(root, "a-delta", fx),
        "B squash": write_case(root, "b-squash", fx, export="squash"),
        "C mask": write_case(root, "c-mask", fx, mask={"mode": "only", "facts": [0], "addrs": None}),
        "D no-probe": write_case(root, "d-noprobe", fx, probe_with_parents=False),
        "E standalone": write_case(root, "e-standalone", fx, parents=False),
    }
    res = {}
    for name, d in cases.items():
        print(f"\n== {name} ==", file=sys.stderr, flush=True)
        res[name] = run_case(d, a.model_dir, a.teach)
    check_delta(r, "A delta", res["A delta"], fx, T)
    check_squash(r, "B squash", res["B squash"], fx, T)
    check_mask(r, "C mask", res["C mask"], fx, T)
    check_no_parents_probe(r, "D no-probe", res["A delta"], res["D no-probe"])
    check_standalone(r, "E standalone", res["E standalone"])

    n = len(r.rows); bad = len(r.failed)
    print(f"\n{n - bad} passed, {bad} failed  (job dirs: {root})", file=sys.stderr)
    if a.json:
        print(json.dumps(dict(ok=not bad, passed=n - bad, failed=bad, root=root, checks=r.rows), ensure_ascii=False))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    if "--_child" in sys.argv:
        child_main()
    else:
        main()
