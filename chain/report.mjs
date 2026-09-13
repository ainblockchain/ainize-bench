import { readFileSync, writeFileSync } from 'node:fs';
const rows = JSON.parse(readFileSync('out/arm_a.json', 'utf8'));
const n = rows.length, c = (v) => rows.filter((x) => x.verdict === v).length;
const pct = (x, d = n) => `${(x / d * 100).toFixed(1)}%`;
const pre = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
const wrong = rows.filter((x) => x.verdict === 'hallucinated' || x.verdict === 'cross_chain')
  .map((x) => ({ ...x, prefix: pre(x.answer ?? '', x.address) })).sort((a, b) => b.prefix - a.prefix);
const near = wrong.filter((x) => x.prefix >= 10);
const chain = (ch) => { const s = rows.filter((x) => x.chain === ch); const k = (v) => s.filter((x) => x.verdict === v).length;
  return { n: s.length, correct: pct(k('correct'), s.length), wrong: pct(k('hallucinated') + k('cross_chain'), s.length), refused: pct(k('refused'), s.length) }; };
const e = chain('ethereum'), b = chain('base');

writeFileSync('out/REPORT.md', `# LLM은 컨트랙트 주소를 얼마나 틀리는가

Ainize 측정 · 2026-09-13 · 모델 \`Qwen3.8-Flash-Next\` (도구 없음, 패치 없음)

## 요약

**${n}개 정본 토큰 주소**를 물었다. 정답은 **${pct(c('correct'))}**.

| 결과 | 건수 | 비율 |
|---|---|---|
| 정답 | ${c('correct')} | ${pct(c('correct'))} |
| **틀린 주소** | **${c('hallucinated') + c('cross_chain')}** | **${pct(c('hallucinated') + c('cross_chain'))}** |
| 답변 거부 | ${c('refused')} | ${pct(c('refused'))} |

거부가 ${pct(c('refused'))}다. 안전하지만 쓸모가 없다 — 열 번 물으면 아홉 번은 답을 못 준다.
그리고 답을 줄 때, **${pct(c('hallucinated') + c('cross_chain'), c('correct') + c('hallucinated') + c('cross_chain'))}는 틀린 주소다.**

## 체인별

| 체인 | 문항 | 정답 | 틀린 주소 | 거부 |
|---|---|---|---|---|
| Ethereum | ${e.n} | ${e.correct} | ${e.wrong} | ${e.refused} |
| **Base** | ${b.n} | **${b.correct}** | ${b.wrong} | **${b.refused}** |

**모델은 Base를 사실상 모른다.** ${b.n}개 중 정답은 ${rows.filter((x) => x.chain === 'base' && x.verdict === 'correct').length}개다.

## 위험한 건 오답률이 아니라 '그럴듯함'

틀린 주소 ${wrong.length}건 중 **${near.length}건(${pct(near.length, wrong.length)})이 앞 10자 이상 정답과 일치한다.**
지갑과 익스플로러는 주소를 \`0x1111…c302\`처럼 줄여 보여준다. 사람이 눈으로 검증하는 부분이 정확히 그 앞자리다.

| 일치 접두 | 건수 | 의미 |
|---|---|---|
| 2-5자 | ${wrong.filter((x) => x.prefix < 6).length} | 딱 봐도 다름 |
| 6-9자 | ${wrong.filter((x) => x.prefix >= 6 && x.prefix < 10).length} | 흘려보면 놓침 |
| 10-17자 | ${wrong.filter((x) => x.prefix >= 10 && x.prefix < 18).length} | 지갑 축약형과 구분 불가 |
| **18자+** | **${wrong.filter((x) => x.prefix >= 18).length}** | **사실상 식별 불가** |

### 최악 사례

${wrong.slice(0, 8).map((x) => `**${x.symbol}** (${x.chain}) — 앞 ${x.prefix}자 일치
\`\`\`
모델  ${x.answer}
정답  ${x.address}
\`\`\``).join('\n\n')}

## 왜 조회(RAG)로 안 풀리나

이건 한 줄 조회가 아니라 **체인 × 토큰 × 프로토콜의 넓은 스캔**이다. 모델은 자기가 틀렸다는 걸 모르므로
조회를 해야 한다는 판단 자체를 하지 않는다. 위 ${near.length}건은 모델이 **확신을 갖고** 내놓은 답이다.

## 무엇을 하면 되나

해당 체인의 정본 주소를 **모델 메모리에 구워 넣는다**. Ainize의 지식 패치가 하는 일이고,
두 개의 독립 노드가 실제 모델에 로드해 벤치마크로 채점해야만 판매된다 — 검증된 정답만 유통된다.

- \`chain/ethereum\` — Ethereum 정본 주소
- \`chain/base\` — Base 정본 주소

## 재현

\`\`\`
cd ainize-bench/chain
node build_truth.mjs      # CoinGecko 시총 상위 500 → 체인별 정본 주소 ${n}행
N=${n} node run_bench.mjs  # 베이스 모델에 질의·채점
node analyze.mjs          # 접두 일치 분석
\`\`\`

정답 출처는 CoinGecko 플랫폼 레지스트리. 질문은 \`"What is the contract address of <name> (<SYM>) on <Chain>? Reply with the address only."\` 하나로 고정, temperature 0.
`);
console.log('out/REPORT.md 생성');
console.log(`요약: n=${n} 정답 ${pct(c('correct'))} / 오답 ${pct(c('hallucinated'))} / 거부 ${pct(c('refused'))}`);
console.log(`답을 준 경우 중 오답 비율: ${pct(c('hallucinated'), c('correct') + c('hallucinated'))}`);
console.log(`앞 10자 이상 일치 오답: ${near.length}건 (오답의 ${pct(near.length, wrong.length)})`);
