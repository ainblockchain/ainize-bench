/**
 * Self-test for the scoring rules. `node src/normalize.test.mjs` — no GPU, no API key, no network.
 * Every case here is a rule a judge might argue with; if you change a rule, this file says what changed.
 */
import { scoreOne, wilson, mcnemar } from './normalize.mjs';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
};
const v = (answer, item) => scoreOne(answer, item).verdict;

const ADDR = { id: 'a', answer_type: 'address', truth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' };
t('address: bare, wrong case', v('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', ADDR), 'hit');
t('address: in a sentence', v('The underlying asset is 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 (WETH).', ADDR), 'hit');
t('address: different address', v('0x0000000000000000000000000000000000000001', ADDR), 'wrong');
t('address: shotgun list containing the truth', v('It is one of 0x0000000000000000000000000000000000000001, 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', ADDR), 'ambiguous');
t('address: no address at all', v('I would need to query the subgraph.', ADDR), 'wrong');
t('address: honest refusal', v('Unknown — I have no data for that vault.', ADDR), 'abstain');
t('address: empty', v('', ADDR), 'error');

const SYM = { id: 's', answer_type: 'symbol', truth: 'WETH' };
t('symbol: lowercase + punctuation', v('weth.', SYM), 'hit');
t('symbol: answer-prefix furniture', v('Answer: WETH', SYM), 'hit');
t('symbol: wrong ticker', v('USDC', SYM), 'wrong');

const INT = { id: 'i', answer_type: 'integer', truth: '138080' };
t('integer: thousands separators', v('138,080', INT), 'hit');
t('integer: units around it', v('There are 138080 depositors.', INT), 'hit');
t('integer: wrong number', v('087600', INT), 'wrong');

const DEC = { id: 'd', answer_type: 'decimal', truth: '1234567.89' };
t('decimal: within 1%', v('1,240,000', DEC), 'hit');
t('decimal: outside 1%', v('1,300,000', DEC), 'wrong');
t('decimal: dollar formatting', v('$1,234,567.89', DEC), 'hit');

const LIST = { id: 'l', answer_type: 'list<symbol>', truth: ['WETH', 'USDC', 'DAI'] };
t('list: exact set, any order', v('DAI, WETH and USDC', LIST), 'hit');
t('list: missing one element is NOT a hit', v('WETH, USDC', LIST), 'wrong');
t('list: partial credit is reported separately', scoreOne('WETH, USDC', LIST).partial, 2 / 3);

// Statistics used in the summary table.
t('wilson: 0/10 lower bound is 0', wilson(0, 10)[0], 0);
const w = wilson(90, 100).map((x) => Math.round(x * 1000) / 1000);
t('wilson: 90/100', w, [0.826, 0.945]);
const mc = mcnemar([[1, 0], [1, 0], [1, 0], [1, 0], [1, 0], [1, 0], [0, 1], [1, 1], [0, 0]]);
t('mcnemar: 6 vs 1 discordant', [mc.b, mc.c, Math.round(mc.p * 1000) / 1000], [6, 1, 0.125]);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
