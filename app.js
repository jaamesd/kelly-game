/* UI layer for the Kelly criterion simulator. Pure game math lives in kelly.js. */
(function () {
  "use strict";

  const K = window.Kelly;
  const STORAGE_KEY = "kelly-sim-v2";
  const START_BANKROLL = 1000;
  const ROUNDS_PER_GAME = 99;
  const ADVANCED_AFTER = 50;

  const $ = (id) => document.getElementById(id);

  /* ---------- formatting ---------- */

  // Whole dollars, abbreviated from $1k up: $850, $1.2k, $45k, $3.1M.
  function money(v) {
    if (!Number.isFinite(v)) return "—";
    const sign = v < 0 ? "−" : "";
    const abs = Math.abs(v);
    for (const [div, suf] of [
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
      endReason: null, // "bust" | "complete" | "cashout"
      advNoticeRound: 0,
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
    if (mode.ternary && !g.advNoticeRound) g.advNoticeRound = roundNo();
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
    save();
    render();
  }

  function newGame() {
    state.game = freshGame();
    genNext();
    $("bankroll-pop").textContent = "";
    $("bankroll-pop").className = "";
    save();
    render();
  }

  /* ---------- game rendering ---------- */

  function flashBankroll(cls) {
    const el = $("bankroll");
    el.classList.remove("flash-win", "flash-lose");
    if (cls) {
      void el.offsetWidth;
      el.classList.add(cls);
      setTimeout(() => el.classList.remove(cls), 700);
    }
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

  function multStr(m) {
    return m.toFixed(m >= 9.5 ? 0 : m >= 0.095 ? 1 : 2) + "×";
  }

  // One row per round: the full five-chip menu on wide tables; narrow
  // tables keep only two via CSS — the pick (.sel) and the closest OTHER
  // candidate to 0.9× Kelly, pass included, ties to the lower wager (.alt).
  // With coaching the overall closest candidate gets the outline (.best).
  // Chip count never depends on coaching, so toggling it never reflows.
  function ledgerRow(e, coaching) {
    const opts = Array.isArray(e.choices)
      ? e.choices
      : e.bet > 0
        ? [e.bet]
        : [];
    const kOf = (a) => a / (e.before * e.kelly);
    // candidate 0 stands for pass (0× Kelly); with no edge, pass is
    // distance zero and bets rank by size
    const dist = (a) => {
      if (e.kelly > 0) return Math.abs((a === 0 ? 0 : kOf(a)) - 0.9);
      return a === 0 ? 0 : 1e9 + a;
    };
    const cands = opts.concat(0);
    const pick = (excl) => {
      let m = null;
      for (const a of cands.slice().sort((x, y) => x - y)) {
        if (excl !== null && a === excl) continue;
        if (m === null || dist(a) < dist(m)) m = a;
      }
      return m;
    };
    const selected = e.bet > 0 ? e.bet : 0;
    const best = pick(null);
    const alt = pick(selected);
    const title = (a) =>
      e.kelly > 0 ? multStr(kOf(a)) + " Kelly" : "negative edge";
    const passTitle = e.kelly <= 0 ? "correct — no edge" : "0× Kelly";
    const clsFor = (a) =>
      [
        a === selected ? "sel" : "",
        coaching && a === best ? "best" : "",
        a === alt ? "alt" : "",
      ]
        .filter(Boolean)
        .join(" ");
    let chips = "";
    for (const a of opts) chips += chip(money(a), clsFor(a), title(a));
    chips += chip("pass", clsFor(0), passTitle);

    const cells = [
      "<td>" + e.n + "</td>",
      '<td class="dim" title="1× ' +
        (e.kelly > 0 ? money(e.kelly * e.before) : "pass") +
        '">' +
        oddsMain(e.b) +
        "</td>",
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
      '<tr><th class="c-n">#</th><th class="c-odds">Odds</th><th class="c-opts">Bet</th>' +
      '<th class="c-k" title="your bet ÷ the Kelly bet">' +
      (coaching ? "k" : "") +
      "</th>" +
      '<th class="c-money">Result</th><th class="c-money">Balance</th></tr>'
    );
  }

  // row #0 is the opening balance — the ledger is always on the page
  function zeroRow() {
    return (
      '<tr><td class="dim">0</td><td></td><td class="opts"></td><td></td>' +
      "<td></td><td>" +
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
  }

  function renderGame() {
    const g = state.game;
    const cur = g.cur;

    $("bankroll-num").textContent = money(g.bankroll);
    $("mode-tag").textContent = tierName(roundMode(roundNo()));

    // advanced notice sticks around for a few rounds after it first triggers
    $("advanced-notice").classList.toggle(
      "hidden",
      !(
        g.advNoticeRound &&
        roundNo() >= g.advNoticeRound &&
        roundNo() < g.advNoticeRound + 3
      ),
    );

    if (!cur) return;
    const r = cur.round;
    $("round-label").textContent = roundNo() + "/" + g.maxRounds;
    $("odds-line").textContent = oddsMain(r.b);
    $("odds-label").textContent =
      (ODDS_NAMES[state.settings.odds] || state.settings.odds) + " odds";
    $("win-num").textContent = probStr(r.p);
    $("lose-num").textContent = probStr(r.q);
    $("push-num").classList.toggle("hidden", !r.advanced);
    $("push-label").classList.toggle("hidden", !r.advanced);
    if (r.advanced) $("push-num").textContent = probStr(r.push);
    $("payout-hint").textContent = oddsHint(r.b, r.p);
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
      cur.choices.forEach((amount, i) => {
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

  function mcToken() {
    const g = state.game;
    return g.history.length + ":" + g.bankroll + ":" + (g.endReason || "");
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
    mc = {
      token,
      rounds,
      acc: { chosen: [], optimal: [] },
      min: { chosen: Infinity, optimal: Infinity },
      max: { chosen: 0, optimal: 0 },
      ev,
      timer: 0,
    };
  }

  function mcBatch(n) {
    const arr = mc.acc[mcMode];
    for (let s = 0; s < n; s++) {
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
      arr.push(bank);
      if (bank >= 1) {
        mc.min[mcMode] = Math.min(mc.min[mcMode], bank);
        mc.max[mcMode] = Math.max(mc.max[mcMode], bank);
      }
    }
  }

  function mcTick() {
    if (!mc || $("results-view").classList.contains("hidden")) {
      if (mc) mc.timer = 0;
      return;
    }
    const arr = mc.acc[mcMode];
    if (arr.length < 200000) {
      mcBatch(arr.length < 2000 ? 400 : 2000);
      renderMC();
      mc.timer = setTimeout(mcTick, 120);
    } else {
      mc.timer = 0;
      renderMC();
    }
  }

  function mcEnsure() {
    mcSetup();
    renderMC();
    if (!mc.timer) mc.timer = setTimeout(mcTick, 30);
  }

  function renderMC() {
    const container = $("mc-container");
    container.textContent = "";
    const note = $("mc-note");
    if (!mc) return;
    const arr = mc.acc[mcMode];
    if (!arr.length) {
      note.textContent = "simulating…";
      return;
    }
    const user = state.game.bankroll;
    const ev = mc.ev[mcMode];

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

    // log-dollar range covering samples, the EV line, and the user's result
    let lo = Math.max(
      1,
      Math.min(mc.min[mcMode], ev, user >= 1 ? user : Infinity),
    );
    let hi = Math.max(mc.max[mcMode], ev, user, START_BANKROLL);
    let l0 = Math.log10(lo) - 0.05,
      l1 = Math.log10(hi) + 0.05;
    if (l1 - l0 < 0.4) {
      const mid = (l0 + l1) / 2;
      l0 = mid - 0.2;
      l1 = mid + 0.2;
    }
    const x0 = padL + bustW + 10,
      x1 = width - padR;
    const X = (v) =>
      x0 + ((Math.log10(Math.max(v, 1)) - l0) / (l1 - l0)) * (x1 - x0);

    const NB = 72;
    const buckets = new Array(NB).fill(0);
    let busts = 0;
    for (const v of arr) {
      if (v < 1) {
        busts++;
        continue;
      }
      let i = Math.floor(((Math.log10(v) - l0) / (l1 - l0)) * NB);
      i = Math.max(0, Math.min(NB - 1, i));
      buckets[i]++;
    }
    const maxCount = Math.max(1, ...buckets, busts);

    const svg = svgEl("svg", {
      width,
      height,
      viewBox: "0 0 " + width + " " + height,
      role: "img",
      "aria-label": "Distribution of replayed final balances",
    });
    svg.style.display = "block";

    // baseline + power-of-ten ticks
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
    for (let d = Math.ceil(l0); d <= Math.floor(l1); d++) {
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
      const t = svgEl(
        "text",
        {
          x,
          y: baseY + 16,
          "text-anchor": "middle",
          "font-size": 10.5,
          fill: "var(--muted)",
        },
        svg,
      );
      t.textContent = money(Math.pow(10, d));
    }

    const barW = (x1 - x0) / NB;
    for (let i = 0; i < NB; i++) {
      if (!buckets[i]) continue;
      const h = Math.max(1.5, (buckets[i] / maxCount) * plotH);
      svgEl(
        "rect",
        {
          x: x0 + i * barW,
          y: baseY - h,
          width: Math.max(barW - 0.5, 0.8),
          height: h,
          fill: "var(--accent)",
          opacity: 0.85,
        },
        svg,
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
    if (busts) {
      const h = Math.max(1.5, (busts / maxCount) * plotH);
      svgEl(
        "rect",
        {
          x: padL,
          y: baseY - h,
          width: bustW - 8,
          height: h,
          fill: "var(--bad)",
          opacity: 0.85,
        },
        svg,
      );
    }

    const vline = (v, color, label) => {
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
          x,
          y: padT - 12,
          "text-anchor": "middle",
          "font-size": 10.5,
          fill: color,
        },
        svg,
      );
      t.textContent = label;
    };
    vline(ev, "var(--muted)", "EV");
    if (user >= 1) vline(user, "var(--ink)", "you");
    container.appendChild(svg);

    const below = arr.reduce((n, v) => n + (v <= user ? 1 : 0), 0);
    note.textContent =
      "your " +
      money(user) +
      " beats " +
      Math.round((below / arr.length) * 100) +
      "% of " +
      arr.length.toLocaleString("en-US") +
      " replays of " +
      (mcMode === "chosen" ? "your bets" : "exact Kelly bets") +
      " · serial EV " +
      money(ev);
  }

  /* ---------- histogram (inline SVG) ---------- */

  let histMode = "event"; // event = round counts · value = $ · perf = growth
  let histResizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(histResizeTimer);
    histResizeTimer = setTimeout(() => {
      if (!$("results-view").classList.contains("hidden")) renderHistogram();
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

    const tickFmt = (v) =>
      histMode === "event"
        ? String(v)
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
    const stepUp = niceTickStep(maxUp, maxDown > 0 ? 2 : 4);
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

    // hover layer — full-height hit targets, one per bucket
    const tooltip = $("tooltip");
    for (let i = 0; i < 62; i++) {
      const b = B[i];
      const hit = svgEl(
        "rect",
        { x: xOf(i), y: padT, width: slot, height: plotH, fill: "transparent" },
        svg,
      );
      hit.addEventListener("mousemove", (ev) => {
        const total = b.w + b.l + b.n;
        let detail;
        if (!total) detail = "no rounds";
        else if (histMode === "event")
          detail =
            b.w + "W · " + b.l + "L" + (b.n ? " · " + b.n + " other" : "");
        else if (histMode === "value")
          detail = "+" + money(b.up) + " · −" + money(b.down);
        else
          detail =
            "+" +
            (Math.expm1(b.gUp) * 100).toFixed(1) +
            "% · −" +
            (-Math.expm1(-b.gDown) * -100).toFixed(1) +
            "%";
        tooltip.innerHTML = "<b>" + bucketLabel(i) + "</b> · " + detail;
        tooltip.style.display = "block";
        const pad = 12;
        const tw = tooltip.offsetWidth;
        let left = ev.clientX + pad;
        if (left + tw > window.innerWidth - 8) left = ev.clientX - tw - pad;
        tooltip.style.left = left + "px";
        tooltip.style.top = ev.clientY - 34 + "px";
      });
      hit.addEventListener("mouseleave", () => {
        tooltip.style.display = "none";
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
    $("restart").addEventListener("click", () => {
      if (
        state.game.history.length === 0 ||
        confirm("Abandon the current game?")
      )
        newGame();
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
    document.addEventListener("scroll", hideMenu, true);
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
