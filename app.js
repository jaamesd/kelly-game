/* UI layer for the Kelly criterion simulator. Pure game math lives in kelly.js. */
(function () {
  "use strict";

  const K = window.Kelly;
  const STORAGE_KEY = "kelly-sim-v2";
  const START_BANKROLL = 1000;
  const ROUNDS_PER_GAME = 99;
  const ADVANCED_AFTER = 50;
  // reaching $1Q ends the game — you've beaten it
  const MAX_BANKROLL = 1e15;

  const $ = (id) => document.getElementById(id);

  /* ---------- formatting ---------- */

  // Whole dollars, abbreviated from $1k up: $850, $1.2k, $45k, $3.1M.
  function money(v) {
    if (!Number.isFinite(v)) return "—";
    const sign = v < 0 ? "−" : "";
    const abs = Math.abs(v);
    for (const [div, suf] of [
      [1e15, "Q"],
      [1e12, "T"],
      [1e9, "B"],
      [1e6, "M"],
      [1e3, "k"],
    ]) {
      if (abs >= div) {
        const n = abs / div;
        let s =
          n >= 99.95 ? String(Math.round(n)) : n.toFixed(n >= 9.995 ? 1 : 2);
        s = s.replace(/\.0+$|(\.\d*?)0+$/, "$1");
        // single-digit mantissas keep one decimal ($1.0k, not $1k) so
        // abbreviated figures sit visually even
        if (n < 9.995 && !s.includes(".")) s += ".0";
        return sign + "$" + s + suf;
      }
    }
    return sign + "$" + Math.round(abs);
  }

  function signedMoney(v) {
    return (v >= 0 ? "+" : "−") + money(Math.abs(v));
  }

  // Probabilities are on a 0.1% grid — show a decimal only when it's there.
  function pct(p) {
    const v = Math.round(p * 1000) / 10;
    return (Number.isInteger(v) ? v : v.toFixed(1)) + "%";
  }

  // decimal odds pair with decimal probabilities; every other format keeps %
  function probStr(p) {
    if (state.settings.odds === "decimal") {
      let s = (Math.round(p * 1000) / 1000).toFixed(3);
      if (s.endsWith("0")) s = s.slice(0, -1);
      return s;
    }
    return pct(p);
  }

  function scoreStr(s) {
    if (!Number.isFinite(s)) return "∞";
    return (Math.round(s * 100) / 100).toFixed(2);
  }

  /* ---------- state ---------- */

  const defaultSettings = {
    input: "mc",
    challenge: "auto",
    odds: "decimal",
    reveal: false,
  };

  // The common bookmaker conventions for the same net odds b.
  const ODDS_NAMES = {
    decimal: "decimal",
    fractional: "fractional",
    american: "american",
    ratio: "ratio",
    hongkong: "hong kong",
    indonesian: "indonesian",
    malay: "malay",
  };

  function fmtLabel(fmt) {
    const f = fmt || state.settings.odds;
    return (ODDS_NAMES[f] || f) + " odds";
  }

  const trimNum = (x) => String(Math.round(x * 100) / 100);

  function oddsMain(b, fmtOverride) {
    const fmt = fmtOverride || state.settings.odds;
    if (fmt === "fractional") {
      const [n, d] = K.toFraction(b);
      return n + "/" + d;
    }
    if (fmt === "american") {
      const a = K.americanOdds(b);
      return (a > 0 ? "+" : "−") + Math.abs(a);
    }
    if (fmt === "ratio") return trimNum(b) + " : 1";
    if (fmt === "hongkong") return b.toFixed(2);
    if (fmt === "indonesian")
      return b >= 1 ? b.toFixed(2) : "−" + (1 / b).toFixed(2);
    if (fmt === "malay")
      return b <= 1 ? b.toFixed(2) : "−" + (1 / b).toFixed(2);
    return (b + 1).toFixed(2);
  }

  // Terse, in the chosen convention's own vocabulary, always leading
  // with the win chance.
  function oddsHint(b, p) {
    const fmt = state.settings.odds;
    const chance = pct(p) + " chance of winning ";
    if (fmt === "fractional") {
      const [n, d] = K.toFraction(b);
      return chance + n + " per " + d + " staked";
    }
    if (fmt === "american") {
      const a = K.americanOdds(b);
      return a > 0
        ? chance + "$" + a + " per $100"
        : chance + "$100 per $" + -a + " staked";
    }
    if (fmt === "ratio" || fmt === "hongkong")
      return chance + trimNum(b) + " per 1 staked";
    if (fmt === "indonesian" || fmt === "malay") {
      // both quote favorites/underdogs from opposite ends of the same pair
      return b >= 1 === (fmt === "indonesian")
        ? chance + b.toFixed(2) + " per 1 staked"
        : chance + "1 per " + (1 / b).toFixed(2) + " staked";
    }
    return (
      probStr(p) + " chance of returning " + (b + 1).toFixed(2) + "× wagered"
    );
  }

  let state = {
    settings: { ...defaultSettings },
    game: null,
  };

  function freshGame() {
    return {
      bankroll: START_BANKROLL,
      maxRounds: ROUNDS_PER_GAME,
      history: [],
      phase: "playing", // "playing" | "ended"
      endReason: null, // "bust" | "complete" | "cashout" | "quad"
      cur: null, // { round, choices }
    };
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      /* private mode etc. — the game still works, it just won't survive reload */
    }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !parsed.game) return;
      if (
        typeof parsed.game.bankroll !== "number" ||
        !Array.isArray(parsed.game.history)
      )
        return;
      state = {
        settings: { ...defaultSettings, ...(parsed.settings || {}) },
        game: parsed.game,
      };
      if (
        !["auto", "easy", "medium", "hard"].includes(state.settings.challenge)
      )
        state.settings.challenge = "auto";
      if (!ODDS_NAMES[state.settings.odds]) state.settings.odds = "decimal";
    } catch (e) {
      /* corrupted save — start fresh */
    }
  }

  const roundNo = () => state.game.history.length + 1;

  // Default ramps the difficulty: easy → medium at 34, hard at 67.
  function roundMode(n) {
    const c = state.settings.challenge;
    if (c === "easy") return { negEdge: false, ternary: false };
    if (c === "medium") return { negEdge: true, ternary: false };
    if (c === "hard") return { negEdge: true, ternary: true };
    if (n <= 33) return { negEdge: false, ternary: false };
    if (n <= 66) return { negEdge: true, ternary: false };
    return { negEdge: true, ternary: true };
  }

  function tierName(m) {
    return m.ternary ? "Hard" : m.negEdge ? "Medium" : "Easy";
  }

  function genNext() {
    const g = state.game;
    const mode = roundMode(roundNo());
    const round = K.genRound(mode, Math.random);
    g.cur = {
      round,
      choices: K.genChoices(round.kelly, g.bankroll, Math.random),
    };
  }

  /* ---------- game flow ---------- */

  function placeBet(amountRaw) {
    const g = state.game;
    if (g.phase !== "playing" || !g.cur) return;
    const before = g.bankroll;
    const amount = Math.min(before, Math.max(0, Math.round(amountRaw)));
    const round = g.cur.round;
    const res = K.resolve(round, amount, Math.random);
    const after = before + res.delta;
    g.bankroll = after;
    g.history.push({
      n: roundNo() /* pushed below, so this is still the current round */,
      input: state.settings.input, // how the bet was placed — decides the ledger's Bet cell
      adv: round.advanced,
      b: round.b,
      p: round.p,
      q: round.q,
      push: round.push,
      before,
      bet: amount,
      choices: g.cur.choices,
      kelly: round.kelly,
      outcome: res.outcome,
      delta: res.delta,
      after,
    });
    // fix the round number recorded above (history.length changed under it)
    g.history[g.history.length - 1].n = g.history.length;
    g.cur = null;

    showOutcome(g.history[g.history.length - 1]);

    if (after < 1) {
      endGame("bust");
    } else if (after >= MAX_BANKROLL) {
      endGame("quad"); // $1Q — the game is beaten, no Continue offered
    } else if (g.history.length >= g.maxRounds) {
      endGame("complete");
    } else {
      genNext();
      render();
    }
    save();
  }

  function endGame(reason) {
    const g = state.game;
    g.phase = "ended";
    g.endReason = reason;
    g.cur = null;
    save();
    render();
  }

  function extendGame() {
    const g = state.game;
    g.maxRounds += ROUNDS_PER_GAME;
    g.phase = "playing";
    g.endReason = null;
    genNext();
    // the final round's pop may have been cut short when the board hid —
    // returning to the board must not replay it
    clearPop();
    save();
    render();
  }

  function newGame() {
    state.game = freshGame();
    genNext();
    clearPop();
    save();
    render();
  }

  /* ---------- game rendering ---------- */

  let flashTimer = 0;
  function flashBankroll(cls) {
    const el = $("bankroll");
    // a still-pending timer from the previous flash would strip this one early
    clearTimeout(flashTimer);
    el.classList.remove("flash-win", "flash-lose");
    if (cls) {
      void el.offsetWidth;
      el.classList.add(cls);
      flashTimer = setTimeout(() => el.classList.remove(cls), 700);
    }
  }

  // The pop is strictly one-shot: cleared by a timer that slightly outlives
  // the 1.5s animation (see pop-rise in the stylesheet). Animation events
  // can't do this job — a canceled animation's queued event would land just
  // after a rapid next bet restarts the pop, and wipe the fresh one.
  let popTimer = 0;
  function clearPop() {
    clearTimeout(popTimer);
    popTimer = 0;
    const pop = $("bankroll-pop");
    pop.className = "";
    pop.textContent = "";
  }

  // Big centered result pop: "+$180", "−$45", "push", "pass". The sign hangs
  // outside the centering so the amount itself sits mid-screen.
  function showOutcome(entry) {
    const pop = $("bankroll-pop");
    let text, cls;
    if (entry.outcome === "win") {
      text = signedMoney(entry.delta);
      cls = "win";
      flashBankroll("flash-win");
    } else if (entry.outcome === "lose") {
      text = signedMoney(entry.delta);
      cls = "lose";
      flashBankroll("flash-lose");
    } else if (entry.outcome === "push") {
      text = "push";
      cls = "push";
    } else {
      text = "pass";
      cls = "pass";
    }
    pop.textContent = "";
    if (text[0] === "+" || text[0] === "−") {
      const sign = document.createElement("span");
      sign.className = "pop-sign";
      sign.textContent = text[0];
      pop.append(sign, text.slice(1));
    } else {
      pop.textContent = text;
    }
    pop.className = cls;
    void pop.offsetWidth;
    pop.classList.add("animate");
    // a lingering .animate would replay whenever the board is hidden and
    // shown again (info toggle, Continue) — the timer runs even while hidden
    clearTimeout(popTimer);
    popTimer = setTimeout(clearPop, 1700);
  }

  /* ---------- ledger (shared by game view and results) ---------- */

  function chip(label, cls, title) {
    return (
      '<span class="chip' +
      (cls ? " " + cls : "") +
      '"' +
      (title ? ' title="' + title + '"' : "") +
      ">" +
      label +
      "</span>"
    );
  }

  // Break-even intercept: where the growth curve comes back through zero,
  // past the optimal fraction. Null when the curve never returns (or there
  // is no edge). Shared by the row tooltip and the coached bet slider.
  function breakEvenX(b, p, q, kelly) {
    const cap = 0.999; // f = 1 is ln(0) — stay just inside
    const growth = (x) => p * Math.log(1 + x * b) + q * Math.log(1 - x);
    if (!(kelly > 0) || growth(cap) >= 0) return null;
    let lo = kelly,
      hi = cap;
    for (let i = 0; i < 40; i++) {
      const m = (lo + hi) / 2;
      if (growth(m) >= 0) lo = m;
      else hi = m;
    }
    return (lo + hi) / 2;
  }

  // Row tooltip: the round's odds and probabilities over the calculator's
  // growth curve in miniature, with the actual menu marked on it.
  // Grammar matches the chips: blue fill = your pick, green ring = the best
  // option this round, green line + dot = the optimal fraction, red dot =
  // the break-even intercept. Available with coaching on or on results.
  function rowTipHtml(e) {
    const b = e.b,
      p = e.p,
      q = e.q;
    const growth = (x) => p * Math.log(1 + x * b) + q * Math.log(1 - x);
    const r = (x) => Math.expm1(growth(x));
    const kelly = e.kelly;
    const cap = 0.999; // f = 1 is ln(0) — clamp everything just inside
    const opts = rowOpts(e);
    const selected = e.bet > 0 ? e.bet : 0;
    const nearest = pickCand(e, null);
    const x0 = breakEvenX(b, p, q, kelly);

    // the x axis is ALWAYS 0–100% of bankroll — never scaled to the round —
    // so positions read the same in every row, on the slider, and in the
    // bet-line
    const xMax = cap;

    // plot area on top, a label band below it — every marked point drops a
    // vertical line into the band, where its label lives
    const W = 248,
      H = 142,
      padL = 10,
      padR = 14,
      padT = 10,
      plotB = 104;
    const bandY = [116, 126, 136]; // label tiers, top row first
    // the y window hugs the peak: past break-even the curve plunges toward
    // −100%, and autoscaling to that would flatten the region that matters.
    // Anything below the window rides the bottom edge — off the chart.
    const N = 120;
    let yMax = 1e-9;
    for (let i = 0; i <= N; i++) yMax = Math.max(yMax, r((i / N) * xMax));
    const yMin = -Math.max(2 * yMax, 0.08);
    const clampY = (y) => Math.max(yMin, y);
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const x = (i / N) * xMax;
      pts.push([x, clampY(r(x))]);
    }
    const X = (x) => padL + (x / xMax) * (W - padL - padR);
    const Y = (y) => padT + (1 - (y - yMin) / (yMax - yMin)) * (plotB - padT);
    const seg = (list) =>
      list
        .map(
          ([x, y], i) => (i ? "L" : "M") + X(x).toFixed(1) + "," + Y(y).toFixed(1),
        )
        .join("");
    const vlineAt = (cx, color, opacity) =>
      '<line x1="' +
      cx.toFixed(1) +
      '" x2="' +
      cx.toFixed(1) +
      '" y1="' +
      padT +
      '" y2="' +
      plotB +
      '" stroke="' +
      color +
      '" stroke-width="1" opacity="' +
      opacity +
      '"/>';

    // light grid — quartiles of the fixed 0–100% axis — then the zero
    // baseline over it
    let body = "";
    for (const gx of [0.25, 0.5, 0.75])
      body += vlineAt(X(gx), "var(--grid)", 1);
    const yStep = niceTickStep(yMax - yMin, 4);
    for (
      let gy = Math.ceil(yMin / yStep) * yStep;
      gy <= yMax + 1e-12;
      gy += yStep
    ) {
      if (Math.abs(gy) < 1e-12) continue;
      body +=
        '<line x1="' +
        padL +
        '" x2="' +
        (W - padR) +
        '" y1="' +
        Y(gy).toFixed(1) +
        '" y2="' +
        Y(gy).toFixed(1) +
        '" stroke="var(--grid)" stroke-width="1"/>';
    }
    body +=
      '<line x1="' +
      padL +
      '" x2="' +
      (W - padR) +
      '" y1="' +
      Y(0).toFixed(1) +
      '" y2="' +
      Y(0).toFixed(1) +
      '" stroke="var(--baseline)" stroke-width="1"/>';

    // markers, gathered so the band labels can dodge each other — the small
    // options cluster near x = 0 and would otherwise overprint.
    // fill paints the dot; color paints its line and label.
    const marks = [];
    const cand = (x, y, text, a) =>
      marks.push({
        x,
        y,
        text,
        amount: a,
        // fills take the dark infill blue; labels and lines keep the light one
        fill: a === selected ? "var(--accent-fill)" : "var(--muted)",
        color:
          a === selected
            ? "var(--accent)"
            : a === nearest
              ? "var(--good)"
              : "var(--muted)",
      });
    // pass sits at the left edge of a never-scaled axis — no label needed;
    // options are 1–4 ascending, o = optimal, i = intercept
    cand(0, 0, "", 0);
    for (let i = 0; i < opts.length; i++) {
      const f = Math.min(opts[i] / e.before, cap);
      cand(f, clampY(r(f)), String(i + 1), opts[i]);
    }
    // a slider bet isn't on the menu — its blue fill is its identity
    if (selected > 0 && !opts.includes(selected)) {
      const f = Math.min(selected / e.before, cap);
      cand(f, clampY(r(f)), "", selected);
    }
    if (x0 !== null && x0 <= xMax)
      marks.push({
        x: x0,
        y: 0,
        text: "i",
        amount: null,
        color: "var(--bad)",
      });
    if (kelly > 0 && kelly <= xMax)
      marks.push({
        x: kelly,
        y: r(kelly), // green dot on the curve's peak, plus the full line
        text: "o",
        amount: null,
        color: "var(--good)",
      });

    // each point's vertical line, under the curve
    for (const m of marks)
      body += vlineAt(X(m.x), m.color, m.color === "var(--good)" ? 1 : 0.45);

    // accent while compounding, red past the intercept — same as the calculator
    const stroke = (d, color) =>
      '<path d="' +
      d +
      '" fill="none" stroke="' +
      color +
      '" stroke-width="1.5"/>';
    if (kelly <= 0) {
      body += stroke(seg(pts), "var(--bad)");
    } else {
      const beforeX0 = pts.filter(([x]) => x0 === null || x <= x0);
      if (x0 !== null) beforeX0.push([x0, 0]);
      body += stroke(seg(beforeX0), "var(--accent)");
      if (x0 !== null)
        body += stroke(
          seg([[x0, 0]].concat(pts.filter(([x]) => x > x0))),
          "var(--bad)",
        );
    }

    // dots over the curve, labels in the band below the plot
    marks.sort((m1, m2) => m1.x - m2.x);
    const lastRight = bandY.map(() => -Infinity);
    for (const m of marks) {
      const cx = X(m.x);
      if (m.y !== null) {
        const cy = Y(m.y);
        // green ring marks the best option; your pick is the filled dot
        if (m.amount !== null && m.amount === nearest)
          body +=
            '<circle cx="' +
            cx.toFixed(1) +
            '" cy="' +
            cy.toFixed(1) +
            '" r="5.4" fill="none" stroke="var(--good)" stroke-width="1.3"/>';
        body +=
          '<circle cx="' +
          cx.toFixed(1) +
          '" cy="' +
          cy.toFixed(1) +
          '" r="3" fill="' +
          (m.fill || m.color) +
          '" stroke="var(--surface)" stroke-width="1.2"/>';
      }
      if (!m.text) continue; // unlabeled marks (pass, slider bets)
      const half = (m.text.length * 5.5) / 2;
      const lx = Math.min(Math.max(cx, padL + half), W - padR + 8 - half);
      let tier = 0;
      for (let t = 0; t < bandY.length; t++) {
        tier = t;
        if (lx - half > lastRight[t] + 4) break;
      }
      lastRight[tier] = lx + half;
      body +=
        '<text x="' +
        lx.toFixed(1) +
        '" y="' +
        bandY[tier] +
        '" text-anchor="middle" font-size="9" fill="' +
        m.color +
        '">' +
        m.text +
        "</text>";
    }

    const probs =
      "win " +
      probStr(p) +
      " · lose " +
      probStr(q) +
      (e.push > 0.0005 ? " · push " + probStr(e.push) : "");
    return (
      tipHtml(oddsMain(b) + " " + fmtLabel(), [probs]) +
      '<svg width="' +
      W +
      '" height="' +
      H +
      '" viewBox="0 0 ' +
      W +
      " " +
      H +
      '" style="display:block;margin-top:4px">' +
      body +
      "</svg>"
    );
  }

  // one tooltip per data row; `entries` is aligned to the tbody's row order,
  // with null for the opening-balance row
  function bindLedgerTips(tableId, entries) {
    $(tableId)
      .querySelectorAll("tbody tr")
      .forEach((tr, i) => {
        const e = entries[i];
        if (e) bindTip(tr, () => rowTipHtml(e));
      });
  }

  // One row per round: the full five-chip menu on wide tables; narrow
  // tables keep only two via CSS — the pick (.sel) and the closest OTHER
  // candidate to 0.9× Kelly, pass included, ties to the lower wager (.alt).
  // With coaching the overall closest candidate gets the outline (.best).
  // Chip count never depends on coaching, so toggling it never reflows.
  // menu options in ascending order — the ledger, the tooltip labels, and
  // the buttons all read smallest → largest (genChoices returns descending;
  // stored games may hold either, so sort at presentation)
  function rowOpts(e) {
    const o = Array.isArray(e.choices)
      ? e.choices.slice()
      : e.bet > 0
        ? [e.bet]
        : [];
    return o.sort((x, y) => x - y);
  }

  // The best option this round: the candidate (pass included) with the
  // highest expected growth — but a bigger wager only displaces a smaller
  // one by winning clearly, at least 10% of the optimal growth; near-equal
  // growth prefers the lower stake. With no edge, pass wins and bets rank
  // by size. The chip outline and the row tooltip agree on this pick.
  function pickCand(e, excl) {
    const g = (x) => e.p * Math.log(1 + x * e.b) + e.q * Math.log(1 - x);
    const margin = e.kelly > 0 ? 0.1 * g(e.kelly) : 0;
    let best = null;
    let bestG = 0;
    for (const a of rowOpts(e)
      .concat(0)
      .sort((x, y) => x - y)) {
      if (excl !== null && a === excl) continue;
      const ga =
        e.kelly > 0
          ? g(Math.min(a / e.before, 0.999))
          : a === 0
            ? 0
            : -(1e9 + a);
      if (best === null || ga > bestG + margin) {
        best = a;
        bestG = ga;
      }
    }
    return best;
  }

  // A continuous bet has no menu to show — its Bet cell is the slider in
  // miniature: a grey line, your bet as a blue dot, and (with coaching or on
  // the results page) a green dot at the optimal fraction and a red one at
  // break-even. Domain is 0–100% of that round's bankroll, like the slider.
  function betLine(e, coaching) {
    const at = (f) => Math.min(100, Math.max(0, f * 100)).toFixed(1) + "%";
    let dots = "";
    if (coaching) {
      dots +=
        '<span class="bl-dot opt" style="left:' +
        at(Math.max(e.kelly, 0)) +
        '"></span>';
      const x0 = breakEvenX(e.b, e.p, e.q, e.kelly);
      if (x0 !== null)
        dots += '<span class="bl-dot x0" style="left:' + at(x0) + '"></span>';
    }
    // the bet last, so it sits on top when positions coincide
    dots +=
      '<span class="bl-dot bet" style="left:' +
      at(e.before > 0 ? e.bet / e.before : 0) +
      '"></span>';
    return '<span class="bet-line">' + dots + "</span>";
  }

  function ledgerRow(e, coaching) {
    const opts = rowOpts(e);
    const selected = e.bet > 0 ? e.bet : 0;
    const best = pickCand(e, null);
    const alt = pickCand(e, selected);
    // the smallest option that loses money in expectation wears the red
    // outline — everything above it is past the same threshold, so one mark
    // is enough. Coaching-gated, like .best.
    const gRow = (x) => e.p * Math.log(1 + x * e.b) + e.q * Math.log(1 - x);
    const firstNeg = opts.find(
      (a) => gRow(Math.min(a / e.before, 0.999)) < 0,
    );
    const clsFor = (a) =>
      [
        a === selected ? "sel" : "",
        coaching && a === best ? "best" : "",
        coaching && a === firstNeg ? "neg" : "",
        a === alt ? "alt" : "",
      ]
        .filter(Boolean)
        .join(" ");
    // no native title attributes here — the row's hover tooltip carries the
    // odds, probabilities, and the growth curve, and the two would collide.
    // pass leads, stakes ascend — the row reads like the tooltip's axis.
    let chips = "";
    if (e.input === "slider") {
      chips = betLine(e, coaching);
    } else {
      chips = chip("pass", clsFor(0));
      for (const a of opts) chips += chip(money(a), clsFor(a));
    }

    // expected return per $1 staked — a push hands the stake back, so the
    // binary form covers ternary rounds too. Negative edges read red: the
    // trap rounds are exactly what this column is for.
    // Decimal odds pair with fixed-width decimals (the point aligns down the
    // column); every other format rounds to the nearest percent.
    const ev = e.p * e.b - e.q;
    const dec = state.settings.odds === "decimal";
    const evStr = dec
      ? (ev < 0 ? "−" : "+") + Math.abs(ev).toFixed(3)
      : (ev < 0 ? "−" : "+") + Math.round(Math.abs(ev) * 100) + "%";
    const riskStr = dec ? e.q.toFixed(3) : Math.round(e.q * 100) + "%";
    const cells = [
      "<td>" + e.n + "</td>",
      '<td class="' +
        (ev < 0 ? "lose" : ev > 0 ? "win" : "dim") +
        '">' +
        evStr +
        "</td>",
      '<td class="dim">' + riskStr + "</td>",
      '<td class="opts">' + chips + "</td>",
      "<td>" + (coaching ? scoreStr(scoreOf(e)) : "") + "</td>",
    ];
    cells.push(
      e.outcome === "win"
        ? '<td class="win">+' + money(e.delta) + "</td>"
        : e.outcome === "lose"
          ? '<td class="lose">−' + money(-e.delta) + "</td>"
          : e.outcome === "push"
            ? '<td class="dim">push</td>'
            : '<td class="dim">—</td>',
    );
    cells.push("<td>" + money(e.after) + "</td>");
    return "<tr>" + cells.join("") + "</tr>";
  }

  function ledgerHead(coaching) {
    return (
      '<tr><th class="c-n">#</th>' +
      '<th class="c-ev" title="expected return per $1 staked">EV</th>' +
      '<th class="c-risk" title="chance of losing the stake">Risk</th>' +
      '<th class="c-opts">Bet</th>' +
      '<th class="c-k" title="your bet ÷ the Kelly bet">' +
      (coaching ? "k" : "") +
      "</th>" +
      '<th class="c-money">Result</th><th class="c-money">Balance</th></tr>'
    );
  }

  // row #0 is the opening balance — the ledger is always on the page
  function zeroRow() {
    return (
      '<tr><td class="dim">0</td><td></td><td></td><td class="opts"></td>' +
      "<td></td><td></td><td>" +
      money(START_BANKROLL) +
      "</td></tr>"
    );
  }

  function renderGameLedger() {
    const coaching = state.settings.reveal;
    const rows = state.game.history.slice().reverse();
    $("ledger-game").querySelector("thead").innerHTML = ledgerHead(coaching);
    $("ledger-game").querySelector("tbody").innerHTML =
      rows.map((e) => ledgerRow(e, coaching)).join("") + zeroRow();
    // mid-game, the curve tooltip is a coaching feature — it reveals the
    // optimal fraction and the traps
    if (coaching) bindLedgerTips("ledger-game", rows);
  }

  function renderGame() {
    const g = state.game;
    const cur = g.cur;

    $("bankroll-num").textContent = money(g.bankroll);
    $("mode-tag").textContent = tierName(roundMode(roundNo()));
    // the sole header action — inert until there is a game to end
    $("end-now").disabled = g.history.length === 0;

    if (!cur) return;
    const r = cur.round;
    $("round-label").textContent = roundNo() + "/" + g.maxRounds;
    $("odds-line").textContent = oddsMain(r.b);
    $("odds-label").textContent = fmtLabel();
    $("win-num").textContent = probStr(r.p);
    $("lose-num").textContent = probStr(r.q);
    $("push-num").classList.toggle("hidden", !r.advanced);
    $("push-label").classList.toggle("hidden", !r.advanced);
    if (r.advanced) $("push-num").textContent = probStr(r.push);
    // with coaching, the proposition line carries its own verdict — the
    // edge in the same delta form as the history's EV column (decimal) or
    // as a percent advantage elsewhere
    let hint = oddsHint(r.b, r.p);
    if (state.settings.reveal) {
      const edge = r.p * r.b - r.q;
      hint +=
        state.settings.odds === "decimal"
          ? ", " + (edge < 0 ? "−" : "+") + Math.abs(edge).toFixed(3) + " EV"
          : ", " + (edge < 0 ? "−" : "") + pct(Math.abs(edge)) + " advantage";
    }
    $("payout-hint").textContent = hint;
    // deliberate mid-round peek: hover the odds to see the Kelly bet
    $("odds-line").title =
      "1× " + (r.kelly > 0 ? money(r.kelly * g.bankroll) : "pass");

    // betting controls
    const mc = state.settings.input === "mc";
    $("mc-controls").classList.toggle("hidden", !mc);
    $("slider-controls").classList.toggle("hidden", mc);

    if (mc) {
      const box = $("choice-buttons");
      box.textContent = "";
      const addBet = (amount, sub) => {
        const btn = document.createElement("button");
        btn.className = "bet";
        btn.innerHTML =
          '<span class="amt">' +
          (amount > 0 ? money(amount) : "Pass") +
          '</span><span class="frac">' +
          sub +
          "</span>";
        btn.addEventListener("click", () => placeBet(amount));
        box.appendChild(btn);
      };
      // smallest first — keys 1–4 map to stakes ascending, keypad-style
      const ordered = cur.choices.slice().sort((a, b) => a - b);
      ordered.forEach((amount, i) => {
        const fracPct = (amount / g.bankroll) * 100;
        addBet(
          amount,
          "bet " +
            (fracPct >= 10
              ? Math.round(fracPct)
              : fracPct >= 1
                ? fracPct.toFixed(1)
                : fracPct.toFixed(2)) +
            "%",
        );
      });
      addBet(0, "no bet");
    } else {
      syncSlider();
    }
    renderGameLedger();
  }

  /* ---------- slider (bips under the hood, shown as percent) ---------- */

  // Typed digits are big-endian percent: "9" → 90%, "25" → 25%, "125" → 12.5%.
  let bipsTyped = "";

  function sliderBips() {
    return Math.max(0, Math.min(10000, Number($("bips-slider").value) || 0));
  }

  function sliderAmount() {
    return Math.round(state.game.bankroll * (sliderBips() / 10000));
  }

  function pctStr(bips) {
    return (bips / 100).toFixed(2) + "%";
  }

  function syncSlider() {
    const slider = $("bips-slider");
    const bips = sliderBips();
    slider.style.setProperty("--fill", bips / 100 + "%");
    $("bips-pct").textContent = pctStr(bips);
    $("slider-amount").textContent = money(sliderAmount());
  }

  function applyTyped() {
    const bips = bipsTyped
      ? Math.min(10000, Number(bipsTyped.padEnd(4, "0")))
      : 0;
    $("bips-slider").value = bips;
    syncSlider();
  }

  /* ---------- keyboard control ---------- */

  // flash the button so a key press visibly lands on it before it fires
  let keyPressPending = false;
  function pressButton(btn) {
    if (!btn || keyPressPending) return;
    keyPressPending = true;
    btn.classList.add("pressed");
    setTimeout(() => {
      keyPressPending = false;
      btn.click();
    }, 110);
  }

  function handleKey(ev) {
    if (!$("info-view").classList.contains("hidden")) return;
    if (state.game.phase !== "playing" || !state.game.cur) return;
    const t = ev.target;
    if (
      t &&
      t.tagName === "INPUT" &&
      (t.type === "number" || t.type === "text")
    )
      return;
    const mc = state.settings.input === "mc";
    if (mc) {
      if (ev.key >= "1" && ev.key <= "4") {
        pressButton($("choice-buttons").children[Number(ev.key) - 1]);
      } else if (ev.key === "0") {
        pressButton($("choice-buttons").children[4]);
      }
      return;
    }
    if (ev.key >= "0" && ev.key <= "9") {
      if (bipsTyped.length < 4) bipsTyped += ev.key;
      applyTyped();
    } else if (ev.key === "Backspace") {
      bipsTyped = bipsTyped.slice(0, -1);
      applyTyped();
      ev.preventDefault();
    } else if (ev.key === "Enter") {
      const amount = sliderAmount();
      bipsTyped = "";
      placeBet(amount);
    } else if (ev.key.startsWith("Arrow")) {
      // arrows walk whole percents, from the nearest whole percent
      const dir = ev.key === "ArrowLeft" || ev.key === "ArrowDown" ? -1 : 1;
      const next = Math.max(
        0,
        Math.min(10000, (Math.round(sliderBips() / 100) + dir) * 100),
      );
      $("bips-slider").value = next;
      bipsTyped = "";
      syncSlider();
      ev.preventDefault();
    }
  }

  /* ---------- results ---------- */

  function scoreOf(e) {
    return K.kellyScore(e.before > 0 ? e.bet / e.before : 0, e.kelly);
  }

  function renderResults() {
    const g = state.game;
    const h = g.history;

    $("final-bankroll").textContent = money(g.bankroll);

    const wins = h.filter((e) => e.outcome === "win");
    const losses = h.filter((e) => e.outcome === "lose");
    // zero-edge bets score k = ∞ — average only the finite scores
    const avgK = (list) => {
      const ks = list.map(scoreOf).filter(Number.isFinite);
      return ks.length
        ? scoreStr(ks.reduce((a, b) => a + b, 0) / ks.length)
        : "–";
    };
    $("stat-sumwin").textContent = money(wins.reduce((s, e) => s + e.delta, 0));
    $("stat-avgkwin").textContent = avgK(wins);
    $("stat-largestwin").textContent = wins.length
      ? money(Math.max(...wins.map((e) => e.delta)))
      : "–";
    $("stat-roundswon").textContent = wins.length + "/" + h.length;
    $("stat-sumloss").textContent = money(
      losses.reduce((s, e) => s - e.delta, 0),
    );
    $("stat-avgkloss").textContent = avgK(losses);
    $("stat-largestloss").textContent = losses.length
      ? money(Math.max(...losses.map((e) => -e.delta)))
      : "–";
    $("stat-roundslost").textContent = losses.length + "/" + h.length;

    // streaks run over bet outcomes only — passes and pushes don't break them
    let sw = 0,
      sl = 0,
      cw = 0,
      cl = 0;
    for (const e of h) {
      if (e.outcome === "win") {
        cw++;
        cl = 0;
      } else if (e.outcome === "lose") {
        cl++;
        cw = 0;
      } else continue;
      sw = Math.max(sw, cw);
      sl = Math.max(sl, cl);
    }
    $("stat-streakwin").textContent = String(sw);
    $("stat-streakloss").textContent = String(sl);

    const scores = h.map(scoreOf);
    const finite = scores.filter(Number.isFinite).sort((a, b) => a - b);
    $("stat-median").textContent = finite.length
      ? scoreStr(finite[Math.floor(finite.length / 2)])
      : "–";

    $("extend").classList.toggle("hidden", g.endReason !== "complete");

    renderHistogram();
    renderTable();
    mcEnsure();
  }

  /* ---------- outcome distribution (live monte carlo replay) ---------- */

  let mcMode = "chosen";
  let mc = null;
  const MC_CAP = 40000;

  function mcToken() {
    const g = state.game;
    return g.history.length + ":" + g.bankroll + ":" + (g.endReason || "");
  }

  // The axis is computed, not observed: each round's log-return is a discrete
  // random variable, so the sum's mean and variance are exact. μ ± 3.5σ covers
  // the distribution from the first sample — the chart never rescales.
  function mcRange(rounds, key, ev, user) {
    let mu = 0;
    let varSum = 0;
    for (const r of rounds) {
      const f = Math.min(key === "chosen" ? r.fc : r.fo, 0.999);
      if (f <= 0) continue;
      const up = Math.log1p(f * r.b);
      const down = Math.log1p(-f);
      const m = r.p * up + r.q * down;
      mu += m;
      varSum += Math.max(0, r.p * up * up + r.q * down * down - m * m);
    }
    const mid = (Math.log(START_BANKROLL) + mu) / Math.LN10;
    const half = (3.5 * Math.sqrt(varSum)) / Math.LN10;
    let l0 = mid - half;
    let l1 = mid + half;
    // the axis must always contain the EV line, your result, and the buy-in
    for (const v of [ev, user, START_BANKROLL]) {
      if (v >= 1) {
        l0 = Math.min(l0, Math.log10(v));
        l1 = Math.max(l1, Math.log10(v));
      }
    }
    // snap out to whole decades so every tick is a power of ten
    l0 = Math.max(0, Math.floor(l0));
    l1 = Math.max(l0 + 1, Math.ceil(l1));
    const perDecade = Math.max(3, Math.min(12, Math.round(72 / (l1 - l0))));
    return { l0, l1, NB: (l1 - l0) * perDecade };
  }

  function mcSetup() {
    const token = mcToken();
    if (mc && mc.token === token) return;
    if (mc && mc.timer) clearTimeout(mc.timer);
    const rounds = state.game.history.map((e) => ({
      b: e.b,
      p: e.p,
      q: e.q,
      fc: e.before > 0 && e.bet > 0 ? e.bet / e.before : 0,
      fo: Math.min(Math.max(e.kelly, 0), 0.99),
    }));
    // serial EV: expectations multiply round over round
    const ev = {};
    for (const key of ["chosen", "optimal"]) {
      let v = START_BANKROLL;
      for (const r of rounds)
        v *= 1 + (key === "chosen" ? r.fc : r.fo) * (r.p * r.b - r.q);
      ev[key] = v;
    }
    const user = state.game.bankroll;
    mc = { token, rounds, user, ev, acc: {}, built: {}, timer: 0 };
    // samples are bucketed as they are generated and never retained —
    // rendering stays O(buckets) no matter how many replays have run
    for (const key of ["chosen", "optimal"]) {
      const range = mcRange(rounds, key, ev[key], user);
      mc.acc[key] = {
        n: 0,
        busts: 0,
        behind: 0, // replays that finished strictly below your result
        buckets: new Int32Array(range.NB),
        l0: range.l0,
        l1: range.l1,
        NB: range.NB,
      };
    }
  }

  function mcBatch(count) {
    const a = mc.acc[mcMode];
    const scale = a.NB / (a.l1 - a.l0);
    for (let s = 0; s < count; s++) {
      let bank = START_BANKROLL;
      for (const r of mc.rounds) {
        const f = mcMode === "chosen" ? r.fc : r.fo;
        if (f > 0) {
          const u = Math.random();
          if (u < r.p) bank *= 1 + f * r.b;
          else if (u < r.p + r.q) bank *= 1 - f;
          if (bank < 1) {
            bank = 0;
            break;
          }
        }
      }
      a.n++;
      if (bank < mc.user) a.behind++;
      if (bank < 1) {
        a.busts++;
        continue;
      }
      let i = Math.floor((Math.log10(bank) - a.l0) * scale);
      if (i < 0) i = 0;
      else if (i >= a.NB) i = a.NB - 1;
      a.buckets[i]++;
    }
  }

  function mcTick() {
    if (!mc || $("results-view").classList.contains("hidden")) {
      if (mc) mc.timer = 0;
      return;
    }
    const a = mc.acc[mcMode];
    if (a.n < MC_CAP) {
      mcBatch(a.n < 2000 ? 400 : 2000);
      // keep simulating through a scroll, but don't compete with it for frames
      if (!scrollBusy) renderMC();
      mc.timer = setTimeout(mcTick, 120);
    } else {
      mc.timer = 0;
      renderMC();
    }
  }

  function mcEnsure() {
    mcSetup();
    renderMC();
    if (!mc.timer && mc.acc[mcMode].n < MC_CAP)
      mc.timer = setTimeout(mcTick, 30);
  }

  // scroll guard: a passive listener flips a flag while the page is moving
  let scrollBusy = false;
  let scrollIdleTimer = 0;
  window.addEventListener(
    "scroll",
    () => {
      scrollBusy = true;
      clearTimeout(scrollIdleTimer);
      scrollIdleTimer = setTimeout(() => {
        scrollBusy = false;
      }, 120);
    },
    { passive: true, capture: true },
  );

  // Build the SVG once per (mode, width): the axis is frozen, so the ticks,
  // markers, and hit targets never change — each tick only mutates bar heights.
  function mcBuild() {
    const container = $("mc-container");
    const key = mcMode;
    const a = mc.acc[key];
    const user = mc.user;
    const ev = mc.ev[key];

    const avail = Math.max(280, container.clientWidth || 694);
    const padL = 12,
      padR = 12,
      padT = 22,
      padB = 30,
      plotH = 140;
    const width = avail;
    const height = padT + plotH + padB;
    const baseY = padT + plotH;
    const bustW = 26; // reserved lane on the left for busts

    const x0 = padL + bustW + 10,
      x1 = width - padR;
    const X = (v) =>
      x0 + ((Math.log10(Math.max(v, 1)) - a.l0) / (a.l1 - a.l0)) * (x1 - x0);

    const svg = svgEl("svg", {
      width,
      height,
      viewBox: "0 0 " + width + " " + height,
      role: "img",
      "aria-label": "Distribution of replayed final balances",
    });
    svg.style.display = "block";

    // baseline + power-of-ten ticks — the range is whole decades, so every
    // tick lands exactly and the labels never move
    svgEl(
      "line",
      {
        x1: padL,
        x2: width - padR,
        y1: baseY,
        y2: baseY,
        stroke: "var(--baseline)",
        "stroke-width": 1,
      },
      svg,
    );
    // wide ranges get more decades than the width has room to label —
    // every decade keeps its tick, labels thin out to a collision-free stride
    const labelStride = Math.max(
      1,
      Math.ceil(((a.l1 - a.l0 + 1) * 42) / (x1 - x0)),
    );
    for (let d = a.l0; d <= a.l1; d++) {
      const x = X(Math.pow(10, d));
      svgEl(
        "line",
        {
          x1: x,
          x2: x,
          y1: baseY,
          y2: baseY + 4,
          stroke: "var(--baseline)",
          "stroke-width": 1,
        },
        svg,
      );
      if ((d - a.l0) % labelStride) continue;
      const t = svgEl(
        "text",
        {
          x,
          y: baseY + 16,
          // the outermost label would clip at the svg edge — anchor it inward
          "text-anchor": x > width - 24 ? "end" : "middle",
          "font-size": 10.5,
          fill: "var(--muted)",
        },
        svg,
      );
      t.textContent = money(Math.pow(10, d));
    }

    const barW = (x1 - x0) / a.NB;
    const bars = [];
    for (let i = 0; i < a.NB; i++) {
      bars.push(
        svgEl(
          "rect",
          {
            x: x0 + i * barW,
            y: baseY,
            width: Math.max(barW - 0.5, 0.8),
            height: 0,
            fill: "var(--accent)",
            opacity: 0.85,
          },
          svg,
        ),
      );
    }
    // the bust lane ($0) is always on the axis, even when nothing landed there
    const zeroT = svgEl(
      "text",
      {
        x: padL + (bustW - 8) / 2,
        y: baseY + 16,
        "text-anchor": "middle",
        "font-size": 10.5,
        fill: "var(--muted)",
      },
      svg,
    );
    zeroT.textContent = "$0";
    const bustBar = svgEl(
      "rect",
      {
        x: padL,
        y: baseY,
        width: bustW - 8,
        height: 0,
        fill: "var(--bad)",
        opacity: 0.85,
      },
      svg,
    );

    const betsName = key === "chosen" ? "your own bets" : "exact Kelly bets";
    // when the two marker lines run close, their labels split outward
    // instead of overprinting each other
    const close = user >= 1 && Math.abs(X(ev) - X(user)) < 30;
    const vline = (v, color, label, anchor, tip) => {
      const x = X(v);
      svgEl(
        "line",
        {
          x1: x,
          x2: x,
          y1: padT - 8,
          y2: baseY,
          stroke: color,
          "stroke-width": 1.5,
        },
        svg,
      );
      const t = svgEl(
        "text",
        {
          x: x + (anchor === "start" ? 3 : anchor === "end" ? -3 : 0),
          y: padT - 12,
          "text-anchor": anchor,
          "font-size": 10.5,
          fill: color,
        },
        svg,
      );
      t.textContent = label;
      const hit = svgEl(
        "rect",
        {
          x: x - 7,
          y: padT - 20,
          width: 14,
          height: plotH + 20,
          fill: "transparent",
        },
        svg,
      );
      bindTip(hit, tip);
    };
    const evSide = close ? (X(ev) >= X(user) ? "start" : "end") : "middle";
    const youSide = close ? (X(ev) >= X(user) ? "end" : "start") : "middle";
    vline(ev, "var(--muted)", "EV", evSide, () =>
      tipHtml("Serial EV " + money(ev), [
        "each round's expected return, compounded",
      ]),
    );
    if (user >= 1)
      vline(user, "var(--ink)", "you", youSide, () => {
        const acc = mc.acc[key];
        return tipHtml("You — " + money(user), [
          acc.n
            ? "ahead of " +
              Math.round((acc.behind / acc.n) * 100) +
              "% of replays"
            : "simulating…",
        ]);
      });

    // hover/tap layer: one full-height target per bucket, reading live counts
    const bLo = (i) => Math.pow(10, a.l0 + (i / a.NB) * (a.l1 - a.l0));
    for (let i = 0; i < a.NB; i++) {
      const hit = svgEl(
        "rect",
        {
          x: x0 + i * barW,
          y: padT,
          width: barW,
          height: plotH,
          fill: "transparent",
        },
        svg,
      );
      bindTip(hit, () => {
        const acc = mc.acc[key];
        if (!acc.n || !acc.buckets[i]) return null;
        let cum = acc.busts;
        for (let j = 0; j <= i; j++) cum += acc.buckets[j];
        return tipHtml(money(bLo(i)) + " – " + money(bLo(i + 1)), [
          acc.buckets[i].toLocaleString("en-US") +
            " replays · " +
            pctShare(acc.buckets[i], acc.n),
          '<span class="dim">' +
            Math.round((cum / acc.n) * 100) +
            "% ended at or below " +
            money(bLo(i + 1)) +
            "</span>",
        ]);
      });
    }
    const bustHit = svgEl(
      "rect",
      {
        x: padL,
        y: padT,
        width: bustW - 8,
        height: plotH,
        fill: "transparent",
      },
      svg,
    );
    bindTip(bustHit, () => {
      const acc = mc.acc[key];
      if (!acc.n || !acc.busts) return null;
      return tipHtml("$0 — busted", [
        acc.busts.toLocaleString("en-US") +
          " replays · " +
          pctShare(acc.busts, acc.n),
      ]);
    });

    container.textContent = "";
    container.appendChild(svg);
    mc.built[key] = { bars, bustBar, baseY, plotH, width: avail };
    return mc.built[key];
  }

  function renderMC() {
    if (!mc) return;
    const note = $("mc-note");
    const a = mc.acc[mcMode];
    const built = mc.built[mcMode] || mcBuild();
    if (!a.n) {
      note.textContent = "Simulating…";
      return;
    }

    // bar heights normalize against a quantized ceiling ({1,2,5}×10ᵏ of the
    // peak share) so they converge instead of creeping every tick
    let maxFrac = a.busts / a.n;
    for (let i = 0; i < a.NB; i++)
      if (a.buckets[i] > maxFrac * a.n) maxFrac = a.buckets[i] / a.n;
    const ceil = niceTickStep(Math.max(maxFrac, 1e-9), 1);
    const setBar = (rect, count) => {
      const h = count
        ? Math.max(1.5, (count / a.n / ceil) * built.plotH)
        : 0;
      rect.setAttribute("y", built.baseY - h);
      rect.setAttribute("height", h);
    };
    for (let i = 0; i < a.NB; i++) setBar(built.bars[i], a.buckets[i]);
    setBar(built.bustBar, a.busts);

    const betsName = mcMode === "chosen" ? "your own bets" : "exact Kelly bets";
    const nStr = a.n.toLocaleString("en-US");
    const evStr = money(mc.ev[mcMode]);
    note.textContent =
      mc.user >= 1
        ? "Your " +
          money(mc.user) +
          " finished ahead of " +
          Math.round((a.behind / a.n) * 100) +
          "% of " +
          nStr +
          " replays of " +
          betsName +
          ". Serial EV is " +
          evStr +
          "."
        : "You busted. " +
          Math.round((a.busts / a.n) * 100) +
          "% of " +
          nStr +
          " replays of " +
          betsName +
          " also ended at $0. Serial EV is " +
          evStr +
          ".";
  }

  /* ---------- tooltips (shared by every chart) ---------- */

  function tipHtml(title, rows) {
    return (
      '<div class="tip-t">' +
      title +
      "</div>" +
      rows.map((r) => '<div class="tip-r">' + r + "</div>").join("")
    );
  }

  function pctShare(c, t) {
    const p = t > 0 ? (c / t) * 100 : 0;
    return (p >= 9.95 ? Math.round(p) : p.toFixed(1)) + "%";
  }

  function showTip(html, cx, cy) {
    const tip = $("tooltip");
    tip.innerHTML = html;
    tip.style.display = "block";
    const pad = 12;
    const tw = tip.offsetWidth,
      th = tip.offsetHeight;
    let left = cx + pad;
    if (left + tw > innerWidth - 8) left = cx - tw - pad;
    left = Math.max(8, left);
    // above the pointer by default; flip below when it would clip the top
    let top = cy - th - 14;
    if (top < 8) top = cy + 18;
    top = Math.min(top, innerHeight - th - 8);
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }

  function hideTip() {
    $("tooltip").style.display = "none";
  }
  window.addEventListener("scroll", hideTip, { passive: true, capture: true });

  // Pointer events cover mouse and touch with one wiring: mouse reads on
  // hover; touch reads while pressed and releases cleanly on lift — nothing
  // sticks. content(ev) returns html, or null for "nothing here".
  function bindTip(el, content) {
    const show = (ev) => {
      const html = content(ev);
      if (html) showTip(html, ev.clientX, ev.clientY);
      else hideTip();
    };
    el.addEventListener("pointermove", show);
    el.addEventListener("pointerdown", show);
    el.addEventListener("pointerleave", hideTip);
    el.addEventListener("pointercancel", hideTip);
    el.addEventListener("pointerup", (ev) => {
      if (ev.pointerType !== "mouse") hideTip();
    });
  }

  /* ---------- histogram (inline SVG) ---------- */

  let histMode = "event"; // event = round counts · value = $ · perf = growth
  let histResizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(histResizeTimer);
    histResizeTimer = setTimeout(() => {
      if ($("results-view").classList.contains("hidden")) return;
      renderHistogram();
      // the outcome chart's cached SVG is width-specific — rebuild it
      if (mc) {
        mc.built = {};
        renderMC();
      }
    }, 150);
  });

  const SVG_NS = "http://www.w3.org/2000/svg";

  function svgEl(name, attrs, parent) {
    const el = document.createElementNS(SVG_NS, name);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  }

  function niceTickStep(max, target) {
    const raw = max / target;
    const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
    for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
    return 10 * pow;
  }

  function bucketLabel(i) {
    if (i === 0) return "< −1 — deep into a negative edge";
    if (i === 61) return "> 5× Kelly";
    const lo = ((i - 1) / 10 - 1).toFixed(1);
    const hi = (i / 10 - 1).toFixed(1);
    return lo + " – " + hi + "× Kelly";
  }

  // per-bucket aggregates over the game's rounds, same 62-bucket indexing
  // as kelly.js histogram(): [0] <−1, [1..60] −1…5 in 0.1 steps, [61] >5
  function histData() {
    const B = Array.from({ length: 62 }, () => ({
      w: 0,
      l: 0,
      n: 0, // counts: won / lost / push+pass
      up: 0,
      down: 0, // dollars won / dollars lost
      gUp: 0,
      gDown: 0, // log-growth gained / given back
    }));
    for (const e of state.game.history) {
      const s = scoreOf(e);
      const i = !Number.isFinite(s)
        ? 61
        : s < -1
          ? 0
          : s >= 5
            ? 61
            : 1 + Math.floor((s + 1) / 0.1);
      const b = B[i];
      if (e.outcome === "win") {
        b.w++;
        b.up += e.delta;
      } else if (e.outcome === "lose") {
        b.l++;
        b.down += -e.delta;
      } else b.n++;
      if (e.before > 0) {
        // bust craters to −∞; cap it at a wipe-out to $1
        const g = Math.log(Math.max(e.after, 1) / e.before);
        if (g >= 0) b.gUp += g;
        else b.gDown += -g;
      }
    }
    return B;
  }

  function renderHistogram() {
    const container = $("hist-container");
    container.textContent = "";
    const B = histData();

    // size the plot to the container so it never scrolls sideways
    const avail = Math.max(280, container.clientWidth || 694);
    const slot = Math.max(
      4,
      Math.min(10, Math.floor((avail - 34 - 12 - 28) / 62)),
    );
    const barW = Math.max(3, slot - 2);
    const extraGap = slot >= 9 ? 14 : 8;
    const padL = 40,
      padR = 12,
      padT = 22,
      padB = 30,
      plotH = 170;
    const xOf = (i) =>
      padL + i * slot + (i >= 1 ? extraGap : 0) + (i >= 61 ? extraGap : 0);
    const width = xOf(61) + slot + padR;
    const height = padT + plotH + padB;

    const svg = svgEl("svg", {
      width,
      height,
      viewBox: "0 0 " + width + " " + height,
      role: "img",
      "aria-label": "Histogram of Kelly scores per round",
    });
    svg.style.display = "block";

    // per-mode extents: event stacks upward; value/perf diverge around zero
    const upOf = (b) =>
      histMode === "event"
        ? b.w + b.l + b.n
        : histMode === "value"
          ? b.up
          : b.gUp;
    const downOf = (b) =>
      histMode === "event" ? 0 : histMode === "value" ? b.down : b.gDown;
    let maxUp = 0,
      maxDown = 0;
    for (const b of B) {
      maxUp = Math.max(maxUp, upOf(b));
      maxDown = Math.max(maxDown, downOf(b));
    }
    if (maxUp <= 0) maxUp = 1;
    const span = maxUp + maxDown || 1;
    const upH = (plotH * maxUp) / span;
    const zeroY = padT + upH;
    const scale = plotH / span;

    // event-mode counts share one decimal precision down the whole axis —
    // a fractional step must not render as a ragged 2 / 1.5 / 1 / 0.5
    const stepUp = niceTickStep(maxUp, maxDown > 0 ? 2 : 4);
    const tickFmt = (v) =>
      histMode === "event"
        ? v.toFixed(stepUp < 1 ? 1 : 0)
        : histMode === "value"
          ? money(v)
          : (Math.expm1(v) * 100).toFixed(
              Math.abs(Math.expm1(v)) < 0.095 ? 1 : 0,
            ) + "%";

    // gridlines + y labels, above and below zero
    const drawTick = (v, y) => {
      svgEl(
        "line",
        {
          x1: padL,
          x2: width - padR,
          y1: y,
          y2: y,
          stroke: "var(--grid)",
          "stroke-width": 1,
        },
        svg,
      );
      const t = svgEl(
        "text",
        {
          x: padL - 6,
          y: y + 3.5,
          "text-anchor": "end",
          "font-size": 10.5,
          fill: "var(--muted)",
        },
        svg,
      );
      t.textContent = (v < 0 ? "−" : "") + tickFmt(Math.abs(v));
    };
    for (let v = stepUp; v <= maxUp; v += stepUp)
      drawTick(v, zeroY - v * scale);

    // reference line at score = 1 (left edge of the [1.0,1.1) bucket)
    const refX = xOf(21) - 1;
    svgEl(
      "line",
      {
        x1: refX,
        x2: refX,
        y1: padT - 8,
        y2: padT + plotH,
        stroke: "var(--baseline)",
        "stroke-width": 1,
      },
      svg,
    );
    const refT = svgEl(
      "text",
      {
        x: refX,
        y: padT - 12,
        "text-anchor": "middle",
        "font-size": 10.5,
        fill: "var(--muted)",
      },
      svg,
    );
    refT.textContent = "optimal";

    // zero line
    svgEl(
      "line",
      {
        x1: padL,
        x2: width - padR,
        y1: zeroY,
        y2: zeroY,
        stroke: "var(--baseline)",
        "stroke-width": 1,
      },
      svg,
    );

    const bar = (x, y, h, fill) => {
      if (h <= 0) return;
      svgEl("rect", { x, y, width: barW, height: Math.max(h, 1.5), fill }, svg);
    };
    for (let i = 0; i < 62; i++) {
      const b = B[i];
      const x = xOf(i) + (slot - barW) / 2;
      if (histMode === "event") {
        // stacked by outcome: losses at the base, wins on top, the rest between
        let y = zeroY;
        for (const [n, fill] of [
          [b.l, "var(--bad)"],
          [b.n, "var(--muted)"],
          [b.w, "var(--good)"],
        ]) {
          const h = n * scale;
          y -= h;
          bar(x, y, h, fill);
        }
      } else {
        bar(x, zeroY - upOf(b) * scale, upOf(b) * scale, "var(--good)");
        bar(x, zeroY, downOf(b) * scale, "var(--bad)");
      }
    }

    // x labels: truncation buckets + integer boundaries
    const xLabel = (x, text) => {
      const t = svgEl(
        "text",
        {
          x,
          y: padT + plotH + 16,
          "text-anchor": "middle",
          "font-size": 10.5,
          fill: "var(--muted)",
        },
        svg,
      );
      t.textContent = text;
    };
    // the <−1 bucket label already marks the left boundary — a −1 tick would collide
    xLabel(xOf(0) + slot / 2, "<−1");
    for (let v = 0; v <= 4; v++) xLabel(xOf((v + 1) * 10 + 1) - 1, String(v));
    xLabel(xOf(61) + slot / 2, ">5");

    // hover/tap layer — full-height hit targets, one per bucket
    const nRounds = state.game.history.length;
    for (let i = 0; i < 62; i++) {
      const b = B[i];
      const hit = svgEl(
        "rect",
        { x: xOf(i), y: padT, width: slot, height: plotH, fill: "transparent" },
        svg,
      );
      bindTip(hit, () => {
        const total = b.w + b.l + b.n;
        if (!total) return null;
        const rows = [
          total +
            (total === 1 ? " round" : " rounds") +
            " · " +
            pctShare(total, nRounds) +
            " of the game",
        ];
        if (histMode === "event")
          rows.push(
            '<span class="up">' +
              b.w +
              ' won</span> · <span class="dn">' +
              b.l +
              " lost</span>" +
              (b.n ? " · " + b.n + " other" : ""),
          );
        else if (histMode === "value")
          rows.push(
            '<span class="up">+' +
              money(b.up) +
              ' won</span> · <span class="dn">−' +
              money(b.down) +
              " lost</span>",
          );
        else
          rows.push(
            '<span class="up">+' +
              (Math.expm1(b.gUp) * 100).toFixed(1) +
              '% gained</span> · <span class="dn">−' +
              (-Math.expm1(-b.gDown) * 100).toFixed(1) +
              "% given back</span>",
          );
        return tipHtml(bucketLabel(i), rows);
      });
    }

    container.appendChild(svg);
  }

  /* ---------- table + export ---------- */

  function renderTable() {
    const coaching = true; // post-game, everything is revealed
    $("history-table").querySelector("thead").innerHTML = ledgerHead(coaching);
    $("history-table").querySelector("tbody").innerHTML =
      zeroRow() +
      state.game.history.map((e) => ledgerRow(e, coaching)).join("");
    bindLedgerTips("history-table", [null].concat(state.game.history));
  }

  const EXPORT_HEADER = [
    "round",
    "mode",
    "odds_b",
    "p_win",
    "p_lose",
    "p_push",
    "bankroll_before",
    "bet",
    "bet_fraction",
    "kelly_fraction",
    "kelly_score",
    "outcome",
    "bankroll_after",
  ];

  function exportRows() {
    return state.game.history.map((e) => {
      const frac = e.before > 0 ? e.bet / e.before : 0;
      const s = scoreOf(e);
      return [
        e.n,
        e.adv ? "ternary" : "binary",
        e.b,
        e.p,
        e.q,
        e.push,
        e.before,
        e.bet,
        Math.round(frac * 1e6) / 1e6,
        Math.round(e.kelly * 1e6) / 1e6,
        Number.isFinite(s) ? Math.round(s * 1e4) / 1e4 : "inf",
        e.outcome,
        e.after,
      ];
    });
  }

  function downloadCsv() {
    const lines = [EXPORT_HEADER.join(",")].concat(
      exportRows().map((r) => r.join(",")),
    );
    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "kelly-game.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function copyTsv() {
    const text = [EXPORT_HEADER.join(",")]
      .concat(exportRows().map((r) => r.join(",")))
      .join("\n");
    const done = () => {
      const el = $("copy-status");
      el.textContent = "Copied";
      setTimeout(() => (el.textContent = ""), 2000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(done, () => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      done();
    } catch (e) {
      /* clipboard unavailable — the CSV download still works */
    }
    document.body.removeChild(ta);
  }

  /* ---------- info page: formula, calculator, growth curve ---------- */

  // odds slider is log-scaled over the game's own range
  function calcOddsFormat() {
    const el = document.querySelector("#calc-format input:checked");
    return (el && el.value) || "decimal";
  }

  // the odds slider is linear decimal odds 1.00–21.00 (net 0–20)
  function calcB() {
    return Math.max(0, Number($("calc-b").value) / 100 - 1);
  }

  // typed odds accept the current convention, plus a/b fractions and ±american
  function parseOddsInput(str, fmt) {
    str = String(str).trim().replace("−", "-");
    let m = str.match(/^([+-])(\d+(?:\.\d+)?)$/);
    if (m && fmt === "american") {
      const a = Number(m[1] + m[2]);
      return a > 0 ? a / 100 : 100 / -a;
    }
    m = str.match(/^(\d+(?:\.\d+)?)\s*[\/:]\s*(\d+(?:\.\d+)?)$/);
    if (m && Number(m[2]) > 0) return Number(m[1]) / Number(m[2]);
    const v = Number(str);
    if (!Number.isFinite(v)) return null;
    if (fmt === "hongkong" || fmt === "ratio") return v;
    if (fmt === "indonesian") return v < 0 ? 1 / -v : v;
    if (fmt === "malay") return v < 0 ? 1 / -v : v;
    return v - 1;
  }

  function drawCalc(animate) {
    const b = calcB();
    const p = Math.min(100, Math.max(0, Number($("calc-p").value) || 0)) / 100;
    const q = Math.min(100, Math.max(0, Number($("calc-q").value) || 0)) / 100;
    const rr = Math.max(0, 1 - p - q);
    for (const id of ["calc-b", "calc-p", "calc-q", "calc-r"]) {
      const s = $(id);
      s.style.setProperty(
        "--fill",
        ((Number(s.value) - Number(s.min)) / (Number(s.max) - Number(s.min))) *
          100 +
          "%",
      );
    }
    const fmt = calcOddsFormat();
    // decimal odds pair with decimal probabilities, same as the game board
    const probOut = (v) =>
      fmt === "decimal" ? v.toFixed(2) : Math.round(v * 100) + "%";
    $("calc-b-out").value = oddsMain(b, fmt);
    $("calc-p-out").value = probOut(p);
    $("calc-q-out").value = probOut(q);
    $("calc-r-out").value = probOut(rr);
    const container = $("calc-chart");
    container.textContent = "";
    const fRaw = K.kellyFraction(b, p, q);
    const f = Number.isFinite(fRaw) ? fRaw : 0;

    // return per round, plotted in percent space so total loss is a real
    // point on the axis: −100%
    const W = Math.max(320, container.clientWidth || 460),
      H = 210,
      padL = 52,
      padR = 14,
      padT = 14,
      padB = 30;
    const xMax = 0.999; // the x axis is fixed: 0–100% of bankroll
    const g = (x) => p * Math.log(1 + x * b) + q * Math.log(1 - x);
    const r = (x) => Math.expm1(g(x));
    const N = 160;
    const pts = [];
    let yMin = 0,
      yMax = 0.001;
    for (let i = 0; i <= N; i++) {
      const x = (i / N) * xMax;
      const y = r(x);
      pts.push([x, y]);
      yMin = Math.min(yMin, y);
      yMax = Math.max(yMax, y);
    }
    const X = (x) => padL + (x / xMax) * (W - padL - padR);
    const Y = (y) =>
      padT + (1 - (y - yMin) / (yMax - yMin || 1)) * (H - padT - padB);

    const svg = svgEl("svg", {
      width: W,
      height: H,
      viewBox: "0 0 " + W + " " + H,
      role: "img",
      "aria-label": "Return per round versus fraction of bankroll wagered",
    });
    svg.style.display = "block";

    const fmtPct = (v) => {
      const pc = v * 100;
      const a = Math.abs(pc);
      return (
        (pc >= 0 ? "+" : "−") + a.toFixed(a < 9.95 ? 2 : a < 99.5 ? 1 : 0) + "%"
      );
    };
    const yLab = (y, text, color) => {
      const t = svgEl(
        "text",
        {
          x: padL - 8,
          y: y + 3.5,
          "text-anchor": "end",
          "font-size": 10.5,
          fill: color || "var(--muted)",
        },
        svg,
      );
      t.textContent = text;
    };
    svgEl(
      "line",
      {
        x1: padL,
        x2: W - padR,
        y1: Y(0),
        y2: Y(0),
        stroke: "var(--baseline)",
        "stroke-width": 1,
      },
      svg,
    );
    yLab(Y(0), "0%");
    // the floor of the plot — total loss when the curve reaches it
    if (yMin < -0.005) {
      svgEl(
        "line",
        {
          x1: padL,
          x2: W - padR,
          y1: Y(yMin),
          y2: Y(yMin),
          stroke: "var(--grid)",
          "stroke-width": 1,
        },
        svg,
      );
      yLab(Y(yMin), yMin < -0.995 ? "−100%" : fmtPct(yMin));
    }
    if (f > 0 && Y(0) - Y(r(f)) > 14) {
      svgEl(
        "line",
        {
          x1: padL,
          x2: W - padR,
          y1: Y(r(f)),
          y2: Y(r(f)),
          stroke: "var(--grid)",
          "stroke-width": 1,
        },
        svg,
      );
      yLab(Y(r(f)), fmtPct(r(f)));
    }

    // x axis: percent of bankroll wagered, fixed 0–100%
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      const x = X(Math.min(v, xMax));
      svgEl(
        "line",
        {
          x1: x,
          x2: x,
          y1: H - padB,
          y2: H - padB + 4,
          stroke: "var(--baseline)",
          "stroke-width": 1,
        },
        svg,
      );
      const t = svgEl(
        "text",
        {
          x,
          y: H - padB + 17,
          "text-anchor": "middle",
          "font-size": 10.5,
          fill: "var(--muted)",
        },
        svg,
      );
      t.textContent = Math.round(v * 100) + "%";
    }

    // where growth crosses back through zero — self-destruction begins
    let x0 = null;
    if (f > 0 && g(xMax) < 0) {
      let lo = f,
        hi = xMax;
      for (let i = 0; i < 50; i++) {
        const m = (lo + hi) / 2;
        if (g(m) >= 0) lo = m;
        else hi = m;
      }
      x0 = (lo + hi) / 2;
    }

    // the curve wears its meaning: accent while compounding, red once it turns
    const seg = (list) =>
      list
        .map(
          ([x, y], i) =>
            (i ? "L" : "M") + X(x).toFixed(1) + "," + Y(y).toFixed(1),
        )
        .join("");
    let path;
    if (f <= 0) {
      path = svgEl(
        "path",
        {
          d: seg(pts),
          fill: "none",
          stroke: "var(--bad)",
          "stroke-width": 2,
          "stroke-linecap": "round",
        },
        svg,
      );
    } else {
      const before = pts.filter(([x]) => x0 === null || x <= x0);
      if (x0 !== null) before.push([x0, 0]);
      path = svgEl(
        "path",
        {
          d: seg(before),
          fill: "none",
          stroke: "var(--accent)",
          "stroke-width": 2,
          "stroke-linecap": "round",
        },
        svg,
      );
      if (x0 !== null) {
        const after = [[x0, 0]].concat(pts.filter(([x]) => x > x0));
        svgEl(
          "path",
          {
            d: seg(after),
            fill: "none",
            stroke: "var(--bad)",
            "stroke-width": 2,
            "stroke-linecap": "round",
          },
          svg,
        );
      }
    }

    const dot = (x, y, color, label, labelColor) => {
      svgEl(
        "circle",
        {
          cx: X(x),
          cy: Y(y),
          r: 4.5,
          fill: color,
          stroke: "var(--page)",
          "stroke-width": 2,
        },
        svg,
      );
      const above = Y(y) - 10 >= 12;
      const t = svgEl(
        "text",
        {
          x: X(x),
          y: above ? Y(y) - 10 : Y(y) + 20,
          "text-anchor": "middle",
          "font-size": 11,
          fill: labelColor,
        },
        svg,
      );
      t.textContent = label;
    };
    if (f > 0) {
      const fx = Math.min(f, xMax);
      dot(
        fx,
        r(fx),
        "var(--accent)",
        (f * 100).toFixed(1) + "%",
        "var(--ink-2)",
      );
      if (x0 !== null)
        dot(x0, 0, "var(--bad)", (x0 * 100).toFixed(0) + "%", "var(--bad)");
    }

    // read any point on the curve: bet size → growth per round
    const hover = svgEl(
      "rect",
      {
        x: padL,
        y: padT,
        width: W - padL - padR,
        height: H - padT - padB,
        fill: "transparent",
      },
      svg,
    );
    bindTip(hover, (ev) => {
      const rect = svg.getBoundingClientRect();
      const fx = Math.min(
        xMax,
        Math.max(0, ((ev.clientX - rect.left - padL) / (W - padL - padR)) * xMax),
      );
      let title = "Bet " + Math.round(fx * 100) + "% of bankroll";
      if (f > 0 && Math.abs(fx - f) < 0.02) title += " — optimal";
      else if (x0 !== null && Math.abs(fx - x0) < 0.02) title += " — break-even";
      return tipHtml(title, ["growth " + fmtPct(r(fx)) + " per round"]);
    });

    container.appendChild(svg);
    if (animate && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const len = path.getTotalLength();
      path.style.strokeDasharray = len;
      path.style.strokeDashoffset = len;
      requestAnimationFrame(() => {
        path.style.transition = "stroke-dashoffset 0.7s ease";
        path.style.strokeDashoffset = 0;
      });
    }
  }

  function openInfo() {
    // prefill from the live round so the page explains the table in front of you
    const cur = state.game && state.game.cur;
    if (cur) {
      $("calc-b").value = Math.min(
        2100,
        Math.max(100, Math.round((cur.round.b + 1) * 100)),
      );
      $("calc-p").value = Math.round(cur.round.p * 100);
      $("calc-q").value = Math.max(1, Math.round(cur.round.q * 100));
    }
    const fmt = document.querySelector(
      '#calc-format input[value="' + state.settings.odds + '"]',
    );
    if (fmt) fmt.checked = true;
    $("info-view").classList.remove("hidden");
    $("game-view").classList.add("hidden");
    $("results-view").classList.add("hidden");
    $("masthead").classList.add("hidden");
    drawCalc(true);
    scrollTo(0, 0);
  }

  function closeInfo() {
    $("info-view").classList.add("hidden");
    $("masthead").classList.remove("hidden");
    render();
  }

  /* ---------- top-level render ---------- */

  function render() {
    if (!$("info-view").classList.contains("hidden")) return;
    const ended = state.game.phase === "ended";
    $("game-view").classList.toggle("hidden", ended);
    $("results-view").classList.toggle("hidden", !ended);
    if (ended) renderResults();
    else renderGame();
  }

  /* ---------- wiring ---------- */

  function initControls() {
    // each option label remembers its text so CSS can reserve its bold width
    for (const l of document.querySelectorAll(
      ".radio-row label, .radio-col label",
    ))
      l.dataset.t = l.textContent.trim();

    for (const radio of document.querySelectorAll("#input-mode input")) {
      radio.addEventListener("change", () => {
        state.settings.input = radio.value;
        save();
        render();
      });
    }
    for (const radio of document.querySelectorAll("#challenge-mode input")) {
      radio.addEventListener("change", () => {
        state.settings.challenge = radio.value;
        // the current, un-bet round is regenerated to match the new mode
        if (state.game.phase === "playing") genNext();
        save();
        render();
      });
    }
    for (const radio of document.querySelectorAll("#odds-format input")) {
      radio.addEventListener("change", () => {
        state.settings.odds = radio.value;
        save();
        render();
      });
    }
    for (const radio of document.querySelectorAll("#coaching-mode input")) {
      radio.addEventListener("change", () => {
        state.settings.reveal = radio.value === "on";
        reflectSettings();
        save();
        render();
      });
    }

    $("bips-slider").addEventListener("input", () => {
      bipsTyped = "";
      syncSlider();
    });
    $("slider-bet").addEventListener("click", () => {
      bipsTyped = "";
      placeBet(sliderAmount());
    });
    document.addEventListener("keydown", handleKey);

    $("end-now").addEventListener("click", () => {
      if (state.game.history.length === 0) return;
      endGame("cashout");
    });
    $("extend").addEventListener("click", extendGame);
    $("play-again").addEventListener("click", newGame);

    $("info-open").addEventListener("click", openInfo);
    $("info-close").addEventListener("click", closeInfo);
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") closeInfo();
    });
    // win + lose + push always sum to 100%. Moving win or lose adjusts the
    // other; push holds its ground and only gives way as a last resort.
    const setWLP = (which, vRaw) => {
      const v = Math.min(100, Math.max(0, vRaw));
      if (which === "p") {
        $("calc-p").value = v;
        let q = 100 - v - Number($("calc-r").value);
        if (q < 0) {
          q = 0;
          $("calc-r").value = 100 - v;
        }
        $("calc-q").value = q;
      } else if (which === "q") {
        $("calc-q").value = v;
        let p = 100 - v - Number($("calc-r").value);
        if (p < 0) {
          p = 0;
          $("calc-r").value = 100 - v;
        }
        $("calc-p").value = p;
      } else {
        $("calc-r").value = v;
        let q = 100 - Number($("calc-p").value) - v;
        if (q < 0) {
          q = 0;
          $("calc-p").value = 100 - v;
        }
        $("calc-q").value = q;
      }
      drawCalc(false);
    };
    $("calc-b").addEventListener("input", () => drawCalc(false));
    $("calc-p").addEventListener("input", () =>
      setWLP("p", Number($("calc-p").value)),
    );
    $("calc-q").addEventListener("input", () =>
      setWLP("q", Number($("calc-q").value)),
    );
    $("calc-r").addEventListener("input", () =>
      setWLP("r", Number($("calc-r").value)),
    );
    // every value is typeable; probabilities accept 63 or 0.63
    const probTyped = (which, el) => {
      el.addEventListener("change", () => {
        let v = Number(String(el.value).replace("%", "").replace("−", "-"));
        if (!Number.isFinite(v)) return drawCalc(false);
        if (v > 0 && v <= 1) v *= 100;
        setWLP(which, v);
      });
    };
    probTyped("p", $("calc-p-out"));
    probTyped("q", $("calc-q-out"));
    probTyped("r", $("calc-r-out"));
    $("calc-b-out").addEventListener("change", () => {
      const bTyped = parseOddsInput($("calc-b-out").value, calcOddsFormat());
      if (bTyped !== null)
        $("calc-b").value = Math.min(
          2100,
          Math.max(100, Math.round((bTyped + 1) * 100)),
        );
      drawCalc(false);
    });
    for (const radio of document.querySelectorAll("#calc-format input")) {
      radio.addEventListener("change", () => drawCalc(false));
    }
    for (const radio of document.querySelectorAll("#hist-mode input")) {
      radio.addEventListener("change", () => {
        histMode = radio.value;
        renderHistogram();
      });
    }
    for (const radio of document.querySelectorAll("#mc-mode input")) {
      radio.addEventListener("change", () => {
        mcMode = radio.value;
        mcEnsure();
      });
    }

    // CSV export lives in a right-click menu on either history section
    const menu = $("ctx-menu");
    const hideMenu = () => {
      menu.style.display = "none";
    };
    for (const id of ["game-history", "results-history"]) {
      $(id).addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        menu.style.display = "block";
        menu.style.left =
          Math.min(ev.clientX, innerWidth - menu.offsetWidth - 8) + "px";
        menu.style.top =
          Math.min(ev.clientY, innerHeight - menu.offsetHeight - 8) + "px";
      });
    }
    document.addEventListener("click", hideMenu);
    document.addEventListener("scroll", hideMenu, {
      capture: true,
      passive: true,
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") hideMenu();
    });
  }

  function reflectSettings() {
    const s = state.settings;
    const om = document.querySelector(
      '#odds-format input[value="' + s.odds + '"]',
    );
    if (om) om.checked = true;
    const im = document.querySelector(
      '#input-mode input[value="' + s.input + '"]',
    );
    if (im) im.checked = true;
    const cm = document.querySelector(
      '#challenge-mode input[value="' + s.challenge + '"]',
    );
    if (cm) cm.checked = true;
    const cv = s.reveal ? "on" : "off";
    const el = document.querySelector(
      '#coaching-mode input[value="' + cv + '"]',
    );
    if (el) el.checked = true;
  }

  /* ---------- autoplay (debug/demo: ?autoplay=N[&stay=1]) ---------- */

  function autoplay(n, stay) {
    for (let i = 0; i < n && state.game.phase === "playing"; i++) {
      const cur = state.game.cur;
      if (!cur) break;
      const choicePool = cur.choices;
      const amount =
        Math.random() < 0.15
          ? 0
          : choicePool[Math.floor(Math.random() * choicePool.length)];
      placeBet(amount);
    }
    if (
      !stay &&
      state.game.phase === "playing" &&
      state.game.history.length > 0
    ) {
      endGame("cashout");
    }
  }

  /* ---------- boot ---------- */

  load();
  if (!state.game) state.game = freshGame();
  if (state.game.phase === "playing" && !state.game.cur) genNext();
  reflectSettings();
  initControls();

  const params = new URLSearchParams(location.search);
  const auto = Number(params.get("autoplay"));
  if (auto > 0) {
    state.game = freshGame();
    genNext();
    autoplay(auto, params.get("stay") === "1");
  }

  render();
})();
