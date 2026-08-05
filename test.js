/* Invariant tests for kelly.js — run with `node test.js`. */
const K = require("./kelly.js");

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    failures++;
    console.error("FAIL:", msg);
  }
}

// Deterministic RNG (mulberry32) so failures are reproducible.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(42);

// kellyFraction sanity: even-money coin at 60% → f* = 0.2
check(
  Math.abs(K.kellyFraction(1, 0.6, 0.4) - 0.2) < 1e-12,
  "kelly 60% even money = 0.2",
);
// 2:1 payout, 50% → f* = (0.5*2-0.5)/2 = 0.25
check(
  Math.abs(K.kellyFraction(2, 0.5, 0.5) - 0.25) < 1e-12,
  "kelly 2:1 at 50% = 0.25",
);
// push mode: b=1, p=0.4, q=0.3 → (0.4-0.3)/(1*0.7)
check(
  Math.abs(K.kellyFraction(1, 0.4, 0.3) - 0.1 / 0.7) < 1e-12,
  "kelly with push",
);

for (const advanced of [false, true]) {
  const cats = { pos: 0, neg: 0, small: 0 };
  const odds = [];
  const N = 10000;
  for (let i = 0; i < N; i++) {
    const r = K.genRound(advanced, rng);
    cats[r.cat]++;
    odds.push(r.b);
    check(
      r.p >= 0.001 && r.q >= 0.001,
      `probs positive (${JSON.stringify(r)})`,
    );
    const sum = r.p + r.q;
    if (advanced) check(sum <= 1 + 1e-9, `advanced p+q<=1 (${sum})`);
    else check(Math.abs(sum - 1) < 1e-9, `simple p+q=1 (${sum})`);
    check(
      Math.abs(r.push - (1 - sum)) < 0.011,
      `push consistent (${r.push} vs ${1 - sum})`,
    );
    check(
      Number.isFinite(r.kelly) && r.kelly <= 0.9,
      `kelly bounded (${r.kelly})`,
    );
    check(r.b >= 0.05 && r.b <= 25.01, `odds in range (${r.b})`);
    // probabilities land on 0.1% steps (1% steps for b >= 1)
    check(
      Math.abs(r.p * 1000 - Math.round(r.p * 1000)) < 1e-6,
      `p on 0.1% grid (${r.p})`,
    );
    check(
      Math.abs(r.q * 1000 - Math.round(r.q * 1000)) < 1e-6,
      `q on 0.1% grid (${r.q})`,
    );
    // the rounded probabilities must preserve the intended edge sign
    if (r.cat === "neg")
      check(r.kelly < 0, `neg cat has neg kelly (${r.kelly})`);
    else check(r.kelly > 0, `${r.cat} cat has pos kelly (${r.kelly})`);
    if (r.cat === "small")
      check(r.kelly < 0.12, `small cat kelly is small (${r.kelly})`);
  }
  // edge mix ≈ 4/5 positive, 1/10 negative, 1/10 small positive
  check(Math.abs(cats.pos / N - 0.8) < 0.03, `pos mix (${cats.pos / N})`);
  check(Math.abs(cats.neg / N - 0.1) < 0.02, `neg mix (${cats.neg / N})`);
  check(Math.abs(cats.small / N - 0.1) < 0.02, `small mix (${cats.small / N})`);
  // odds center on even money with large variance
  odds.sort((a, b) => a - b);
  const median = odds[Math.floor(N / 2)];
  check(median > 0.7 && median < 1.4, `odds median near 1 (${median})`);
  check(odds[Math.floor(N * 0.95)] > 3, `long-shot tail exists`);
  check(odds[Math.floor(N * 0.05)] < 0.35, `heavy-favorite tail exists`);
}

// genChoices invariants across bankroll scales
let inWindowMisses = 0;
let posRounds = 0;
let under1 = 0;
let sigViolations = 0;
let totalChoices = 0;
let wellSpread = 0;
let modestKellyRounds = 0;
let maxIsOverbet = 0;
let secondIsOverbet = 0;
let allOverRounds = 0;
for (let i = 0; i < 5000; i++) {
  const bankroll = Math.exp(3 + rng() * 10); // ~$20 .. ~$9M
  const r = K.genRound(rng() < 0.5, rng);
  const choices = K.genChoices(r.kelly, bankroll, rng);
  check(
    choices.length === 4,
    `4 choices (got ${choices.length}, bankroll ${bankroll})`,
  );
  check(new Set(choices).size === choices.length, "choices distinct");
  for (let j = 1; j < choices.length; j++) {
    check(choices[j] < choices[j - 1], "choices sorted descending");
  }
  if (choices.every((a, j) => j === 0 || choices[j - 1] / a >= 1.35)) {
    wellSpread++;
  }
  for (const a of choices) {
    check(
      a >= 1 && a <= bankroll + 1e-9 && Number.isInteger(a),
      `choice is a whole dollar within bankroll (${a} vs ${bankroll})`,
    );
    // amounts land on the preferred-number grid; rare fallbacks (bankroll
    // cap, narrow kelly windows) may deviate
    if (a >= 10) {
      const mant = a / Math.pow(10, Math.floor(Math.log10(a * (1 + 1e-12))));
      const onGrid = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8].some(
        (m) => Math.abs(mant - m) < 1e-6,
      );
      if (!onGrid) sigViolations++;
    }
    totalChoices++;
  }
  if (r.kelly > 0) {
    posRounds++;
    const mult = (a) => a / bankroll / r.kelly;
    if (choices.some((a) => mult(a) < 1)) under1++;
    if (choices.every((a) => mult(a) > 1)) allOverRounds++;
    // the biggest option should usually be a clear overbet — and rank 2
    // must be a trap often enough that "always second" doesn't pay either
    if (r.kelly <= 0.3) {
      modestKellyRounds++;
      if (mult(choices[0]) > 2) maxIsOverbet++;
      if (mult(choices[1]) > 2) secondIsOverbet++;
    }
    // representable only if some whole dollar fits inside the window
    const lo = Math.max(1, 0.1 * r.kelly * bankroll);
    const hi = Math.min(2 * r.kelly * bankroll, Math.floor(bankroll));
    const representable = Math.floor(hi) >= Math.ceil(lo);
    const ok = choices.some(
      (a) => mult(a) >= 0.1 - 1e-9 && mult(a) <= 2 + 1e-9,
    );
    if (representable && !ok) inWindowMisses++;
  }
}
// no-good-menu rounds legitimately miss the [0.1,2] window when everything
// samples above 2×; outside those the guarantee must hold
check(
  inWindowMisses / posRounds <= 0.12,
  `the [0.1,2]×kelly guarantee holds outside no-good menus (misses: ${inWindowMisses}/${posRounds})`,
);
check(
  allOverRounds / posRounds >= 0.08 && allOverRounds / posRounds <= 0.26,
  `roughly 1/6 of menus offer no good size (${(allOverRounds / posRounds).toFixed(3)})`,
);
check(
  under1 / posRounds >= 0.5,
  `an option sits below 1×kelly most of the time (${(under1 / posRounds).toFixed(3)})`,
);
check(
  sigViolations / totalChoices < 0.02,
  `amounts are preferred numbers (violations: ${sigViolations}/${totalChoices})`,
);
check(
  wellSpread / 5000 >= 0.85,
  `adjacent options usually differ by ≥1.35× (${(wellSpread / 5000).toFixed(3)})`,
);
check(
  maxIsOverbet / modestKellyRounds >= 0.7 &&
    maxIsOverbet / modestKellyRounds <= 0.99,
  `largest option is usually — not always — an overbet (${(maxIsOverbet / modestKellyRounds).toFixed(3)})`,
);
check(
  secondIsOverbet / modestKellyRounds >= 0.25,
  `second-largest is a trap often enough (${(secondIsOverbet / modestKellyRounds).toFixed(3)})`,
);

// tiny bankroll edge case — must still produce 4 distinct affordable options
for (let i = 0; i < 500; i++) {
  const r = K.genRound(false, rng);
  const choices = K.genChoices(r.kelly, 7.4, rng);
  check(
    choices.length === 4 &&
      choices.every((a) => a <= 7 && a >= 1 && Number.isInteger(a)),
    `tiny bankroll choices ok (${choices})`,
  );
}

// resolve: frequencies roughly match probabilities
{
  const round = { b: 2, p: 0.3, q: 0.5, push: 0.2 };
  let w = 0,
    l = 0,
    p = 0;
  for (let i = 0; i < 100000; i++) {
    const res = K.resolve(round, 10, rng);
    if (res.outcome === "win") {
      w++;
      check(res.delta === 20, "win delta");
    } else if (res.outcome === "lose") {
      l++;
      check(res.delta === -10, "lose delta");
    } else {
      p++;
      check(res.delta === 0, "push delta");
    }
  }
  check(Math.abs(w / 100000 - 0.3) < 0.01, `win freq (${w / 100000})`);
  check(Math.abs(l / 100000 - 0.5) < 0.01, `lose freq (${l / 100000})`);
  check(Math.abs(p / 100000 - 0.2) < 0.01, `push freq (${p / 100000})`);
  check(K.resolve(round, 0, rng).outcome === "pass", "zero bet is a pass");
}

// scoring + histogram
check(K.kellyScore(0.2, 0.2) === 1, "score of exact kelly = 1");
check(K.kellyScore(0, 0.2) === 0, "pass scores 0");
check(K.kellyScore(0.1, -0.05) < 0, "betting a negative edge scores < 0");
check(K.kellyScore(0, -0.05) === 0, "passing a negative edge scores 0");
{
  const h = K.histogram([-1.5, -1, -0.5, 0, 0.05, 0.95, 1.0, 4.99, 5, 12]);
  check(h[0] === 1, "<-1 bucket");
  check(h[1] === 1, "[-1,-0.9) bucket");
  check(h[6] === 1, "[-0.5,-0.4) bucket");
  check(h[11] === 2, "[0,0.1) bucket");
  check(h[20] === 1, "[0.9,1.0) bucket");
  check(h[21] === 1, "[1.0,1.1) bucket");
  check(h[60] === 1, "[4.9,5.0) bucket");
  check(h[61] === 2, "≥5 bucket");
  check(h.reduce((a, b) => a + b, 0) === 10, "histogram counts all scores");
}
// easy mode never deals a negative edge
for (let i = 0; i < 2000; i++) {
  const r = K.genRound({ ternary: false, negEdge: false }, rng);
  check(r.kelly > 0, `easy mode edge positive (${r.kelly})`);
  check(Math.abs(r.p + r.q - 1) < 1e-9, "easy mode is binary");
}

// odds conversions
for (const [b, num, den] of [
  [2.5, 5, 2],
  [0.45, 9, 20],
  [1, 1, 1],
  [21.75, 87, 4],
  [0.05, 1, 20],
  [1.6, 8, 5],
]) {
  const [n, d] = K.toFraction(b);
  check(
    n === num && d === den,
    `toFraction(${b}) = ${n}/${d}, expected ${num}/${den}`,
  );
}
for (const [b, expected] of [
  [2.5, 250],
  [1, 100],
  [0.4, -250],
  [0.05, -2000],
  [21.75, 2175],
]) {
  check(
    K.americanOdds(b) === expected,
    `americanOdds(${b}) = ${K.americanOdds(b)}, expected ${expected}`,
  );
}
// round-trip: every generated round has consistent conversions
for (let i = 0; i < 2000; i++) {
  const r = K.genRound(rng() < 0.5, rng);
  const [n, d] = K.toFraction(r.b);
  check(Math.abs(n / d - r.b) < 1e-9, `fraction exact for b=${r.b}`);
  const a = K.americanOdds(r.b);
  const back = a > 0 ? a / 100 : -100 / a;
  check(
    Math.abs(back - r.b) / r.b < 0.05,
    `american close for b=${r.b} (${a})`,
  );
}

// niceAmount produces round numbers
for (const [x, expected] of [
  [97, 100],
  [97.3, 100],
  [0.013, 1],
  [3.7, 4],
  [3.14, 3],
  [123456, 150000],
  [22, 20],
  [7.2, 8],
]) {
  check(
    K.niceAmount(x) === expected,
    `niceAmount(${x}) = ${K.niceAmount(x)}, expected ${expected}`,
  );
}

if (failures === 0) console.log("All tests passed.");
else {
  console.error(`${failures} failure(s).`);
  process.exit(1);
}
