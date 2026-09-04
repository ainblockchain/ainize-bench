#!/usr/bin/env node
// The four pictures the protocol asks for, drawn from a scored run and from nothing else.
//
//   node src/chart.mjs runs/<id> [--out <dir>] [--pricing pricing.json] [--knowledge-load-ms N]
//
// Writes runs/<id>/charts/*.svg (§8). No GPU, no key, no network, no library, no build step: every file is a
// standalone SVG a reviewer can open, and every number in one came out of `runs/<id>/results.json`, which is
// itself a pure function of the committed transcripts. Nothing is passed in by hand — the one quantity that
// is NOT in the transcripts (how long the knowledge takes to load, which arm C pays once) is looked for on
// disk first and, if it is not there, drawn as a declared ESTIMATE with its source stamped on the face of the
// chart. See `knowledgeLoad()`.
//
// The four charts:
//   cost-break-even.svg          §6: "plotted as cumulative cost vs. question count, two lines, crossing at
//                                N*. For a marketplace this is the single most persuasive chart available."
//   latency-decomposition.svg    per arm, the p50 and p95 item decomposed into the bands §6 separates:
//                                first response, tool round trips, later generation, and the residual.
//   latency-cumulative.svg       cumulative wall clock over N questions INCLUDING arm C's one-time knowledge
//                                load, with the crossover marked. The load is drawn at the SLOW end of its
//                                band, so this chart never flatters the arm it is about.
//   accuracy-by-bucket.svg       §1's table as a picture, with Wilson intervals, and with the tripwire
//                                bucket held apart because arm C is PREDICTED to fail it.
//   miss-channels.svg            §6's decomposition as a stacked bar that sums to the arm's miss count.
//
// RULES THIS FILE KEEPS
//
// 1. **No number is typed in.** Accuracy, cost, latency and the channel counts are recomputed from
//    results.json rows using the scorer's own helpers (`itemOutcome`, `isMiss`, `CHANNELS`, `wilson`) — never
//    a second implementation of a scoring rule. When summary.json is present the chart cross-checks itself
//    against it and stamps a MISMATCH on the chart if the two ever disagree, so a picture can never drift
//    away from the table it illustrates.
// 2. **§9 travels with the picture.** `SIMULATED PATCH — NOT A TRAINED MODEL`, `FIXTURE`, `OFFLINE RUN` and
//    `RUN VOID` are stamped into every chart, not just the summary header, because a chart is the thing that
//    gets pasted into a slide with its caption left behind.
// 3. **The load cost is plotted, not conceded.** Arm C's advantage in latency is only honest if the one-time
//    cost of getting the knowledge resident is on the same axes. It is, at the slow end of its band, with the
//    crossover marked and its provenance printed.
// 4. **Readable in both themes and with no CSS at all.** Every coloured element carries its light-mode hex as
//    a presentation attribute AND a class; the `<style>` block re-points the class through a CSS variable and
//    swaps the variables under `prefers-color-scheme: dark`. Strip the style block and the chart is still a
//    correct light-mode chart.
//
// Palette: the data-viz reference palette, validated rather than eyeballed — categorical slots 1-4 for the
// arms and 1-8 for the channels pass every gate on the adjacent pairlist in both modes (worst adjacent CVD
// ΔE 9.1 light / 8.4 dark against a target of 8; worst normal-vision ΔE 19.6 / 19.3 against a floor of 15),
// and the blue ordinal ramps used for the within-bar decompositions pass the ordinal gates in both modes.
// Three light-mode slots sit below 3:1 on the light surface, so the relief rule applies and is honoured: every
// value in every chart is also written out in the chart's own value table.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wilson } from './normalize.mjs';
import { BUCKETS, CHANNELS, ARM_ORDER, TOOL_ARMS, PREREG, itemOutcome, isMiss, provenanceStamps, loadPricing } from './score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CHART_VERSION = '1.0.0';
export const WIDTH = 980;

// ── palette ──────────────────────────────────────────────────────────────────────────────────────────────
// Flat role → hex, per mode. Every key becomes a CSS variable, a `.f-<key>` fill class and a `.s-<key>`
// stroke class, so a mark is written once and themed twice.

export const THEME = {
  light: {
    surface: '#fcfcfb', surface2: '#f3f2ee', ink: '#0b0b0b', ink2: '#52514e', muted: '#898781',
    grid: '#e1e0d9', axis: '#c3c2b7', alert: '#d03b3b', good: '#0ca30c',
    'arm-A': '#2a78d6', 'arm-B': '#eb6834', 'arm-C': '#1baf7a', 'arm-D': '#eda100',
    'ord-0': '#86b6ef', 'ord-1': '#3987e5', 'ord-2': '#184f95', resid: '#898781',
    'chan-0': '#2a78d6', 'chan-1': '#eb6834', 'chan-2': '#1baf7a', 'chan-3': '#eda100',
    'chan-4': '#e87ba4', 'chan-5': '#008300', 'chan-6': '#4a3aa7', 'chan-7': '#e34948',
    'fill-paper': '#ffffff', 'fill-ink': '#0b0b0b',
  },
  dark: {
    surface: '#1a1a19', surface2: '#232322', ink: '#ffffff', ink2: '#c3c2b7', muted: '#898781',
    grid: '#2c2c2a', axis: '#383835', alert: '#d03b3b', good: '#0ca30c',
    'arm-A': '#3987e5', 'arm-B': '#d95926', 'arm-C': '#199e70', 'arm-D': '#c98500',
    'ord-0': '#b7d3f6', 'ord-1': '#5598e7', 'ord-2': '#184f95', resid: '#898781',
    'chan-0': '#3987e5', 'chan-1': '#d95926', 'chan-2': '#199e70', 'chan-3': '#c98500',
    'chan-4': '#d55181', 'chan-5': '#008300', 'chan-6': '#9085e9', 'chan-7': '#e66767',
    'fill-paper': '#ffffff', 'fill-ink': '#0b0b0b',
  },
};
const armKey = (arm) => (THEME.light[`arm-${arm}`] ? `arm-${arm}` : 'muted');

const relLum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [relLum(a), relLum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
/**
 * A value written INSIDE a coloured segment is the one place text may leave the ink tokens, and it has to
 * clear contrast against the fill in BOTH themes — the fill changes between them, the label does not. So the
 * choice is made by measurement: whichever of ink/paper has the better WORST-CASE ratio across the two modes.
 */
export function onFill(role) {
  const worst = (t) => Math.min(ratio(THEME.light[t], THEME.light[role]), ratio(THEME.dark[t], THEME.dark[role]));
  return worst('fill-paper') >= worst('fill-ink') ? 'fill-paper' : 'fill-ink';
}

// ── formatting (exported so the self-test asserts against the SAME strings the chart draws) ──────────────

export const fmtUsd = (x) => (x == null ? '—' : x === 0 ? '$0' : Math.abs(x) < 0.01 ? `$${x.toFixed(6)}` : `$${x.toFixed(4)}`);
export const fmtUsdShort = (x) => (x == null ? '—' : x === 0 ? '$0' : Math.abs(x) >= 1 ? `$${x.toFixed(2)}` : Math.abs(x) >= 0.01 ? `$${x.toFixed(3)}` : `$${x.toFixed(5)}`);
export const fmtPct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
export const fmtInt = (x) => (x == null ? '—' : Math.round(x).toLocaleString('en-US'));
export const fmtMs = (ms) => (ms == null ? '—' : ms >= 10_000 ? `${(ms / 1000).toFixed(0)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
export const fmtNumber = (x, d = 2) => (x == null ? '—' : Number(x).toFixed(d));
export const fmtQ = (n) => (n == null ? '—' : n < 1 ? n.toFixed(2) : fmtInt(Math.ceil(n)));

// ── the SVG kit: no library, and small enough to read in one sitting ──────────────────────────────────────

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (x) => (Math.round(Number(x) * 100) / 100).toString();

function styleBlock() {
  const vars = (mode) => Object.entries(THEME[mode]).map(([k, v]) => `      --${k}: ${v};`).join('\n');
  const classes = Object.keys(THEME.light).map((k) => `    .f-${k}{fill:var(--${k})} .s-${k}{stroke:var(--${k})}`).join('\n');
  return `  <style>
    svg{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:light}
    svg{
${vars('light')}
    }
    @media (prefers-color-scheme: dark){
      svg{color-scheme:dark;
${vars('dark')}
      }
    }
${classes}
    text{font-size:12px}
    .t-title{font-size:18px;font-weight:600}
    .t-sub{font-size:12.5px}
    .t-small{font-size:11px}
    .t-tiny{font-size:10.5px}
    .t-num{font-variant-numeric:tabular-nums}
    .t-b{font-weight:600}
  </style>`;
}

export function text(x, y, s, { cls = 't-num', role = 'ink', anchor = 'start', size = null, weight = null, opacity = null } = {}) {
  const st = [size ? `font-size:${size}px` : '', weight ? `font-weight:${weight}` : '', opacity != null ? `opacity:${opacity}` : ''].filter(Boolean).join(';');
  return `<text x="${n(x)}" y="${n(y)}" text-anchor="${anchor}" fill="${THEME.light[role]}" class="f-${role} ${cls}"${st ? ` style="${st}"` : ''}>${esc(s)}</text>`;
}
export const rect = (x, y, w, h, role, extra = '') =>
  `<rect x="${n(x)}" y="${n(y)}" width="${n(Math.max(0, w))}" height="${n(Math.max(0, h))}" fill="${THEME.light[role]}" class="f-${role}"${extra ? ' ' + extra : ''}/>`;
export const line = (x1, y1, x2, y2, role = 'grid', w = 1, extra = '') =>
  `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${THEME.light[role]}" class="s-${role}" stroke-width="${w}"${extra ? ' ' + extra : ''}/>`;
export const path = (d, role, { fill = false, w = 2, extra = '' } = {}) => fill
  ? `<path d="${d}" fill="${THEME.light[role]}" class="f-${role}"${extra ? ' ' + extra : ''}/>`
  : `<path d="${d}" fill="none" stroke="${THEME.light[role]}" class="s-${role}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"${extra ? ' ' + extra : ''}/>`;
export const dot = (x, y, r, role) =>
  `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="${THEME.light[role]}" class="f-${role}" stroke="${THEME.light.surface}" stroke-width="2"/>`;

/** A column that grows up from a baseline: 4px rounded data-end, square at the baseline (marks spec). */
export function columnUp(x, w, yTop, yBase, role, { round = true, title = null } = {}) {
  const h = Math.max(0, yBase - yTop);
  if (h <= 0.2) return '';
  const r = round ? Math.min(4, w / 2, h) : 0;
  const d = `M${n(x)},${n(yBase)} L${n(x)},${n(yTop + r)} Q${n(x)},${n(yTop)} ${n(x + r)},${n(yTop)} L${n(x + w - r)},${n(yTop)} Q${n(x + w)},${n(yTop)} ${n(x + w)},${n(yTop + r)} L${n(x + w)},${n(yBase)} Z`;
  return `<g>${title ? `<title>${esc(title)}</title>` : ''}${path(d, role, { fill: true })}</g>`;
}
/** A bar that grows right from a baseline; same spec, rotated. */
export function barRight(y, h, xBase, xEnd, role, { round = true, title = null } = {}) {
  const w = Math.max(0, xEnd - xBase);
  if (w <= 0.2) return '';
  const r = round ? Math.min(4, h / 2, w) : 0;
  const d = `M${n(xBase)},${n(y)} L${n(xEnd - r)},${n(y)} Q${n(xEnd)},${n(y)} ${n(xEnd)},${n(y + r)} L${n(xEnd)},${n(y + h - r)} Q${n(xEnd)},${n(y + h)} ${n(xEnd - r)},${n(y + h)} L${n(xBase)},${n(y + h)} Z`;
  return `<g>${title ? `<title>${esc(title)}</title>` : ''}${path(d, role, { fill: true })}</g>`;
}

export const linScale = (d0, d1, r0, r1) => (v) => (d1 === d0 ? r0 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0));

/** Round tick steps: 1, 2, 2.5, 5, 10 × 10^k. */
export function niceTicks(min, max, count = 5) {
  if (!(max > min)) return [min, max];
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}
export const niceCeil = (x) => {
  if (!(x > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(x)));
  return ([1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10].find((m) => m * mag >= x) ?? 10) * mag;
};

/** Ticks for a duration axis, chosen in the unit the labels will be written in (never 16.7 min). */
export function durTicks(maxMs, count = 5) {
  const unit = maxMs >= 3.6e6 ? 3.6e6 : maxMs >= 6e4 ? 6e4 : maxMs >= 1000 ? 1000 : 1;
  const suffix = unit === 3.6e6 ? ' h' : unit === 6e4 ? ' min' : unit === 1000 ? ' s' : ' ms';
  return niceTicks(0, maxMs / unit, count).map((t) => ({ v: t * unit, label: `${Number(t.toFixed(2))}${suffix}` }));
}

/** Break a note into lines that fit `width` px at ~0.62 px per char per px of font size. */
export function wrap(s, width, size = 11) {
  const per = Math.max(10, Math.floor(width / (size * 0.62)));
  const out = [];
  let cur = '';
  for (const word of String(s).split(/\s+/)) {
    if (cur && (cur + ' ' + word).length > per) { out.push(cur); cur = word; } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) out.push(cur);
  return out;
}

// ── page furniture: title, the §9 stamps, footnotes, legend, value table ─────────────────────────────────

const HEAD_PAD = 26;

/** Title + subtitle + every stamp §9 requires on the FACE of the chart. Returns { svg, height }. */
export function header({ title, subtitle, stamps, width = WIDTH }) {
  const parts = [];
  let y = 38;
  parts.push(text(HEAD_PAD, y, title, { cls: 't-title', role: 'ink' }));
  y += 20;
  for (const l of wrap(subtitle, width - 2 * HEAD_PAD, 12.5)) { parts.push(text(HEAD_PAD, y, l, { cls: 't-sub', role: 'ink2' })); y += 16; }
  y += 4;
  for (const s of stamps ?? []) {
    const lines = wrap(s, width - 2 * HEAD_PAD - 34, 11.5);
    const h = 8 + lines.length * 15;
    parts.push(rect(HEAD_PAD, y - 11, width - 2 * HEAD_PAD, h, 'surface2'));
    parts.push(rect(HEAD_PAD, y - 11, 3, h, 'alert'));
    lines.forEach((l, i) => parts.push(text(HEAD_PAD + 10, y + 3 + i * 15, i === 0 ? `▲  ${l}` : `     ${l}`, { cls: 't-small t-b', role: 'alert' })));
    y += h + 6;
  }
  return { svg: parts.join('\n  '), height: y + 10 };
}

export function footer(lines, y, width = WIDTH) {
  const parts = [line(HEAD_PAD, y - 12, width - HEAD_PAD, y - 12, 'grid')];
  let yy = y + 2;
  for (const l of lines) for (const w of wrap(l, width - 2 * HEAD_PAD, 11)) { parts.push(text(HEAD_PAD, yy, w, { cls: 't-small', role: 'muted' })); yy += 14; }
  return { svg: parts.join('\n  '), height: yy - y + 10 };
}
export const footerHeight = (lines, width = WIDTH) => lines.reduce((a, l) => a + wrap(l, width - 2 * HEAD_PAD, 11).length * 14, 0) + 12;

/** A legend is always present for two or more series; the value rides in it, which is also the table view. */
export function legend(items, x, y, { columns = 1, colWidth = 300, rowHeight = 18 } = {}) {
  const parts = [];
  items.forEach((it, i) => {
    const cx = x + (i % columns) * colWidth;
    const cy = y + Math.floor(i / columns) * rowHeight;
    parts.push(rect(cx, cy - 8, 10, 10, it.role));
    parts.push(text(cx + 16, cy + 1, it.label, { cls: 't-small', role: 'ink2' }));
    if (it.value != null) parts.push(text(cx + colWidth - 14, cy + 1, it.value, { cls: 't-small t-num t-b', role: 'ink', anchor: 'end' }));
  });
  return { svg: parts.join('\n  '), height: Math.ceil(items.length / columns) * rowHeight };
}

/** The table view every chart carries, so no value is reachable only by looking at a colour. */
export function valueTable(headers, rows, x, y, colX, { width = WIDTH - 2 * HEAD_PAD, align = null } = {}) {
  const parts = [];
  const at = (i) => (align?.[i] ?? (i ? 'end' : 'start'));
  headers.forEach((h, i) => parts.push(text(x + colX[i], y, h, { cls: 't-tiny t-b', role: 'muted', anchor: at(i) })));
  parts.push(line(x, y + 6, x + width, y + 6, 'grid'));
  let yy = y + 21;
  for (const r of rows) {
    r.forEach((c, i) => parts.push(text(x + colX[i], yy, c, { cls: 't-small t-num', role: i === 0 ? 'ink2' : 'ink', anchor: at(i) })));
    yy += 17;
  }
  return { svg: parts.join('\n  '), height: yy - y };
}

export function doc({ width, height, title, desc, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(width)} ${n(height)}" width="${n(width)}" height="${n(height)}" role="img" aria-label="${esc(title)}">
  <title>${esc(title)}</title>
  <desc>${esc(desc)}</desc>
${styleBlock()}
  ${rect(0, 0, width, height, 'surface')}
  ${body}
</svg>
`;
}

// ── reading a scored run ─────────────────────────────────────────────────────────────────────────────────

/**
 * Arm C pays for its knowledge ONCE, and that cost is not in any transcript — the runner applies the patch
 * before the arm, not per item. A latency chart that leaves it out is the exact chart a sceptical judge is
 * looking for, so it is always drawn; the only question is where the number came from, and that is printed:
 *
 *   1. `--knowledge-load-ms N`                     declared on the command line
 *   2. runs/<id>/knowledge-load.json               a measurement written next to the run: {ms} or {ms_lo, ms_hi}
 *   3. provenance.json: knowledge_load_ms | patch.load_ms | patch.apply_ms
 *   4. otherwise                                   a DECLARED ESTIMATE, drawn as a band and stamped as one
 *
 * Nothing is silently defaulted: `measured` is false for 1 and 4, and the chart says which case it is in.
 */
export const KNOWLEDGE_LOAD_FALLBACK = {
  ms_lo: 2000, ms_hi: 3000,
  source: 'ESTIMATE — the 2–3 s the knowledge load was observed to take on this host while the runner was built; NOT measured in this run',
};

export function knowledgeLoad({ runDir, provenance, cliMs = null }) {
  if (cliMs != null && Number.isFinite(Number(cliMs))) {
    const ms = Number(cliMs);
    return { ms_lo: ms, ms_hi: ms, measured: false, source: `declared on the command line with --knowledge-load-ms ${ms}` };
  }
  const f = join(runDir, 'knowledge-load.json');
  if (existsSync(f)) {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    const lo = Number(j.ms_lo ?? j.ms), hi = Number(j.ms_hi ?? j.ms);
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      return { ms_lo: lo, ms_hi: hi, measured: true, source: `measured — ${f.split('/').slice(-2).join('/')}${j.source ? ` (${j.source})` : ''}` };
    }
  }
  const pv = Number(provenance?.knowledge_load_ms ?? provenance?.patch?.load_ms ?? provenance?.patch?.apply_ms);
  if (Number.isFinite(pv)) return { ms_lo: pv, ms_hi: pv, measured: true, source: 'measured — provenance.json' };
  return { ...KNOWLEDGE_LOAD_FALLBACK, measured: false };
}

export function loadRun(runDir, { pricingPath = null, knowledgeLoadMs = null } = {}) {
  const dir = resolve(runDir);
  const rf = join(dir, 'results.json');
  if (!existsSync(rf)) throw new Error(`${rf} does not exist — score the run first: node src/score.mjs ${runDir}`);
  const results = JSON.parse(readFileSync(rf, 'utf8'));
  const rows = results.rows ?? [];
  if (!rows.length) throw new Error(`${rf} carries no rows`);
  const sf = join(dir, 'summary.json');
  const summary = existsSync(sf) ? JSON.parse(readFileSync(sf, 'utf8')) : null;
  const pf = join(dir, 'provenance.json');
  const provenance = existsSync(pf) ? JSON.parse(readFileSync(pf, 'utf8')) : null;
  const { pricing, path: ppath } = loadPricing(pricingPath);

  const stamps = [...(summary?.stamps ?? provenanceStamps(provenance))];
  if (summary?.VOID && !stamps.some((s) => /VOID/.test(s))) stamps.unshift('RUN VOID — see the leakage tripwire in summary.md');

  const model = {
    runId: results.run ?? dir.split('/').filter(Boolean).pop(),
    runDir: dir, rows, summary, provenance, pricing, pricingPath: ppath,
    scoredAt: results.scored_at ?? null, scorerVersion: results.scorer_version ?? null,
    load: knowledgeLoad({ runDir: dir, provenance, cliMs: knowledgeLoadMs }),
    stamps,
  };
  model.arms = ARM_ORDER.filter((a) => rows.some((r) => r.arm === a));
  model.items = new Set(rows.map((r) => r.id)).size;
  model.accuracy = accuracyTable(rows);
  model.cost = costTable(rows);
  model.latency = latencyTable(rows);
  model.tokens = tokenTable(rows);
  model.cdf = latencyCdf(rows);
  model.channels = channelTable(rows);
  // A chart that disagrees with the table it illustrates is worse than no chart: check, and stamp it.
  for (const m of crossCheck(model)) model.stamps.push(m);
  if (!rows.some((r) => r.first_turn_ms != null || r.tool_ms != null)) {
    model.stamps.push('This results.json predates the per-turn timing fields — re-run `node src/score.mjs` for the full latency decomposition');
  }
  return model;
}

// ── series, all recomputed from results.json rows with the scorer's own helpers ───────────────────────────

const groupBy = (rows, key) => {
  const m = new Map();
  for (const r of rows) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
};
export const mean = (xs) => { const a = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)); return a.length ? a.reduce((p, q) => p + q, 0) / a.length : null; };

/**
 * §2's unstable set, recomputed the way summarize() computes it: an item whose two arm-A repeats produced
 * different normalised answers. `answer_key` is on every row for exactly this reason.
 */
export function unstableItems(rows) {
  const out = new Set();
  for (const [id, us] of groupBy(rows.filter((r) => r.arm === 'A'), (r) => r.id)) {
    if (us.length > 1 && new Set(us.map((u) => u.answer_key)).size > 1) out.add(id);
  }
  return out;
}

/** Item-level accuracy per arm × bucket, stable subset, with the Wilson interval §1 sizes its claim on. */
export function accuracyTable(rows) {
  const unstable = unstableItems(rows);
  const out = { unstable: unstable.size, byArm: {} };
  for (const [arm, armRows] of groupBy(rows, (r) => r.arm)) {
    const items = [...groupBy(armRows, (r) => r.id)].map(([id, us]) => ({ id, bucket: us[0].bucket, outcome: itemOutcome(us) }));
    const block = (list) => {
      const scored = list.filter((i) => i.outcome.scored);
      const hits = scored.filter((i) => i.outcome.hit).length;
      const [lo, hi] = wilson(hits, scored.length);
      return { n: scored.length, hits, accuracy: scored.length ? hits / scored.length : null, ci95: [lo, hi] };
    };
    const stable = items.filter((i) => !unstable.has(i.id));
    const b = {};
    for (const k of BUCKETS) b[k] = block(stable.filter((i) => i.bucket === k));
    out.byArm[arm] = {
      buckets: b,
      headline_E1_E2: block(stable.filter((i) => i.bucket === 'headline' || i.bucket === 'korean')),
      overall: block(stable),
    };
  }
  return out;
}

/** Cost per question per arm — the mean over the units the price file could price, exactly as §6 defines it. */
export function costTable(rows) {
  const out = { byArm: {}, unpriced: rows.filter((r) => r.cost_usd == null).length };
  for (const [arm, armRows] of groupBy(rows, (r) => r.arm)) {
    const priced = armRows.filter((r) => r.cost_usd != null);
    out.byArm[arm] = {
      units: armRows.length, priced: priced.length,
      per_question: priced.length ? priced.reduce((a, r) => a + r.cost_usd, 0) / priced.length : null,
      reason: armRows.find((r) => r.cost_usd == null)?.cost_reason ?? null,
      gateway_queries: armRows.reduce((a, r) => a + (r.gateway_queries ?? 0), 0),
    };
  }
  return out;
}

/**
 * The four bands of an item's wall clock. They are taken from ONE item — the item at the requested quantile
 * of total latency — rather than from four independent quantiles, because four independent quantiles do not
 * add up to anything and a stacked bar claims they do. `clamped` records where the residual went negative
 * (tool time and model time overlapping in the recorded timings) so the chart can disclose it.
 */
export function decompose(row) {
  const total = Number(row?.latency_ms ?? 0);
  const model = Number(row?.model_ms ?? 0);
  const first = row?.first_turn_ms == null ? Math.min(model, total) : Math.min(Number(row.first_turn_ms), model);
  const tool = Number(row?.tool_ms ?? 0);
  const gen = Math.max(0, model - first);
  const rest = total - model - tool;
  return { total, first, tool, gen, other: Math.max(0, rest), clamped: rest < -1, id: row?.id ?? null };
}

export function quantileRow(armRows, q) {
  const a = armRows.filter((r) => Number.isFinite(r.latency_ms)).sort((x, y) => x.latency_ms - y.latency_ms);
  if (!a.length) return null;
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1)); // nearest-rank
  return a[i];
}

export function tokenTable(rows) {
  const out = { byArm: {} };
  for (const [arm, armRows] of groupBy(rows, (r) => r.arm)) {
    out.byArm[arm] = {
      units: armRows.length,
      prompt_per_question: mean(armRows.map((r) => r.prompt_tokens)),
      completion_per_question: mean(armRows.map((r) => r.completion_tokens)),
      turns_per_question: mean(armRows.map((r) => r.turns)),
      peak_prompt: armRows.reduce((a, r) => Math.max(a, r.prompt_tokens_peak ?? 0), 0),
      tool_bytes_in: armRows.reduce((a, r) => a + (r.tool_bytes_in ?? 0), 0),
    };
  }
  return out;
}

/** The empirical CDF of one arm's end-to-end latency: every unit is a step, nothing is smoothed or binned. */
export function latencyCdf(rows) {
  const out = {};
  for (const [arm, armRows] of groupBy(rows, (r) => r.arm)) {
    const xs = armRows.map((r) => r.latency_ms).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    out[arm] = { xs, n: xs.length, at: (q) => (xs.length ? xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(q * xs.length) - 1))] : null) };
  }
  return out;
}

export function latencyTable(rows) {
  const out = { byArm: {} };
  for (const [arm, armRows] of groupBy(rows, (r) => r.arm)) {
    out.byArm[arm] = {
      units: armRows.length,
      mean_ms: mean(armRows.map((r) => r.latency_ms)),
      mean_model_ms: mean(armRows.map((r) => r.model_ms)),
      p50: decompose(quantileRow(armRows, 0.5)),
      p95: decompose(quantileRow(armRows, 0.95)),
    };
  }
  return out;
}

/** §6's decomposition, recounted from the rows: it must sum to the arm's miss count or the chart says so. */
export function channelTable(rows) {
  const out = {};
  for (const [arm, armRows] of groupBy(rows, (r) => r.arm)) {
    if (!TOOL_ARMS.has(arm)) continue;
    const misses = armRows.filter((r) => r.scored && isMiss(r.verdict));
    const counts = Object.fromEntries(CHANNELS.map((c) => [c, misses.filter((r) => r.miss_channel === c).length]));
    const assigned = Object.values(counts).reduce((a, b) => a + b, 0);
    out[arm] = { misses: misses.length, assigned, sums: assigned === misses.length, counts, units: armRows.length };
  }
  return out;
}

/** N where a one-time `fixed` cost plus N × `perCheap` overtakes N × `perDear`. Null when it never does. */
export function crossover(fixed, perDear, perCheap) {
  if (![fixed, perDear, perCheap].every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  const delta = perDear - perCheap;
  if (delta <= 0) return null;
  return fixed / delta;
}

/** The picture and the table are the same numbers or the chart says which cell disagreed. */
export function crossCheck(model) {
  const s = model.summary;
  if (!s) return [];
  const bad = [];
  for (const arm of model.arms) {
    const mine = model.accuracy.byArm[arm]?.headline_E1_E2?.accuracy;
    const theirs = s.arms?.[arm]?.headline_E1_E2?.stable_subset?.accuracy;
    if (mine != null && theirs != null && Math.abs(mine - theirs) > 1e-9) bad.push(`arm ${arm} headline accuracy`);
    const mc = model.cost.byArm[arm]?.per_question, tc = s.arms?.[arm]?.cost?.per_question_usd;
    if (mc != null && tc != null && Math.abs(mc - tc) > 1e-12) bad.push(`arm ${arm} cost per question`);
  }
  return bad.length ? [`CHART/SUMMARY MISMATCH on ${bad.join(', ')} — do not quote either until this is resolved`] : [];
}

export const fmtDur = (ms) => {
  if (ms == null) return '—';
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)} h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 1000).toFixed(1)} s`;
};

// ── 1. cumulative cost vs question count, crossing at N* ─────────────────────────────────────────────────

/**
 * §6: "Plotted as cumulative cost vs. question count, two lines, crossing at N*. For a marketplace this is
 * the single most persuasive chart available, and it falls straight out of numbers already collected."
 *
 * Arm B pays per question forever; arm C pays once and then pays only for its own tokens. The crossing is
 * where buying beats querying. Every term is read: the per-question costs from results.json (which the
 * scorer computed as tokens × the list prices in pricing.json), the one-time price from pricing.json itself.
 * When that price is null — which is how the file stands today — the chart draws the two MARGINAL lines and
 * refuses to mark a crossing, because the honest answer to "where do they cross?" is "set the price first".
 */
export function chartCostBreakEven(model) {
  const K = model.pricing?.knowledge?.price ?? null;
  const CUR = model.pricing?.knowledge?.currency ?? 'USD';
  const cB = model.cost.byArm.B?.per_question ?? null;
  const cC = model.cost.byArm.C?.per_question ?? null;
  const nstar = typeof K === 'number' ? crossover(K, cB, cC) : null;
  const delta = cB != null && cC != null ? cB - cC : null;

  const xMax = niceCeil(nstar ? nstar * 2 : Math.max(model.items, 100));
  const yMaxRaw = Math.max((cB ?? 0) * xMax, (K ?? 0) + (cC ?? 0) * xMax);
  const yMax = niceCeil(yMaxRaw || 1);

  const head = header({
    title: 'Break-even: buying the knowledge once vs. querying every time',
    subtitle: `Cumulative modelled cost over N questions. Arm B = base model + The Graph Subgraph MCP (tokens + one gateway query per executed query). Arm C = the Ainize knowledge patch, no tools, no network. Per-question costs are measured (${model.items} items, ${model.rows.length} scored units); every price is read from ${model.pricingPath.replace(/^.*\/bench\//, '')} — change a price there, re-score, and this chart moves.`,
    stamps: model.stamps,
  });

  const L = 92, R = WIDTH - 210, top = head.height + 16, H = 292, base = top + H;
  const x = linScale(0, xMax, L, R), y = linScale(0, yMax, base, top);
  const p = [];

  for (const t of niceTicks(0, yMax, 5)) {
    p.push(line(L, y(t), R, y(t), 'grid'));
    p.push(text(L - 10, y(t) + 4, fmtUsdShort(t), { cls: 't-tiny', role: 'muted', anchor: 'end' }));
  }
  p.push(line(L, base, R, base, 'axis'));
  for (const t of niceTicks(0, xMax, 6)) p.push(text(x(t), base + 18, fmtInt(t), { cls: 't-tiny', role: 'muted', anchor: 'middle' }));
  p.push(text((L + R) / 2, base + 40, 'questions asked (N)', { cls: 't-small', role: 'ink2', anchor: 'middle' }));
  p.push(text(L - 10, top - 14, `cumulative cost (${CUR})`, { cls: 't-small', role: 'ink2', anchor: 'start' }));

  const notes = [];
  if (cB != null) {
    p.push(path(`M${n(x(0))},${n(y(0))} L${n(x(xMax))},${n(y(cB * xMax))}`, 'arm-B'));
    p.push(text(R + 12, y(cB * xMax) + 4, `arm B  ${fmtUsdShort(cB * xMax)}`, { cls: 't-small t-b', role: 'ink' }));
    p.push(text(R + 12, y(cB * xMax) + 19, `${fmtUsd(cB)} / question`, { cls: 't-tiny', role: 'muted' }));
  }
  if (cC != null) {
    const c0 = K ?? 0;
    p.push(path(`M${n(x(0))},${n(y(c0))} L${n(x(xMax))},${n(y(c0 + cC * xMax))}`, 'arm-C'));
    p.push(text(R + 12, y(c0 + cC * xMax) + 4, `arm C  ${fmtUsdShort(c0 + cC * xMax)}`, { cls: 't-small t-b', role: 'ink' }));
    p.push(text(R + 12, y(c0 + cC * xMax) + 19, `${fmtUsd(cC)} / question`, { cls: 't-tiny', role: 'muted' }));
    if (typeof K === 'number' && K > 0) {
      p.push(line(L - 6, y(K), L + 6, y(K), 'arm-C', 2));
      p.push(text(L + 12, y(K) - 8, `one-time knowledge price ${fmtUsdShort(K)}`, { cls: 't-tiny t-b', role: 'ink2' }));
    }
  }
  if (nstar != null && nstar <= xMax) {
    const yx = y(nstar * cB);
    p.push(line(x(nstar), base, x(nstar), yx, 'ink2', 1));
    p.push(dot(x(nstar), yx, 5, 'ink'));
    const lx = Math.min(x(nstar) + 14, R - 300);
    p.push(text(lx, yx - 34, `N* = ${fmtQ(nstar)} questions`, { cls: 't-small t-b', role: 'ink' }));
    p.push(text(lx, yx - 20, 'after this many questions, buying is cheaper than querying', { cls: 't-tiny', role: 'muted' }));
  } else {
    const why = typeof K !== 'number' ? `${model.pricingPath.replace(/^.*\/bench\//, '')} carries no knowledge.price, so N* is NOT computed and no crossing is drawn — arm C's line is its MARGINAL cost only`
      : delta != null && delta <= 0 ? 'arm B is not more expensive per question than arm C, so there is no break-even to draw'
      : 'arms B and C must both be scored and priced before a crossing exists';
    p.push(rect(L + 14, top + 14, 420, 54, 'surface2'));
    p.push(rect(L + 14, top + 14, 3, 54, 'alert'));
    p.push(text(L + 26, top + 34, 'no crossing is marked', { cls: 't-small t-b', role: 'alert' }));
    wrap(why, 390, 11).forEach((l, i) => p.push(text(L + 26, top + 50 + i * 13, l, { cls: 't-tiny', role: 'ink2' })));
  }

  const lg = legend([
    { role: 'arm-B', label: 'arm B — base + Subgraph MCP (pays per question)', value: cB == null ? 'unpriced' : `${fmtUsd(cB)}/q` },
    { role: 'arm-C', label: 'arm C — Ainize knowledge, no tools, no network', value: cC == null ? 'unpriced' : `${fmtUsd(cC)}/q` },
  ], HEAD_PAD, base + 66, { columns: 2, colWidth: 440 });

  const tblY = base + 66 + lg.height + 26;
  const tbl = valueTable(['term', 'value', 'where it came from'],
    [
      ['cost per question, arm B', fmtUsd(cB), 'measured tokens × list price + gateway queries'],
      ['cost per question, arm C', fmtUsd(cC), 'measured tokens × list price, zero gateway queries'],
      ['difference (B − C)', delta == null ? '—' : fmtUsd(delta), 'per question'],
      ['knowledge price (one-time)', typeof K === 'number' ? `${K} ${CUR}` : 'not set', `${model.pricingPath.replace(/^.*\/bench\//, '')} → knowledge.price`],
      ['N* = price ÷ difference', nstar == null ? 'not computed' : `${fmtQ(nstar)} questions`, nstar == null ? 'left uncomputed rather than invented' : 'the crossing marked above'],
    ], HEAD_PAD, tblY, [0, 470, 500], { align: ['start', 'end', 'start'] });

  const foot = [
    'N* = knowledge_price / (cost_per_question_B − cost_per_question_C). Modelled costs, not invoices (§7.4): every price is a published list price recorded with its source URL in pricing.json, and nothing here was billed to us.',
    `Gateway queries counted: arm B ${fmtInt(model.cost.byArm.B?.gateway_queries ?? 0)}, arm C ${fmtInt(model.cost.byArm.C?.gateway_queries ?? 0)} — arm C makes no network call of any kind by construction, which is why its line has no per-query term at all.`,
  ];
  const fY = tblY + tbl.height + 22;
  const f = footer(foot, fY);
  return doc({
    width: WIDTH, height: fY + f.height,
    title: `Break-even — run ${model.runId}`,
    desc: `Cumulative cost over N questions for arm B and arm C. B ${fmtUsd(cB)} per question, C ${fmtUsd(cC)} per question, knowledge price ${typeof K === 'number' ? K : 'not set'}, N* ${nstar == null ? 'not computed' : fmtQ(nstar)}.`,
    body: [head.svg, ...p, lg.svg, tbl.svg, f.svg].join('\n  '),
  });
}

// ── 2. what an item's wall clock is made of, per arm, at p50 and p95 ─────────────────────────────────────

const BANDS = [
  { key: 'first', role: 'ord-0', label: 'first response (prefill + first generation)' },
  { key: 'tool', role: 'ord-1', label: 'tool round trips (MCP + gateway)' },
  { key: 'gen', role: 'ord-2', label: 'generation after the first turn' },
  { key: 'other', role: 'resid', label: 'residual (scheduling, JSON, loop overhead)' },
];

/**
 * §6 asks for latency "including every tool round trip" beside `model_ms` "so model time and network time are
 * separable and nobody can claim the gap is just The Graph's servers being far away". This is that, per arm.
 *
 * Two honesty notes are printed on the chart rather than left for a reader to discover:
 *  - There is no time-to-first-token in this study. The runner does not stream (`src/vllm.mjs` reads the whole
 *    response), so the earliest recorded instant is the end of the first turn. The first band is labelled for
 *    what it is, and calling it TTFT would have been a number we never measured.
 *  - The bars are ONE item each — the item at the p50 and at the p95 of total latency — not four independent
 *    quantiles stacked. Independent quantiles do not sum, and a stacked bar asserts that they do.
 */
export function chartLatencyDecomposition(model) {
  const arms = model.arms;
  const head = header({
    title: 'Where an item’s wall clock goes, per arm',
    subtitle: 'Each bar is a single item — the one at that arm’s p50 (and p95) of end-to-end latency — decomposed into the bands the transcript records. The bands sum to that item’s measured total, because they are all from the same item. The tool arms buy their answers with network round trips; the knowledge arms have none to buy.',
    stamps: model.stamps,
  });

  const cells = [];
  for (const a of arms) for (const q of ['p50', 'p95']) cells.push({ arm: a, q, d: model.latency.byArm[a]?.[q] ?? null });
  const yMax = niceCeil(Math.max(1, ...cells.map((c) => c.d?.total ?? 0)));

  const L = 92, R = WIDTH - 40, top = head.height + 22, H = 300, base = top + H;
  const y = linScale(0, yMax, base, top);
  const p = [];
  for (const tk of durTicks(yMax)) {
    p.push(line(L, y(tk.v), R, y(tk.v), 'grid'));
    p.push(text(L - 10, y(tk.v) + 4, tk.label, { cls: 't-tiny', role: 'muted', anchor: 'end' }));
  }
  p.push(line(L, base, R, base, 'axis'));
  p.push(text(L - 10, top - 14, 'wall clock for one item', { cls: 't-small', role: 'ink2', anchor: 'start' }));

  const groups = arms.length;
  const gw = (R - L) / groups;
  const bw = Math.min(24, (gw - 40) / 2);
  arms.forEach((arm, gi) => {
    const gx = L + gi * gw;
    p.push(text(gx + gw / 2, base + 38, `arm ${arm}`, { cls: 't-small t-b', role: 'ink', anchor: 'middle' }));
    ['p50', 'p95'].forEach((q, bi) => {
      const d = model.latency.byArm[arm]?.[q];
      const bx = gx + gw / 2 - bw - 6 + bi * (bw + 12);
      p.push(text(bx + bw / 2, base + 18, q, { cls: 't-tiny', role: 'muted', anchor: 'middle' }));
      if (!d || !(d.total > 0)) { p.push(text(bx + bw / 2, base - 6, '—', { cls: 't-tiny', role: 'muted', anchor: 'middle' })); return; }
      let acc = 0;
      BANDS.forEach((band, i) => {
        const v = d[band.key] ?? 0;
        if (v <= 0) { acc += v; return; }
        const yTop = y(acc + v), yBot = y(acc);
        const gap = i === 0 ? 0 : 2;                       // the 2px surface gap that separates the fills
        p.push(columnUp(bx, bw, yTop, yBot - gap, band.role, { round: i === BANDS.length - 1 || acc + v >= d.total - 0.5, title: `arm ${arm} ${q} — ${band.label}: ${fmtMs(v)}` }));
        acc += v;
      });
      p.push(text(bx + bw / 2, y(d.total) - 8, fmtMs(d.total), { cls: 't-small t-b t-num', role: 'ink', anchor: 'middle' }));
    });
  });

  const lg = legend(BANDS.map((b) => ({ role: b.role, label: b.label })), HEAD_PAD, base + 58, { columns: 2, colWidth: 440 });
  const tblY = base + 58 + lg.height + 26;
  const rowsT = [];
  for (const a of arms) for (const q of ['p50', 'p95']) {
    const d = model.latency.byArm[a]?.[q];
    rowsT.push([`arm ${a} · ${q} item`, ...(d ? [fmtMs(d.first), fmtMs(d.tool), fmtMs(d.gen), fmtMs(d.other), fmtMs(d.total)] : ['—', '—', '—', '—', '—'])]);
  }
  for (const a of arms) rowsT.push([`arm ${a} · mean of all ${model.latency.byArm[a].units} units`, '', '', '', '', fmtMs(model.latency.byArm[a].mean_ms)]);
  const tbl = valueTable(['unit', 'first response', 'tool round trips', 'later generation', 'residual', 'total'],
    rowsT, HEAD_PAD, tblY, [0, 470, 590, 720, 830, 928]);

  const clamped = cells.filter((c) => c.d?.clamped).length;
  const foot = [
    'No time-to-first-token exists in this study: the runner reads whole responses rather than streaming (src/vllm.mjs), so the earliest instant any transcript records is the END of the first model turn. The first band is that turn — prefill plus its own generation — and is labelled as such rather than as TTFT.',
    'Latency is host-dependent and tokens are not (§7.2), which is why the token table in summary.md sits next to this one. What does not depend on the host is the shape: the tool arms carry a band the knowledge arms do not have at all.',
    clamped ? `${clamped} of the ${cells.length} bars had a negative residual (recorded tool time overlapping recorded model time); the residual is clamped at zero there and the total shown is the transcript's own latency_ms.` : null,
  ].filter(Boolean);
  const fY = tblY + tbl.height + 22;
  const f = footer(foot, fY);
  return doc({
    width: WIDTH, height: fY + f.height,
    title: `Latency decomposition — run ${model.runId}`,
    desc: arms.map((a) => `arm ${a} p50 ${fmtMs(model.latency.byArm[a]?.p50?.total)} p95 ${fmtMs(model.latency.byArm[a]?.p95?.total)}`).join('; '),
    body: [head.svg, ...p, lg.svg, tbl.svg, f.svg].join('\n  '),
  });
}

// ── 3. cumulative latency over N questions, INCLUDING arm C's one-time knowledge load ────────────────────

/**
 * The chart a sceptical judge goes looking for. Arm C's per-question latency is small because the knowledge
 * is already resident — so the cost of MAKING it resident has to be on the same axes, or the comparison is
 * rigged. It is: arms C and D start at the load, not at zero, the load is drawn at the SLOW end of its band,
 * and the crossover with arm B is marked and named. If the load were never repaid, this chart would show it.
 */
export function chartLatencyCumulative(model) {
  const arms = model.arms;
  const load = model.load;
  const patched = new Set(['C', 'D']);            // the arms that need the table put into a state first (§4)
  const per = Object.fromEntries(arms.map((a) => [a, model.latency.byArm[a]?.mean_ms ?? null]));
  const off = (a) => (patched.has(a) ? load.ms_hi : 0);
  const xMax = Math.max(25, model.items);
  const yMax = niceCeil(Math.max(1, ...arms.map((a) => (per[a] ?? 0) * xMax + off(a))));

  const cross = crossover(load.ms_hi, per.B, per.C);
  const crossLo = crossover(load.ms_lo, per.B, per.C);

  const head = header({
    title: 'Cumulative wall clock over N questions — with arm C’s one-time knowledge load included',
    subtitle: `Every arm's line is N × its measured mean latency. Arms C and D do not start at zero: they start at the cost of getting the knowledge resident, drawn at the SLOW end of its band (${fmtMs(load.ms_hi)}) so this chart never flatters them. ${load.measured ? 'That load time is measured.' : 'That load time is NOT measured in this run — see the stamp and the note below.'}`,
    stamps: [...model.stamps, ...(load.measured ? [] : [`KNOWLEDGE LOAD TIME IS AN ESTIMATE, NOT A MEASUREMENT — ${load.source}`])],
  });

  const L = 92, R = WIDTH - 190, top = head.height + 16, H = 300, base = top + H;
  const x = linScale(0, xMax, L, R), y = linScale(0, yMax, base, top);
  const p = [];
  for (const tk of durTicks(yMax)) {
    p.push(line(L, y(tk.v), R, y(tk.v), 'grid'));
    p.push(text(L - 10, y(tk.v) + 4, tk.label, { cls: 't-tiny', role: 'muted', anchor: 'end' }));
  }
  p.push(line(L, base, R, base, 'axis'));
  for (const t of niceTicks(0, xMax, 6)) p.push(text(x(t), base + 18, fmtInt(t), { cls: 't-tiny', role: 'muted', anchor: 'middle' }));
  p.push(text((L + R) / 2, base + 40, 'questions answered (N)', { cls: 't-small', role: 'ink2', anchor: 'middle' }));
  p.push(text(L - 10, top - 14, 'cumulative wall clock — arms C and D start at the one-time knowledge load, not at zero', { cls: 't-small', role: 'ink2', anchor: 'start' }));

  // the load, drawn where it is paid: at N = 0, on the arms that pay it
  if (load.ms_hi > 0 && arms.some((a) => patched.has(a))) {
    p.push(`<g><title>${esc(`one-time knowledge load: ${fmtMs(load.ms_lo)}–${fmtMs(load.ms_hi)} (${load.source})`)}</title>${rect(L, y(load.ms_hi), Math.max(6, x(xMax * 0.02) - L), Math.max(2, y(load.ms_lo) - y(load.ms_hi)), 'arm-C', 'fill-opacity="0.35"')}</g>`);
    p.push(line(L, y(load.ms_hi), R, y(load.ms_hi), 'arm-C', 1, 'stroke-opacity="0.35"'));
  }

  // Lines first, then their end labels: two arms with the same latency land on the same pixel, and stacked
  // end labels that no longer touch their line read as noise (marks-and-anatomy). They are pushed apart to a
  // minimum spacing and reconnected with a leader line, which is the documented fix.
  const ends = [];
  for (const a of arms) {
    if (per[a] == null) continue;
    const y0 = off(a), y1 = off(a) + per[a] * xMax;
    p.push(path(`M${n(x(0))},${n(y(y0))} L${n(x(xMax))},${n(y(y1))}`, armKey(a)));
    ends.push({ arm: a, yTrue: y(y1), label: `arm ${a}`, sub: `${fmtDur(y1)} for ${fmtInt(xMax)}` });
  }
  ends.sort((u, v) => u.yTrue - v.yTrue);
  let prev = -Infinity;
  for (const e of ends) {
    e.y = Math.max(e.yTrue, prev + 34);
    prev = e.y;
  }
  for (const e of ends) {
    if (Math.abs(e.y - e.yTrue) > 1) p.push(path(`M${n(R)},${n(e.yTrue)} L${n(R + 6)},${n(e.yTrue)} L${n(R + 10)},${n(e.y - 4)}`, 'muted', { w: 1 }));
    p.push(text(R + 14, e.y, e.label, { cls: 't-small t-b', role: 'ink' }));
    p.push(text(R + 14, e.y + 15, e.sub, { cls: 't-tiny', role: 'muted' }));
  }

  const zoom = cross != null && cross <= xMax * 0.25;
  if (cross != null) {
    const cy = y(per.B * cross);
    if (!zoom) p.push(line(x(cross), base, x(cross), cy, 'ink2', 1));
    p.push(dot(x(cross), cy, 5, 'ink'));
    const lab = cross < 1 ? `arm C overtakes arm B before the FIRST question finishes (N = ${fmtQ(cross)})` : `arm C overtakes arm B at N = ${fmtQ(cross)} questions`;
    const repaid = `the load is repaid after ${fmtQ(cross)} question(s) at the slow end of the band${crossLo != null && crossLo !== cross ? `, ${fmtQ(crossLo)} at the fast end` : ''}`;
    if (zoom) {
      // The crossing is too close to the origin to read at this scale, and "too small to see" is exactly the
      // objection this chart exists to answer — so the first few questions get their own panel, where the
      // load is a visible step and the crossing is a visible point.
      const ix = L + 34, iy = top + 12, iw = 320, ih = 128;
      const zx = Math.max(1, Math.ceil(cross * 4));
      // The panel's y-scale is set by the LOAD, not by arm B: the whole point is to make the step visible, and
      // arm B's line simply leaves the top of the panel — which is the finding, not a clipping accident.
      const zyMax = Math.max(load.ms_hi * 3, load.ms_hi + per.C * zx) * 1.05;
      const zX = linScale(0, zx, ix + 14, ix + iw - 46), zY = linScale(0, zyMax, iy + ih - 26, iy + 30);
      const bClipX = Math.min(zx, zyMax / per.B);
      p.push(rect(ix, iy, iw, ih, 'surface2'));
      p.push(text(ix + 10, iy + 15, `zoom — the first ${fmtInt(zx)} question${zx > 1 ? 's' : ''}, where the one-time knowledge load is repaid`, { cls: 't-tiny t-b', role: 'ink2' }));
      p.push(line(ix + 14, zY(0), ix + iw - 14, zY(0), 'axis'));
      p.push(rect(ix + 14, zY(load.ms_hi), 8, Math.max(3, zY(load.ms_lo) - zY(load.ms_hi)), 'arm-C', 'fill-opacity="0.6"'));
      p.push(path(`M${n(zX(0))},${n(zY(0))} L${n(zX(bClipX))},${n(zY(per.B * bClipX))}`, 'arm-B'));
      p.push(path(`M${n(zX(0))},${n(zY(load.ms_hi))} L${n(zX(zx))},${n(zY(load.ms_hi + per.C * zx))}`, 'arm-C'));
      p.push(dot(zX(cross), zY(per.B * cross), 4, 'ink'));
      p.push(text(zX(bClipX) + 4, zY(per.B * bClipX) + 10, 'arm B', { cls: 't-tiny t-b', role: 'ink2' }));
      p.push(text(zX(zx) + 4, zY(load.ms_hi + per.C * zx) + 4, 'arm C', { cls: 't-tiny t-b', role: 'ink2' }));
      p.push(text(ix + 26, zY(load.ms_hi) - 5, `load ${fmtMs(load.ms_hi)}`, { cls: 't-tiny', role: 'ink2' }));
      p.push(text(ix + iw - 14, zY(0) + 12, `N = ${fmtInt(zx)}`, { cls: 't-tiny', role: 'muted', anchor: 'end' }));
      p.push(text(ix, iy + ih + 16, lab, { cls: 't-small t-b', role: 'ink' }));
      p.push(text(ix, iy + ih + 31, repaid, { cls: 't-tiny', role: 'muted' }));
    } else {
      const ly = Math.max(top + 28, cy - 52), lx = Math.min(x(cross) + 14, R - 340);
      p.push(path(`M${n(x(cross))},${n(cy - 8)} L${n(x(cross))},${n(ly + 6)} L${n(lx - 6)},${n(ly + 6)}`, 'muted', { w: 1 }));
      p.push(text(lx, ly, lab, { cls: 't-small t-b', role: 'ink' }));
      p.push(text(lx, ly + 15, repaid, { cls: 't-tiny', role: 'muted' }));
    }
  } else if (per.B != null && per.C != null) {
    p.push(text(L + 14, top + 24, 'arm C is not faster per question than arm B in this run — the load is never repaid, and that is the finding', { cls: 't-small t-b', role: 'alert' }));
  }

  const lg = legend(arms.map((a) => ({
    role: armKey(a), label: `arm ${a}${patched.has(a) ? ' — pays the one-time load' : ''}`, value: per[a] == null ? '—' : `${fmtMs(per[a])}/q`,
  })), HEAD_PAD, base + 66, { columns: 2, colWidth: 440 });

  const tblY = base + 66 + lg.height + 26;
  const tbl = valueTable(['arm', 'mean latency / question', 'one-time load', `cumulative at N = ${fmtInt(xMax)}`, 'units measured'],
    arms.map((a) => [`arm ${a}`, fmtMs(per[a]), patched.has(a) ? fmtMs(load.ms_hi) : '0 ms', fmtDur(per[a] == null ? null : off(a) + per[a] * xMax), fmtInt(model.latency.byArm[a].units)]),
    HEAD_PAD, tblY, [0, 470, 620, 780, 928]);

  const f = footer([
    `Where the load number comes from: ${load.source}. It is looked for in this order — --knowledge-load-ms, runs/<id>/knowledge-load.json, provenance.json — and only drawn as an estimate when none of those carries it. The estimate is a band, and the line is drawn at its slow end.`,
    'The load is paid once per session, not per question, because the patch is applied to the serving table and asserted resident between chunks (§4). Arm B pays its network round trips on every single question, which is why the lines diverge rather than shift.',
    'Mean latency, not median, is the right per-question figure here: the quantity being drawn is total elapsed time over N questions, and that is N × the mean by definition. The p50/p95 shape is in the decomposition chart beside this one.',
  ], tblY + tbl.height + 22);
  return doc({
    width: WIDTH, height: tblY + tbl.height + 22 + f.height,
    title: `Cumulative latency with the knowledge load — run ${model.runId}`,
    desc: `Mean latency per question: ${arms.map((a) => `${a} ${fmtMs(per[a])}`).join(', ')}. One-time knowledge load ${fmtMs(load.ms_lo)}–${fmtMs(load.ms_hi)} (${load.measured ? 'measured' : 'estimated'}). Crossover ${cross == null ? 'none' : fmtQ(cross)} questions.`,
    body: [head.svg, ...p, lg.svg, tbl.svg, f.svg].join('\n  '),
  });
}

// ── 4. accuracy by arm × bucket, with the tripwire held apart ────────────────────────────────────────────

const MAIN_BUCKETS = ['headline', 'korean', 'ceiling', 'multihop'];
const SHORT = { headline: 'E1 — held-out phrasing\n(headline)', korean: 'E2 — Korean', ceiling: 'P — trained phrasing\n(ceiling)', multihop: 'multi-hop (2 facts)', tripwire: 'held-out facts' };

/**
 * §1's table as a picture. Two things are deliberate:
 *
 *  - **The tripwire bucket is drawn in its own panel, off to the side.** It is not a fifth bar group among
 *    equals: arm C is PRE-REGISTERED to fail it, and arm B is pre-registered to win it. Putting it inline
 *    invites a reader to average it into the headline, which is the one thing §1 forbids ("reported at full
 *    weight beside the headline, never folded into it and never quietly dropped"). Separated and captioned,
 *    it reads as what it is: the experiment's own tripwire, printed at full size.
 *  - **Every bar carries its Wilson 95% interval**, because §1 sizes the whole design on n = 120 items and
 *    says no difference is called a difference without its interval.
 */
export function chartAccuracy(model) {
  const arms = model.arms;
  const head = header({
    title: 'Accuracy by arm and bucket, with 95% intervals',
    subtitle: `Unit: the item (an item counts as a hit only if every non-error repeat was a hit), stable subset — ${model.accuracy.unstable} of ${model.items} items are excluded as unstable because arm A's two repeats disagreed (§2). Bars are Wilson 95% intervals at the item level. The three phrasing buckets on the left ask about the SAME facts, so E1 → E2 → P is a comparison of PHRASING, not of three fact sets.`,
    stamps: model.stamps,
  });

  const L = 92, R = WIDTH - 40, top = head.height + 52, H = 286, base = top + H;
  const y = linScale(0, 1, base, top);
  const p = [];
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    p.push(line(L, y(t), R, y(t), 'grid'));
    p.push(text(L - 10, y(t) + 4, `${Math.round(t * 100)}%`, { cls: 't-tiny', role: 'muted', anchor: 'end' }));
  }

  const gapW = 54;
  const gw = (R - L - gapW) / 5;
  const tripX = L + gw * 4 + gapW;
  // the tripwire panel: its own ground, its own caption, so it can never be read as a fifth ordinary bucket
  p.push(rect(tripX - 16, top - 56, gw + 32, H + 104, 'surface2', 'data-panel="tripwire"'));
  p.push(text(tripX - 16 + (gw + 32) / 2, top - 42, 'TRIPWIRE — held-out facts', { cls: 't-small t-b', role: 'ink', anchor: 'middle' }));
  p.push(text(tripX - 16 + (gw + 32) / 2, top - 28, 'reported at full weight, never folded in', { cls: 't-tiny', role: 'ink2', anchor: 'middle' }));
  p.push(line(L, base, R, base, 'axis'));

  const drawGroup = (bucket, gx) => {
    const bw = Math.min(22, (gw - 30) / arms.length - 2);
    const cands = [];
    arms.forEach((arm, i) => {
      const b = model.accuracy.byArm[arm]?.buckets?.[bucket];
      const bx = gx + (gw - (bw + 2) * arms.length) / 2 + i * (bw + 2);
      if (!b || b.accuracy == null) { p.push(text(bx + bw / 2, base - 6, '—', { cls: 't-tiny', role: 'muted', anchor: 'middle' })); return; }
      p.push(columnUp(bx, bw, y(b.accuracy), base, armKey(arm), { title: `arm ${arm} · ${bucket}: ${fmtPct(b.accuracy)} (${b.hits}/${b.n}), 95% CI ${fmtPct(b.ci95[0])}–${fmtPct(b.ci95[1])}` }));
      p.push(line(bx + bw / 2, y(b.ci95[0]), bx + bw / 2, y(b.ci95[1]), 'ink2', 1));
      p.push(line(bx + bw / 2 - 3, y(b.ci95[0]), bx + bw / 2 + 3, y(b.ci95[0]), 'ink2', 1));
      p.push(line(bx + bw / 2 - 3, y(b.ci95[1]), bx + bw / 2 + 3, y(b.ci95[1]), 'ink2', 1));
      // Direct labels are selective on purpose: a number over all twenty bars is chaos and goes unread. The
      // two buckets that carry the claim get them, and only for the two arms the claim is between — B and C.
      if ((bucket === 'headline' || bucket === 'tripwire') && (arm === 'B' || arm === 'C')) {
        cands.push({ cx: bx + bw / 2, y: Math.max(y(b.ci95[1]) - 8, top - 6), txt: fmtPct(b.accuracy) });
      }
      p.push(text(bx + bw / 2, base + 16, arm, { cls: 't-tiny', role: 'muted', anchor: 'middle' }));
    });
    const placed = [];
    for (const c of cands.sort((u, v) => u.cx - v.cx)) {
      let yy = c.y;
      for (const q of placed) if (Math.abs(q.cx - c.cx) < 48 && Math.abs(q.y - yy) < 13) yy = q.y - 14;
      placed.push({ ...c, y: yy });
      p.push(text(c.cx, yy, c.txt, { cls: 't-tiny t-b t-num', role: 'ink', anchor: 'middle' }));
    }
    SHORT[bucket].split('\n').forEach((l, i) => p.push(text(gx + gw / 2, base + 34 + i * 13, l, { cls: 't-small t-b', role: 'ink', anchor: 'middle' })));
  };
  MAIN_BUCKETS.forEach((b, i) => drawGroup(b, L + i * gw));
  drawGroup('tripwire', tripX);
  p.push(text(tripX + gw / 2, base + 62, 'arm C is EXPECTED to fail here (§1)', { cls: 't-tiny', role: 'alert', anchor: 'middle' }));
  p.push(text(tripX + gw / 2, base + 75, 'C ≥ B in this panel VOIDS the run', { cls: 't-tiny', role: 'alert', anchor: 'middle' }));

  const lg = legend(arms.map((a) => ({ role: armKey(a), label: `arm ${a} — ${{ A: 'base model, no tools', B: 'base + Subgraph MCP', C: 'Ainize knowledge, no tools', D: 'knowledge + Subgraph MCP' }[a] ?? ''}`, value: fmtPct(model.accuracy.byArm[a]?.headline_E1_E2?.accuracy) })),
    HEAD_PAD, base + 104, { columns: 2, colWidth: 440 });

  const tblY = base + 104 + lg.height + 26;
  const cell = (arm, b) => {
    const x = model.accuracy.byArm[arm]?.buckets?.[b];
    return x && x.accuracy != null ? `${fmtPct(x.accuracy)} [${(x.ci95[0] * 100).toFixed(0)}–${(x.ci95[1] * 100).toFixed(0)}] ${x.hits}/${x.n}` : '—';
  };
  const rowsT = [...MAIN_BUCKETS, 'tripwire'].map((b) => [PREREG[b]?.label ?? b, ...arms.map((a) => cell(a, b))]);
  rowsT.push(['E1+E2 combined — the headline', ...arms.map((a) => {
    const x = model.accuracy.byArm[a]?.headline_E1_E2;
    return x && x.accuracy != null ? `${fmtPct(x.accuracy)} [${(x.ci95[0] * 100).toFixed(0)}–${(x.ci95[1] * 100).toFixed(0)}] ${x.hits}/${x.n}` : '—';
  })]);
  const colX = [0, 470, 622, 774, 926].slice(0, arms.length + 1);
  const tbl = valueTable(['bucket', ...arms.map((a) => `arm ${a}`)], rowsT, HEAD_PAD, tblY, colX);

  const f = footer([
    ...[...MAIN_BUCKETS, 'tripwire'].map((b) => `Pre-registered, ${b}: ${arms.map((a) => `${a} ${PREREG[b]?.[a] ?? '—'}`).join(' · ')}.`),
    'The pre-registered expectations above were frozen in README §1 before any model ran; they are printed beside the measurement so a reader compares prediction to result cell by cell rather than reading the result alone.',
    'The headline, Korean and ceiling buckets are the SAME facts in three phrasings: the P-to-E1 gap is the generalisation cost on one fact set, and reading it as a comparison across fact sets is wrong.',
  ], tblY + tbl.height + 22);
  return doc({
    width: WIDTH, height: tblY + tbl.height + 22 + f.height,
    title: `Accuracy by arm and bucket — run ${model.runId}`,
    desc: arms.map((a) => `arm ${a} headline ${fmtPct(model.accuracy.byArm[a]?.buckets?.headline?.accuracy)}, tripwire ${fmtPct(model.accuracy.byArm[a]?.buckets?.tripwire?.accuracy)}`).join('; '),
    body: [head.svg, ...p, lg.svg, tbl.svg, f.svg].join('\n  '),
  });
}

// ── 5. where the tool arm's answers were lost ────────────────────────────────────────────────────────────

const DELIVERED = new Set(['context_exhausted', 'truncated', 'had_it_and_still_wrong']);
const CHANNEL_RULE = {
  skipped: 'zero tool calls were made',
  wrong_subgraph: 'no executed query targeted any id in the item’s source_ids[]',
  query_error: 'every executed query returned an error or empty data',
  budget_exhausted: 'the 8-call / 10-turn / 90 s cap was hit before an answer',
  context_exhausted: 'the window filled with tool output — an eviction, or vLLM’s own 400',
  truncated: 'the truth appears ONLY in tool results that were cut at the wall',
  had_it_and_still_wrong: 'the truth WAS in an untruncated result and the answer differs',
  ignored_result: 'the truth appears in NO tool result',
};

/**
 * §6: "Every arm-B miss is assigned to exactly one channel ... printed as a table that sums to the miss
 * count." This is that table as a bar, and the bar is drawn only if it sums — the total is printed beside it
 * with the check result, because a decomposition that does not sum is not a finding, it is a bug.
 *
 * The three channels bracketed together are the ones §6 calls the interesting ones: The Graph delivered the
 * bytes and the loop lost them. They are the part of the gap a compiled memory table removes, and they are
 * the part a bigger context window or a better agent would remove instead — so they are labelled, not buried.
 */
export function chartMissChannels(model) {
  const arms = Object.keys(model.channels);
  const head = header({
    title: 'Where the tool arm’s answers were lost',
    subtitle: 'Every miss in a tool arm is assigned to exactly ONE of §6’s eight channels by a deterministic check over the recorded transcript — no opinion, no judge — and the segments sum to the arm’s miss count. A miss is any scored (non-error) unit that is not a hit: wrong + ambiguous + abstain. Unit: (item, repeat).',
    stamps: model.stamps,
  });

  const L = 92, R = WIDTH - 250, top = head.height + 34;
  const p = [];
  if (!arms.length) {
    p.push(text(HEAD_PAD, top, 'No tool arm was scored in this run, so there is no decomposition to draw.', { cls: 't-small', role: 'ink2' }));
  }
  const xMax = Math.max(1, ...arms.map((a) => model.channels[a].misses));
  const x = linScale(0, xMax, L, R);
  const BAR = 40, ROW = 116;
  arms.forEach((arm, ai) => {
    const c = model.channels[arm];
    const yTop = top + ai * ROW;
    p.push(text(HEAD_PAD, yTop + BAR / 2 + 5, `arm ${arm}`, { cls: 't-small t-b', role: 'ink' }));
    p.push(text(HEAD_PAD, yTop + BAR / 2 + 21, `${fmtInt(c.units)} units`, { cls: 't-tiny', role: 'muted' }));
    let acc = 0, delivStart = null, delivEnd = null, delivN = 0;
    CHANNELS.forEach((ch, i) => {
      const v = c.counts[ch] ?? 0;
      if (v > 0) {
        const x0 = x(acc), x1 = x(acc + v);
        p.push(barRight(yTop, BAR, x0, x1 - (acc + v >= c.misses ? 0 : 2), `chan-${i}`, { round: acc + v >= c.misses, title: `arm ${arm} — ${ch}: ${v} of ${c.misses} misses (${CHANNEL_RULE[ch]})` }));
        if (x1 - x0 > 30) p.push(text((x0 + x1) / 2, yTop + BAR / 2 + 4, String(v), { cls: 't-tiny t-b t-num', role: onFill(`chan-${i}`), anchor: 'middle' }));
        if (DELIVERED.has(ch)) { delivStart = delivStart == null ? x0 : delivStart; delivEnd = x1; }
      }
      if (DELIVERED.has(ch)) delivN += v;
      acc += v;
    });
    p.push(text(R + 14, yTop + BAR / 2 - 2, `${fmtInt(c.misses)} misses`, { cls: 't-small t-b t-num', role: 'ink' }));
    p.push(text(R + 14, yTop + BAR / 2 + 14, `${fmtInt(c.assigned)} assigned — ${c.sums ? 'sums ✓' : 'DOES NOT SUM'}`, { cls: 't-tiny t-b', role: c.sums ? 'good' : 'alert' }));
    if (delivStart != null) {
      const by = yTop - 12;
      p.push(path(`M${n(delivStart)},${n(by + 6)} L${n(delivStart)},${n(by)} L${n(delivEnd)},${n(by)} L${n(delivEnd)},${n(by + 6)}`, 'ink2', { w: 1 }));
      p.push(text((delivStart + delivEnd) / 2, by - 5, `The Graph delivered — the loop lost it: ${delivN}`, { cls: 't-tiny t-b', role: 'ink2', anchor: 'middle' }));
    } else if (c.misses > 0) {
      p.push(text(L, yTop - 7, 'no miss in this arm reached the "delivered and lost" channels', { cls: 't-tiny', role: 'muted' }));
    }
  });

  const lgY = top + Math.max(1, arms.length) * ROW + 4;
  const lg = legend(CHANNELS.map((ch, i) => ({
    role: `chan-${i}`, label: `${ch} — ${CHANNEL_RULE[ch]}`,
    value: arms.map((a) => `${a}: ${model.channels[a].counts[ch] ?? 0}`).join('  '),
  })), HEAD_PAD, lgY, { columns: 1, colWidth: WIDTH - 2 * HEAD_PAD });

  const tblY = lgY + lg.height + 26;
  const tbl = valueTable(['arm', 'units', 'misses', 'assigned to a channel', 'delivered-and-lost', 'sums'],
    arms.map((a) => {
      const c = model.channels[a];
      const deliv = [...DELIVERED].reduce((s, ch) => s + (c.counts[ch] ?? 0), 0);
      return [`arm ${a}`, fmtInt(c.units), fmtInt(c.misses), fmtInt(c.assigned), `${fmtInt(deliv)} (${c.misses ? fmtPct(deliv / c.misses) : '—'})`, c.sums ? 'yes' : 'NO — bug'];
    }), HEAD_PAD, tblY, [0, 430, 550, 690, 850, 928]);

  const f = footer([
    'The ladder is first-match-wins and ordered from the diagnosis that costs our thesis the most to the one that costs it the least: skipped → wrong_subgraph → query_error → budget_exhausted → context_exhausted → truncated → had_it_and_still_wrong → ignored_result. An item reaches had_it_and_still_wrong — the channel that flatters the compiled-memory claim — only after every "the loop never got there" explanation has been ruled out.',
    'The bracketed group is where The Graph delivered the bytes and the tool loop lost them: the window filled, the result was cut at the wall, or the truth was on screen and the final answer differed. That group is what a compiled memory table removes; the rest is what a better agent or a bigger window would remove instead. A C > B gap that does not show up here is not a finding (§"What would falsify this").',
    'wrong_subgraph is judged over the item’s source_ids[] — every deployment a fair query could have targeted — so a hop-2 join that queried either operand is not counted as a wrong subgraph.',
  ], tblY + tbl.height + 22);
  return doc({
    width: WIDTH, height: tblY + tbl.height + 22 + f.height,
    title: `Miss decomposition — run ${model.runId}`,
    desc: arms.map((a) => `arm ${a}: ${model.channels[a].misses} misses, ${model.channels[a].assigned} assigned, ${CHANNELS.map((c) => `${c} ${model.channels[a].counts[c]}`).join(', ')}`).join('; '),
    body: [head.svg, ...p, lg.svg, tbl.svg, f.svg].join('\n  '),
  });
}

// ── 6. the latency CDF §8 asks for ──────────────────────────────────────────────────────────────────────

/**
 * §8 lists a latency CDF among the charts, and it answers a question the p50/p95 bars cannot: not "how slow
 * is the median item" but "how long is the tail, and how much of the arm lives in it". Every unit is a step —
 * nothing is binned, nothing is smoothed — so a reader can count the items in the tail off the picture.
 */
export function chartLatencyCdf(model) {
  const arms = model.arms;
  const head = header({
    title: 'How long items take, end to end — the full distribution',
    subtitle: 'The empirical CDF of every scored unit\'s wall clock, one step per unit: read across at 50% or 95% to get that arm\'s p50 or p95, and read the flat right-hand tail to see how many items ran long. Tool arms carry a tail the knowledge arms do not have, because a tail is what a retry, an extra turn or a slow round trip produces.',
    stamps: model.stamps,
  });
  const xMax = Math.max(1, ...arms.map((a) => model.cdf[a]?.at(1) ?? 0)) * 1.04;
  const L = 92, R = WIDTH - 170, top = head.height + 20, H = 300, base = top + H;
  const x = linScale(0, xMax, L, R), y = linScale(0, 1, base, top);
  const p = [];
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    p.push(line(L, y(t), R, y(t), 'grid'));
    p.push(text(L - 10, y(t) + 4, `${Math.round(t * 100)}%`, { cls: 't-tiny', role: 'muted', anchor: 'end' }));
  }
  for (const tk of durTicks(xMax, 6)) p.push(text(x(tk.v), base + 18, tk.label, { cls: 't-tiny', role: 'muted', anchor: 'middle' }));
  p.push(line(L, base, R, base, 'axis'));
  p.push(text((L + R) / 2, base + 40, 'end-to-end latency for one item', { cls: 't-small', role: 'ink2', anchor: 'middle' }));
  p.push(text(L - 10, top - 14, 'share of units at or below that latency', { cls: 't-small', role: 'ink2', anchor: 'start' }));
  p.push(line(L, y(0.95), R, y(0.95), 'axis'));
  p.push(text(R + 6, y(0.95) - 6, 'p95', { cls: 't-tiny', role: 'muted' }));

  const ends = [];
  for (const a of arms) {
    const c = model.cdf[a];
    if (!c?.n) continue;
    let d = `M${n(x(0))},${n(y(0))}`;
    c.xs.forEach((v, i) => { d += ` L${n(x(v))},${n(y(i / c.n))} L${n(x(v))},${n(y((i + 1) / c.n))}`; });
    d += ` L${n(x(xMax))},${n(y(1))}`;
    p.push(path(d, armKey(a)));
    ends.push({ arm: a, yTrue: y(1), x: x(c.at(1)) });
  }
  const lg = legend(arms.map((a) => ({ role: armKey(a), label: `arm ${a}`, value: model.cdf[a]?.n ? `p50 ${fmtMs(model.cdf[a].at(0.5))} · p95 ${fmtMs(model.cdf[a].at(0.95))}` : '—' })),
    HEAD_PAD, base + 62, { columns: 2, colWidth: 440 });
  const tblY = base + 62 + lg.height + 26;
  const tbl = valueTable(['arm', 'units', 'p50', 'p90', 'p95', 'slowest unit'],
    arms.map((a) => { const c = model.cdf[a]; return [`arm ${a}`, fmtInt(c?.n ?? 0), fmtMs(c?.at(0.5)), fmtMs(c?.at(0.9)), fmtMs(c?.at(0.95)), fmtMs(c?.at(1))]; }),
    HEAD_PAD, tblY, [0, 430, 560, 680, 800, 928]);
  const f = footer([
    'Latency is host-dependent (§7.2): it moves with the GPU, the network and whatever else was on the box. The token chart beside this one is the host-independent version of the same comparison, which is why both are printed.',
    'Every unit is drawn. An arm whose curve reaches 100% far to the right of its p50 is an arm whose cost is set by its tail, not by its median — the case for reporting both.',
  ], tblY + tbl.height + 22);
  return doc({
    width: WIDTH, height: tblY + tbl.height + 22 + f.height,
    title: `Latency CDF — run ${model.runId}`,
    desc: arms.map((a) => `arm ${a} p50 ${fmtMs(model.cdf[a]?.at(0.5))} p95 ${fmtMs(model.cdf[a]?.at(0.95))}`).join('; '),
    body: [head.svg, ...p, lg.svg, tbl.svg, f.svg].join('\n  '),
  });
}

// ── 7. tokens per question, the host-independent comparison ─────────────────────────────────────────────

/**
 * §6: prompt and completion tokens "summed over all turns, from vLLM's usage. This is the number that
 * separates the arms most sharply and it is host-independent." It is also the structural claim in §3 — arm
 * B's context grows with the data it reads and is capped by the window; arm C's marginal context is zero
 * tokens — so the peak prompt against the serving window is printed beside the means rather than left out.
 */
export function chartTokens(model) {
  const arms = model.arms;
  const win = model.provenance?.max_model_len ?? null;
  const head = header({
    title: 'Tokens per question, summed over every turn',
    subtitle: `Prompt and completion tokens from vLLM's own usage, summed over all turns of an item and averaged over the arm's units. This is the comparison that does not depend on the host: a faster GPU changes the latency chart and changes nothing here. The tool arms pay for every byte of subgraph JSON they read${win ? `, inside a ${fmtInt(win)}-token window` : ''}.`,
    stamps: model.stamps,
  });
  const L = 92, R = WIDTH - 40, top = head.height + 22, H = 280, base = top + H;
  const yMax = niceCeil(Math.max(1, ...arms.map((a) => (model.tokens.byArm[a].prompt_per_question ?? 0) + (model.tokens.byArm[a].completion_per_question ?? 0))));
  const y = linScale(0, yMax, base, top);
  const p = [];
  for (const t of niceTicks(0, yMax, 5)) {
    p.push(line(L, y(t), R, y(t), 'grid'));
    p.push(text(L - 10, y(t) + 4, fmtInt(t), { cls: 't-tiny', role: 'muted', anchor: 'end' }));
  }
  p.push(line(L, base, R, base, 'axis'));
  p.push(text(L - 10, top - 14, 'tokens per question', { cls: 't-small', role: 'ink2', anchor: 'start' }));
  const gw = (R - L) / arms.length, bw = Math.min(24, gw / 3);
  arms.forEach((a, i) => {
    const tk = model.tokens.byArm[a];
    const bx = L + i * gw + gw / 2 - bw / 2;
    const pr = tk.prompt_per_question ?? 0, co = tk.completion_per_question ?? 0;
    p.push(columnUp(bx, bw, y(pr), base, 'ord-0', { round: false, title: `arm ${a} — prompt tokens per question: ${fmtInt(pr)}` }));
    p.push(columnUp(bx, bw, y(pr + co), y(pr) - 2, 'ord-2', { title: `arm ${a} — completion tokens per question: ${fmtInt(co)}` }));
    p.push(text(bx + bw / 2, y(pr + co) - 8, fmtInt(pr + co), { cls: 't-small t-b t-num', role: 'ink', anchor: 'middle' }));
    p.push(text(bx + bw / 2, base + 20, `arm ${a}`, { cls: 't-small t-b', role: 'ink', anchor: 'middle' }));
    p.push(text(bx + bw / 2, base + 35, `${fmtNumber(tk.turns_per_question)} turns/q`, { cls: 't-tiny', role: 'muted', anchor: 'middle' }));
  });
  const lg = legend([
    { role: 'ord-0', label: 'prompt tokens per question (summed over every turn)' },
    { role: 'ord-2', label: 'completion tokens per question' },
  ], HEAD_PAD, base + 62, { columns: 2, colWidth: 440 });
  const tblY = base + 62 + lg.height + 26;
  const tbl = valueTable(['arm', 'prompt tok/q', 'completion tok/q', 'total tok/q', 'peak prompt', win ? `share of the ${fmtInt(win)} window` : 'share of window', 'tool bytes in'],
    arms.map((a) => {
      const tk = model.tokens.byArm[a];
      return [`arm ${a}`, fmtInt(tk.prompt_per_question), fmtInt(tk.completion_per_question), fmtInt((tk.prompt_per_question ?? 0) + (tk.completion_per_question ?? 0)),
        fmtInt(tk.peak_prompt), win ? fmtPct(tk.peak_prompt / win) : '—', fmtInt(tk.tool_bytes_in)];
    }), HEAD_PAD, tblY, [0, 330, 470, 590, 700, 830, 928]);
  const f = footer([
    'Peak prompt is the largest single request an arm made, which is the number the context window actually caps — not the per-question total above it, which is a sum over turns and may exceed the window without any turn doing so.',
    'This is the structural point behind §3: a tool arm\'s context grows with the data it reads and is capped by the window, while the knowledge arm\'s marginal context is zero tokens. A larger host relieves the cap and does not change the token count.',
    'Cost follows from this chart and the list prices in pricing.json; the break-even chart is the same numbers with a one-time price added.',
  ], tblY + tbl.height + 22);
  return doc({
    width: WIDTH, height: tblY + tbl.height + 22 + f.height,
    title: `Tokens per question — run ${model.runId}`,
    desc: arms.map((a) => `arm ${a}: ${fmtInt(model.tokens.byArm[a].prompt_per_question)} prompt + ${fmtInt(model.tokens.byArm[a].completion_per_question)} completion tokens per question, peak prompt ${fmtInt(model.tokens.byArm[a].peak_prompt)}`).join('; '),
    body: [head.svg, ...p, lg.svg, tbl.svg, f.svg].join('\n  '),
  });
}

// ── entry point ──────────────────────────────────────────────────────────────────────────────────────────

export const CHARTS = [
  ['cost-break-even.svg', chartCostBreakEven],
  ['latency-decomposition.svg', chartLatencyDecomposition],
  ['latency-cumulative.svg', chartLatencyCumulative],
  ['accuracy-by-bucket.svg', chartAccuracy],
  ['miss-channels.svg', chartMissChannels],
  ['latency-cdf.svg', chartLatencyCdf],
  ['tokens-per-question.svg', chartTokens],
];

export function chartRun(runDir, { pricingPath = null, outDir = null, knowledgeLoadMs = null } = {}) {
  const model = loadRun(runDir, { pricingPath, knowledgeLoadMs });
  const out = resolve(outDir ?? join(resolve(runDir), 'charts'));
  mkdirSync(out, { recursive: true });
  const files = [];
  for (const [name, fn] of CHARTS) {
    const svg = fn(model);
    writeFileSync(join(out, name), svg);
    files.push(join(out, name));
  }
  return { model, out, files };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  const flags = {}; const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
    else positional.push(args[i]);
  }
  const flag = (k) => (typeof flags[k] === 'string' ? flags[k] : null);
  const runDir = positional[0];
  if (!runDir) { console.error('usage: node src/chart.mjs runs/<id> [--out <dir>] [--pricing pricing.json] [--knowledge-load-ms N]'); process.exit(1); }
  try {
    const { model, out, files } = chartRun(runDir, { pricingPath: flag('pricing'), outDir: flag('out'), knowledgeLoadMs: flag('knowledge-load-ms') });
    for (const s of model.stamps) console.error(`!! ${s}`);
    if (!model.load.measured) console.error(`!! knowledge load time: ${model.load.source}`);
    console.error(`charted ${model.rows.length} units over ${model.items} items, arms ${model.arms.join(',')}`);
    for (const f of files) console.error(`  ${f}`);
    console.error(`wrote ${files.length} SVGs to ${out}`);
  } catch (e) { console.error(`chart.mjs: ${e.message}`); process.exit(1); }
}
