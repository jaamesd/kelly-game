/* Headless mobile/desktop smoke test — not shipped with the site.
   Run: node mobile-check.js
   (CHROME=/path/to/chrome overrides the browser; needs the playwright pkg.) */
const { chromium } = require("playwright");

const URL = "file://" + __dirname + "/index.html";

(async () => {
  const browser = await chromium.launch(
    process.env.CHROME
      ? { executablePath: process.env.CHROME, args: ["--no-sandbox"] }
      : {},
  );
  const errors = [];

  async function page(opts) {
    const ctx = await browser.newContext(opts);
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(String(e)));
    p.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    return p;
  }

  const mobile = {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  };

  // --- mobile game view + interaction drive ---
  let p = await page(mobile);
  await p.goto(URL);
  await p.evaluate(() => localStorage.clear());
  await p.reload();

  const overflow = await p.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  if (overflow > 0) errors.push("horizontal page overflow: " + overflow + "px");

  // the History heading and End game share one row, and End game is inert
  // until there is a game to end
  const headOk = await p.evaluate(() => {
    const h = document
      .querySelector("#game-history h2")
      .getBoundingClientRect();
    const b = document.getElementById("end-now").getBoundingClientRect();
    return Math.abs(h.y - b.y) < h.height;
  });
  if (!headOk) errors.push("End game is not beside the History heading");
  if (!(await p.locator("#end-now").isDisabled()))
    errors.push("end-now is enabled before any bet");

  await p.screenshot({ path: "m-game.png", fullPage: true });

  // play 5 rounds via multiple choice — the smallest bet (options render
  // ascending), so a losing streak can't bust mid-script
  for (let i = 0; i < 5; i++) {
    await p.locator("#choice-buttons button").first().click();
  }
  // switch to slider; typed digits are big-endian percent (25 → 25%, ↵ bets),
  // and a typed 0 is a pass
  await p.locator('#input-mode label:has-text("Slider")').click();
  await p.keyboard.type("25");
  await p.keyboard.press("Enter");
  await p.keyboard.type("0");
  await p.keyboard.press("Enter");
  const roundNo = await p.locator("#round-label").textContent();
  if (!roundNo.startsWith("8/"))
    errors.push("expected round 8, got " + roundNo);

  // the ledger's last row carries no separator
  const lastRule = await p.evaluate(() => {
    const tds = document.querySelectorAll(
      "#ledger-game tbody tr:last-child td",
    );
    return tds.length ? getComputedStyle(tds[0]).borderBottomWidth : "missing";
  });
  if (lastRule !== "0px")
    errors.push("ledger last-row border: " + lastRule);

  await p.screenshot({ path: "m-slider.png", fullPage: false });

  // end game -> results
  await p.locator("#end-now").click();
  await p.waitForTimeout(600);
  await p.screenshot({ path: "m-end.png", fullPage: true });
  const overflowEnd = await p.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  if (overflowEnd > 0)
    errors.push("results horizontal overflow: " + overflowEnd + "px");

  // the outcomes note reads as a sentence
  const note = await p.locator("#mc-note").textContent();
  if (!/replays of (your own bets|exact Kelly bets)\./.test(note))
    errors.push("mc-note is not a sentence: " + note);

  // charts answer to touch: tapping a populated bar shows the tooltip,
  // scrolling dismisses it
  const tipOk = await p.evaluate(() => {
    const tip = document.getElementById("tooltip");
    const hits = [
      ...document.querySelectorAll("#mc-container svg rect"),
    ].filter((r) => r.getAttribute("fill") === "transparent");
    for (const h of hits) {
      const r = h.getBoundingClientRect();
      h.dispatchEvent(
        new PointerEvent("pointerdown", {
          clientX: r.x + r.width / 2,
          clientY: r.y + r.height / 2,
          pointerType: "touch",
          bubbles: true,
        }),
      );
      if (tip.style.display === "block") return true;
    }
    return false;
  });
  if (!tipOk) errors.push("no outcomes tooltip on touch");
  await p.mouse.wheel(0, 60);
  await p.waitForTimeout(100);
  const tipHidden = await p.evaluate(
    () => document.getElementById("tooltip").style.display !== "block",
  );
  if (!tipHidden) errors.push("tooltip survived a scroll");
  await p.close();

  // --- mobile results via autoplay, dark ---
  p = await page({ ...mobile, colorScheme: "dark" });
  await p.goto(URL + "?autoplay=80");
  await p.waitForTimeout(800);
  await p.screenshot({ path: "m-results-dark.png", fullPage: true });
  await p.close();

  // --- desktop sanity ---
  p = await page({ viewport: { width: 1280, height: 900 } });
  await p.goto(URL + "?autoplay=80");
  await p.waitForTimeout(800);
  await p.screenshot({ path: "d-results.png", fullPage: true });
  await p.close();

  await browser.close();
  if (errors.length) {
    console.error("ISSUES:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log("mobile/desktop smoke test passed");
})();
