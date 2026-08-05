/* Pure game logic for the Kelly criterion simulator.
   No DOM access here — loadable in Node for tests and in the browser via <script>. */

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Kelly = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const uniform = (rng, lo, hi) => lo + rng() * (hi - lo);

  /* ---------- nice-number helpers ---------- */

  // Bets land on preferred numbers: these mantissas × any power of ten,
  // rounded to whole dollars — the game is dollar-quantized, no cents.
  const NICE_MANTISSAS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8];

  // Snap a dollar amount to the nearest preferred number (log-space nearest,
  // so rounding stays proportional), never below a dollar.
  function niceAmount(x) {
    if (!(x > 0)) return 0;
    const exp = Math.floor(Math.log10(Math.max(x, 1)));
    let best = null;
    let bestDist = Infinity;
    for (const e of [exp - 1, exp, exp + 1]) {
      const pow = Math.pow(10, e);
      for (const m of NICE_MANTISSAS) {
        const v = Math.max(1, Math.round(m * pow));
        const d = Math.abs(Math.log(v / x));
        if (d < bestDist) {
          bestDist = d;
          best = v;
        }
      }
    }
    return best;
  }

  // Largest preferred number ≤ x (never below a dollar).
  function niceFloor(x) {
    if (!(x >= 1)) return 1;
    let best = 1;
    const exp = Math.floor(Math.log10(x));
    for (const e of [exp - 1, exp]) {
      const pow = Math.pow(10, e);
      for (const m of NICE_MANTISSAS) {
        const v = Math.max(1, Math.round(m * pow));
        if (v <= x && v > best) best = v;
      }
    }
    return best;
  }

  // All preferred numbers within [lo, hi], ascending.
  function niceAmountsInRange(lo, hi) {
    if (!(hi >= 1) || hi < lo) return [];
    const out = new Set();
    const eLo = Math.floor(Math.log10(Math.max(lo, 1))) - 1;
    const eHi = Math.floor(Math.log10(hi)) + 1;
    for (let e = eLo; e <= eHi; e++) {
      const pow = Math.pow(10, e);
      for (const m of NICE_MANTISSAS) {
        const v = Math.max(1, Math.round(m * pow));
        if (v >= lo && v <= hi) out.add(v);
      }
    }
    return [...out].sort((a, b) => a - b);
  }

  function roundOdds(b) {
    let step;
    if (b < 1) step = 0.05;
    else if (b < 3) step = 0.1;
    else step = 0.25;
    return Math.max(0.05, Math.round(b / step) * step);
  }

  /* ---------- odds conversions ---------- */

  // Net odds b (profit per 1 staked) as a vulgar fraction [num, den].
  // The odds grid is 0.05-stepped, so a denominator of 20 is always exact.
  function toFraction(b) {
    const gcd = (a, c) => (c ? gcd(c, a % c) : a);
    const n = Math.round(b * 20);
    const k = gcd(n, 20) || 1;
    return [n / k, 20 / k];
  }

  // American odds: +profit on a $100 stake, or −stake needed to win $100.
  function americanOdds(b) {
    return b >= 1 ? Math.round(100 * b) : -Math.round(100 / b);
  }

  /* ---------- round generation ---------- */

  // Kelly fraction for a bet paying b:1, win prob p, lose prob q (p + q <= 1;
  // the remainder pushes). Derived from maximizing E[log wealth]:
  // f* = (p*b - q) / (b * (p + q))
  function kellyFraction(b, p, q) {
    const s = p + q;
    if (s <= 0 || b <= 0) return 0;
    return (p * b - q) / (b * s);
  }

  // Odds are centered on even money with large variance: log-normal around 1,
  // so heavy favorites (1:8) and long shots (8:1) both show up regularly.
  function sampleOdds(rng) {
    const u1 = Math.max(rng(), 1e-12);
    const u2 = rng();
    const n = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return roundOdds(clamp(Math.exp(n * 1.1), 0.05, 25));
  }

  // Edge mix: 4/5 clearly positive, 1/10 negative (the pass trap), 1/10 small
  // positive (worth only a token bet — punishes oversizing). Negative edges
  // are kept moderate (|kelly| ≥ 0.15) so betting into one scores around
  // −2..0, a thinking-range penalty rather than a wild outlier. Easy modes
  // drop the negative edges entirely.
  function sampleTargetKelly(rng, negEdge) {
    const u = rng();
    if (negEdge === false) {
      if (u < 0.85) return { cat: "pos", ft: uniform(rng, 0.05, 0.6) };
      return { cat: "small", ft: uniform(rng, 0.005, 0.05) };
    }
    if (u < 0.8) return { cat: "pos", ft: uniform(rng, 0.05, 0.6) };
    if (u < 0.9) return { cat: "neg", ft: uniform(rng, -0.6, -0.15) };
    return { cat: "small", ft: uniform(rng, 0.005, 0.05) };
  }

  // Generate a round: odds first, then a target Kelly fraction from the edge
  // mix, then the win probability that produces that edge at those odds. The
  // Kelly used for scoring is recomputed from the *rounded* probabilities.
  // opts: boolean (legacy: ternary, neg edges on) or {ternary, negEdge}.
  function genRound(opts, rng) {
    rng = rng || Math.random;
    const o =
      typeof opts === "object" && opts !== null
        ? opts
        : { ternary: !!opts, negEdge: true };
    const advanced = !!o.ternary;
    for (let attempt = 0; attempt < 200; attempt++) {
      const b = sampleOdds(rng);
      const { cat, ft } = sampleTargetKelly(rng, o.negEdge !== false);
      // s = p + q; in advanced mode the remainder (1 - s) is a push
      const s = advanced
        ? 1 - Math.round(uniform(rng, 0.05, 0.35) * 100) / 100
        : 1;
      // Kelly moves by (b+1)/b per unit of p — short odds need finer percents
      // or the rounding below would erase small edges entirely.
      const grain = b < 1 ? 1000 : 100;
      const pRaw = (s * (1 + ft * b)) / (b + 1);
      const p = clamp(Math.round(pRaw * grain) / grain, 0.001, s - 0.001);
      const q = Math.round((s - p) * 1000) / 1000;
      if (p < 0.001 || q < 0.001) continue;
      const kelly = kellyFraction(b, p, q);
      // Rounding must not flip the intended edge, and the game stays playable.
      if (cat === "neg" ? kelly >= 0 : kelly <= 0) continue;
      if (kelly > 0.9) continue;
      return {
        b,
        p,
        q,
        push: Math.round((1 - p - q) * 1000) / 1000,
        kelly,
        advanced,
        cat,
      };
    }
    // Statistically unreachable; a fixed fallback keeps the game alive regardless.
    return {
      b: 1,
      p: 0.55,
      q: 0.45,
      push: 0,
      kelly: 0.1,
      advanced,
      cat: "pos",
    };
  }

  /* ---------- multiple-choice bet options ---------- */

  // Sample a bet fraction geometrically: uniform in log space over [lo, hi],
  // so option sizes are scale-free — $2 vs $6 is as likely as $20 vs $60.
  function logUniform(rng, lo, hi) {
    return Math.exp(uniform(rng, Math.log(lo), Math.log(hi)));
  }

  // Four distinct round dollar amounts, sorted descending. When the edge is
  // positive, at least one option lands within [0.1, 2] × Kelly. Adjacent
  // options must differ by a real ratio — four near-identical sizes teach
  // nothing — so candidate sets are resampled until they spread, relaxing the
  // ratio only when the bankroll is too small to allow it.
  function genChoices(kelly, bankroll, rng) {
    rng = rng || Math.random;
    const fMin = 0.005;
    const fMax = kelly > 0 ? clamp(2.8 * kelly, 0.15, 1) : 0.4;
    const cap = Math.floor(bankroll); // all-in allowed, never above bankroll

    const snap = (frac) => {
      const v = niceAmount(frac * bankroll);
      return v > cap ? niceFloor(cap) : v;
    };

    // ~1/6 of positive-edge rounds offer NO good size: every option lands
    // above 1× Kelly (often well above), so recognizing a bad menu and
    // passing — or grudgingly taking the smallest — is part of the game.
    // Decided once per round (not per spread retry, or retries filter it
    // out), and only when the above-Kelly range has room for four sizes.
    const ngLo = Math.min(1.2 * kelly, 0.85);
    const ngHi = Math.min(8 * kelly, 1);
    const noGoodMenu = kelly > 0 && ngHi / ngLo >= 2 && rng() < 1 / 6;

    const build = () => {
      const amounts = new Set();

      if (noGoodMenu) {
        let guard = 0;
        while (amounts.size < 4 && guard++ < 200) {
          const a = snap(logUniform(rng, ngLo, ngHi));
          if (a >= 1 && a / bankroll >= 1.05 * kelly) amounts.add(a);
        }
        for (const m of [1.5, 2.5, 4, 6]) {
          if (amounts.size >= 4) break;
          const a = Math.min(cap, Math.round(m * kelly * bankroll));
          if (a >= 1 && a / bankroll > kelly) amounts.add(a);
        }
        // last resort keeps four buttons even if it breaks the theme
        for (const f of [0.05, 0.15, 0.25, 0.4, 0.55, 0.7, 0.85, 1]) {
          if (amounts.size >= 4) break;
          const a = Math.min(cap, Math.max(1, Math.round(f * bankroll)));
          amounts.add(a);
        }
        return [...amounts].sort((x, y) => y - x).slice(0, 4);
      }

      // The guaranteed option is independent of the generic sampling range — a
      // tiny edge must still offer a correctly-sized token bet. It always sits
      // below 2× Kelly, and usually below 1× so an underbet is on the table.
      if (kelly > 0) {
        const pickInWindow = (hiM) => {
          const lo = Math.max(1, 0.1 * kelly * bankroll);
          const hi = Math.min(hiM * kelly * bankroll, cap);
          const candidates = niceAmountsInRange(lo, hi);
          if (candidates.length > 0) {
            return candidates[Math.floor(rng() * candidates.length)];
          }
          // No nice number fits — any whole dollar inside the window will do.
          const dLo = Math.ceil(lo);
          const dHi = Math.floor(hi);
          if (dHi >= dLo) return dLo + Math.floor(rng() * (dHi - dLo + 1));
          return null;
        };
        const hiMult = rng() < 0.6 ? 1 : 2;
        let picked = pickInWindow(hiMult);
        // dollar quantization can empty the below-1× window — widen to 2×
        if (picked === null && hiMult !== 2) picked = pickInWindow(2);
        if (picked !== null) amounts.add(picked);
      }

      // Most rounds plant a clear overbet at the top — and often a second one
      // right below it — so no fixed button rank ("always biggest", "always
      // second") is quietly near-optimal.
      if (kelly > 0) {
        if (rng() < 0.85) {
          const a = snap(Math.min(logUniform(rng, 2.2, 8) * kelly, 1));
          if (a >= 1) amounts.add(a);
        }
        if (rng() < 0.4) {
          const a = snap(Math.min(logUniform(rng, 2.2, 8) * kelly, 1));
          if (a >= 1) amounts.add(a);
        }
      }

      let guard = 0;
      while (amounts.size < 4 && guard++ < 200) {
        const a = snap(logUniform(rng, fMin, fMax));
        if (a >= 1) amounts.add(a);
      }
      // Tiny bankrolls can exhaust distinct nice values; pad with fixed fractions.
      for (const f of [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 1]) {
        if (amounts.size >= 4) break;
        const a = Math.min(cap, Math.round(f * bankroll));
        if (a >= 1) amounts.add(a);
      }

      return [...amounts].sort((a, b) => b - a).slice(0, 4);
    };

    const spreadOk = (c, minRatio) => {
      for (let i = 1; i < c.length; i++) {
        if (c[i - 1] / c[i] < minRatio) return false;
      }
      return true;
    };

    let best = null;
    for (const minRatio of [1.6, 1.35, 1.15]) {
      for (let attempt = 0; attempt < 30; attempt++) {
        const c = build();
        if (!best) best = c;
        if (spreadOk(c, minRatio)) return c;
      }
    }
    return best || build();
  }

  /* ---------- resolution & scoring ---------- */

  function resolve(round, betAmount, rng) {
    rng = rng || Math.random;
    if (betAmount <= 0) return { outcome: "pass", delta: 0 };
    const u = rng();
    if (u < round.p)
      return {
        outcome: "win",
        // whole dollars — the game never deals in cents
        delta: Math.max(1, Math.round(betAmount * round.b)),
      };
    if (u < round.p + round.q) return { outcome: "lose", delta: -betAmount };
    return { outcome: "push", delta: 0 };
  }

  // Kelly score = fraction bet / optimal fraction.
  // Negative-edge rounds: passing scores 0 (correct); betting gives a negative
  // ratio, which the histogram collects in the "<0" bucket.
  function kellyScore(fraction, kelly) {
    if (Math.abs(kelly) < 1e-12) return fraction > 0 ? Infinity : 0;
    return fraction / kelly;
  }

  // Histogram: "<−1", sixty 0.1-wide buckets over [−1, 5), and "≥5" —
  // negative scores (bets into a negative edge) get real resolution.
  function histogram(scores) {
    const buckets = new Array(62).fill(0); // [0]="<-1", [1..60]=[-1,5), [61]="≥5"
    for (const s of scores) {
      if (s < -1) buckets[0]++;
      else if (s >= 5) buckets[61]++;
      else buckets[1 + Math.floor((s + 1) / 0.1)]++;
    }
    return buckets;
  }

  return {
    niceAmount,
    niceAmountsInRange,
    roundOdds,
    toFraction,
    americanOdds,
    kellyFraction,
    sampleOdds,
    sampleTargetKelly,
    logUniform,
    genRound,
    genChoices,
    resolve,
    kellyScore,
    histogram,
  };
});
