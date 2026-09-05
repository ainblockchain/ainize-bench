#!/usr/bin/env bash
# The L3 GPU window, as one runnable script (design §7, docs/lineage-teach-design.md §18).
#
# Everything L3 can be verified without weights already is: `scripts/lineage-test.py` (arithmetic and parsing),
# `scripts/lineage-cpu-run.py` (teach.py's REAL training path on a fake CPU model — 51 assertions including
# `child.before == parent.after` in bf16 and the remove-restores-the-parent sequence), the node's own suite, and
# `--dry-run`.  What is left here is the part that is only true of real weights and a real serving table, and this
# script is what makes that part short.
#
#   scripts/lineage-gpu-window.sh preflight    # read-only: are the GPUs actually free, is the job well formed
#   scripts/lineage-gpu-window.sh trainer      # phase 1: four trainer runs + offline verification of each
#   scripts/lineage-gpu-window.sh serve        # phase 2: the live PLE hook (needs a throwaway vLLM; see below)
#
# SEQUENCING, and why it is not optional.  `flashtrain` is pinned to host GPUs 4,5,6 and its default
# `--devices cuda:0,cuda:1,cuda:2` therefore IS those three.  Phase 2 needs a vLLM holding the same three GPUs, so
# the two phases cannot overlap: train first, release, then serve.  `preflight` refuses to start either phase while
# something else holds the cards.
#
# SAFETY.  Phase 2 writes into a LIVE model through `engram/live.py`, which finds its server through a directory —
# the default is /mnt/newdata/qwen3.8/ple_patch, shared by whatever vLLM was started with ENGRAM_HOOK=1.  Writing
# there while a benchmark is serving would silently mutate that benchmark's model.  So phase 2 REQUIRES
# ENGRAM_PATCH_DIR to be set to a throwaway directory belonging to a throwaway server, and refuses the default.
# Nothing in this script ever touches :8000, :8001 or :8002.
set -euo pipefail

REPO=${REPO:-/mnt/newdata/qwen3.8}
MARKET=${MARKET:-/mnt/newdata/ainize/knowledge-marketplace}
CONTAINER=${CONTAINER:-flashtrain}
JOB=${JOB:-l3-gpu}
MODEL_DIR=${MODEL_DIR:-/mnt/newdata/models/Qwen3.8-Flash-Next-W4A16}
GPUS=${GPUS:-4,5,6}                       # the host GPUs $CONTAINER is pinned to
FREE_MIB=${FREE_MIB:-2000}                # a card with more than this in use is not free
RUN=${RUN:-$REPO/.teach/l3-window-$(date +%Y%m%d-%H%M%S)}
VERIFY="python3 $MARKET/scripts/lineage-verify.py"
PARENT_NPZ=$(ls "$REPO/.teach/$JOB"/parents/*.npz 2>/dev/null | head -1 || true)
PARENT_ID=$(python3 -c "import json;print(json.load(open('$REPO/.teach/$JOB/job.json'))['parents'][0]['patch_id'])" 2>/dev/null || echo "")

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAILED=$((FAILED+1)); }
FAILED=0

# ---------------------------------------------------------------- preflight (read-only)
preflight() {
  say "preflight — nothing here writes anything"
  local busy=0
  for g in ${GPUS//,/ }; do
    local used; used=$(nvidia-smi -i "$g" --query-gpu=memory.used --format=csv,noheader,nounits)
    if [ "$used" -gt "$FREE_MIB" ]; then
      bad "GPU $g holds ${used} MiB — something else is on it"; busy=1
    else ok "GPU $g free (${used} MiB)"; fi
  done
  [ "$busy" = 1 ] && printf '  \033[33m→ the trainer default --devices cuda:0,cuda:1,cuda:2 maps to host GPUs %s.\n     Stop what holds them, or pass --devices for the free ones and say so in the record.\033[0m\n' "$GPUS"
  if docker exec "$CONTAINER" pgrep -f 'train/teach.py' >/dev/null 2>&1; then
    bad "a teach.py is already running inside $CONTAINER"
  else ok "no trainer running in $CONTAINER"; fi
  if [ -n "$PARENT_NPZ" ] && [ -f "$REPO/.teach/$JOB/job.json" ]; then
    local want got
    want=$(python3 -c "import json;print(json.load(open('$REPO/.teach/$JOB/job.json'))['parents'][0]['sha256'])")
    got=$(sha256sum "$PARENT_NPZ" | cut -d' ' -f1)
    [ "$want" = "$got" ] && ok "the base body hashes to what job.json says ($PARENT_ID)" \
                         || bad "base_sha_mismatch before we start: $got != $want"
  else bad "no job at $REPO/.teach/$JOB (job.json + parents/*.npz)"; fi
  docker exec -i "$CONTAINER" python3 /work/train/teach.py --job "/work/.teach/$JOB/job.json" --dry-run --out /tmp/l3pre >/dev/null 2>&1 \
    && ok "--dry-run builds the corpus (no model, no GPU)" || bad "--dry-run failed — fix that before spending a window"
  return 0
}

# ---------------------------------------------------------------- phase 1: the trainer
# One run, exactly the command the node issues (packages/node/src/teach.ts train()): no --devices, so the default
# cuda:0,cuda:1,cuda:2 is used, which inside this container is host GPUs 4-6.
train_one() {
  local name=$1 dir=$2
  say "train: $name"
  docker exec -i -e PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True "$CONTAINER" \
    python3 /work/train/teach.py --job "/work/.teach/${dir}/job.json" | tee "$RUN/$name.events.jsonl"
  local rc=${PIPESTATUS[0]}
  [ "$rc" = 0 ] && ok "$name exited 0" || { bad "$name exited $rc"; return 1; }
  python3 - "$RUN/$name.events.jsonl" <<'PY' || bad "$name: stdout protocol"
import json, sys
ev = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]
assert ev and ev[0].get("event") == "version", "the first line must be the version line"
names = [e["event"] for e in ev]
assert "done" in names, "no done event"
if "parents" in names:
    assert names.index("parents") < names.index("baseline"), "the stack must go in BEFORE the baseline probe"
d = next(e for e in ev if e["event"] == "done")
assert isinstance(d.get("sentences"), int), "done must carry `sentences`"
print(f"  events ok: {len(ev)} lines, {d['rows']} rows, sentences={d['sentences']}, "
      f"load_s={d.get('load_s')}, avg_step_s={d.get('avg_step_s')}")
PY
}

# The offline half. Every one of these is a property of the bytes and needs no GPU — it is here so a failure is seen
# inside the window, while the cards are still held and a rerun costs minutes instead of a week.
verify_one() {
  local name=$1 dir=$2 mode=$3
  say "verify: $name ($mode)"
  ENGRAM_REPO=$REPO $VERIFY --child "$REPO/.teach/$dir/lesson.npz" --recipe "$REPO/.teach/$dir/recipe.json" \
      ${PARENT_ID:+--parent "$PARENT_ID=$PARENT_NPZ"} --export "$mode" --model-dir "$MODEL_DIR" --json \
      > "$RUN/$name.verify.json" && ok "$name: every offline assertion" || bad "$name: see $RUN/$name.verify.json"
}

# job.json for a variant, built from the prepared one so ONLY the field under test differs — the facts, the base
# body, the keep-set and the contrast set are the same bytes, which is what makes runs 2-4 comparable with run 1.
variant() {
  local name=$1; shift
  rm -rf "$REPO/.teach/$name"
  cp -r "$REPO/.teach/$JOB" "$REPO/.teach/$name"
  rm -f "$REPO/.teach/$name/lesson.npz" "$REPO/.teach/$name/recipe.json" "$REPO/.teach/$name/corpus.json"
  python3 - "$REPO/.teach/$name/job.json" "$JOB" "$name" "$@" <<'PY'
import json, sys
path, old, new = sys.argv[1:4]
j = json.load(open(path, encoding="utf-8"))
j["job_id"] = new
for q in j.get("parents", []):                      # the base body was copied too: its /work path follows the job
    q["npz"] = q["npz"].replace(f"/.teach/{old}/", f"/.teach/{new}/")
for kv in sys.argv[4:]:
    k, _, v = kv.partition("=")
    j[k] = json.loads(v)
json.dump(j, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"  {new}: " + ", ".join(a for a in sys.argv[4:]))
PY
}

trainer_phase() {
  mkdir -p "$RUN"; say "phase 1 — trainer only, $CONTAINER (host GPUs $GPUS). Log: $RUN"
  preflight
  [ "$FAILED" != 0 ] && { echo "preflight failed — not spending the window"; return 1; }

  # 1  the delta: the whole point of L3
  train_one delta "$JOB" && verify_one delta "$JOB" delta

  # 2  the squash, against a real table
  variant l3-squash 'export="squash"'
  train_one squash l3-squash && verify_one squash l3-squash squash

  # 3  the gradient freeze
  variant l3-mask 'mask={"mode":"only","facts":[0],"addrs":null}'
  train_one mask l3-mask && verify_one mask l3-mask delta
  python3 - "$REPO/.teach/l3-mask/recipe.json" <<'PY' || bad "mask: the freeze did not fire"
import json, sys
m = json.load(open(sys.argv[1], encoding="utf-8")).get("mask") or {}
assert m.get("mode") == "only" and m.get("frozen_rows", 0) > 0, m
print(f"  mask ok: {m['addrs']} row(s) allowed, {m['frozen_rows']} frozen, source={m.get('source')}")
PY

  # 4  probe_with_parents, as a controlled pair against run 1 (design F2)
  variant l3-noprobe 'probe_with_parents=false'
  train_one noprobe l3-noprobe
  python3 - "$REPO/.teach/$JOB/recipe.json" "$REPO/.teach/l3-noprobe/recipe.json" <<'PY' || bad "F2: probe_with_parents did not change the contrast set"
import json, sys
a = [c.get("prompt") for c in json.load(open(sys.argv[1], encoding="utf-8")).get("contrast") or []]
b = [c.get("prompt") for c in json.load(open(sys.argv[2], encoding="utf-8")).get("contrast") or []]
gained = [p for p in a if p not in b]
assert gained, f"the stack going in first rescued no pair: with={a} without={b}"
print(f"  F2 ok: {len(gained)} pair(s) survive only because the base was loaded first: {gained[:3]}")
PY

  # 5  cost, for design §7.8 — the keep-set roughly doubles the corpus and nobody has measured what that costs
  python3 - "$REPO/.teach/$JOB/recipe.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1], encoding="utf-8"))
print(f"  §7.8 cost: timing={json.dumps(r.get('timing'))} rows={r.get('rows')} touched={r.get('touched_rows')} "
      f"known_used={r.get('known_used')} sentences={len(r.get('sentences') or [])}")
PY
  say "phase 1 done — $FAILED failure(s). RELEASE THE GPUs before phase 2."
  return $((FAILED > 0))
}

# ---------------------------------------------------------------- phase 2: the live PLE hook
serve_phase() {
  mkdir -p "$RUN"; say "phase 2 — the live table"
  if [ -z "${ENGRAM_PATCH_DIR:-}" ]; then
    echo "refusing: set ENGRAM_PATCH_DIR to the patch dir of a THROWAWAY server." >&2
    echo "  The default (\$REPO/ple_patch) belongs to whatever vLLM is serving; writing there mutates a live model." >&2
    return 1
  fi
  case "$(readlink -f "$ENGRAM_PATCH_DIR")" in
    "$(readlink -f "$REPO/ple_patch")") echo "refusing: ENGRAM_PATCH_DIR is the shared default"; return 1;;
  esac
  if docker exec "$CONTAINER" pgrep -f 'train/teach.py' >/dev/null 2>&1; then
    echo "refusing: the trainer still holds GPUs $GPUS — phase 1 and phase 2 cannot overlap"; return 1
  fi
  local child="$REPO/.teach/$JOB/lesson.npz"
  [ -f "$child" ] || { echo "no lesson at $child — run phase 1 first"; return 1; }
  cd "$REPO"
  # deployment order (§7.6): base first, then the child READ-FIRST. Exit 4 anywhere is base_mismatch and means the
  # delta is not a delta — which is precisely what this phase exists to find out about real weights.
  python3 scripts/patch.py apply  "$PARENT_NPZ" --journal "$RUN/p.j.npz" --json | tee "$RUN/1-apply-parent.json"
  python3 scripts/patch.py apply  "$child" --journal "$RUN/c.j.npz" --verify-before --json | tee "$RUN/2-apply-child.json"
  python3 - "$RUN/2-apply-child.json" <<'PY' || bad "the child is not a delta over the base it names"
import json, sys
j = json.loads(open(sys.argv[1], encoding="utf-8").read().strip().splitlines()[-1])
assert j.get("error") != "base_mismatch", j
assert j.get("prev_equals_before") is True, f"prev != before in the LIVE table: {j}"
print("  live: the rows under the child WERE the parent's — prev_equals_before")
PY
  python3 scripts/patch.py check  "$child" --json | tee "$RUN/3-check-child.json"
  python3 scripts/patch.py remove "$child" --journal "$RUN/c.j.npz" --json | tee "$RUN/4-remove-child.json"
  python3 scripts/patch.py check  "$PARENT_NPZ" --json | tee "$RUN/5-check-parent.json"
  python3 - "$RUN/5-check-parent.json" <<'PY' || bad "removing the child did not leave the parent standing"
import json, sys
j = json.loads(open(sys.argv[1], encoding="utf-8").read().strip().splitlines()[-1])
assert j.get("differ_after") == 0, f"the parent is not intact after the child was removed: {j}"
print("  live: the parent is still standing — differ_after 0")
PY
  python3 scripts/patch.py remove "$PARENT_NPZ" --journal "$RUN/p.j.npz" --json | tee "$RUN/6-remove-parent.json"
  say "phase 2 done — $FAILED failure(s)."
  return $((FAILED > 0))
}

case "${1:-preflight}" in
  preflight) preflight; exit $((FAILED > 0));;
  trainer)   trainer_phase;;
  serve)     serve_phase;;
  *) echo "usage: $0 {preflight|trainer|serve}"; exit 2;;
esac
