/* Headless mobile/desktop smoke test — not shipped with the site.
   Run: NODE_PATH=/opt/node22/lib/node_modules node mobile-check.js */
const { chromium } = require("playwright");

const EXEC = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const URL = "file://" + __dirname + "/index.html";

(async () => {
  const browser = await chromium.launch({
    executablePath: EXEC,
    args: ["--no-sandbox"],
  });
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

  await p.screenshot({ path: "m-game.png", fullPage: true });

  // play 5 rounds via multiple choice
  for (let i = 0; i < 5; i++) {
    await p.locator("#choice-buttons button").first().click();
  }
  // switch to slider, bet 250 bips, then pass
  await p.locator('#input-mode input[value="slider"]').click();
  await p.locator("#bips-box").fill("250");
  await p.locator("#slider-bet").click();
  await p.locator("#slider-pass").click();
  const roundNo = await p.locator("#round-no").textContent();
  if (!roundNo.startsWith("8 /"))
    errors.push("expected round 8, got " + roundNo);
  await p.screenshot({ path: "m-slider.png", fullPage: false });

  // end game -> results
  await p.locator("#end-now").click();
  await p.screenshot({ path: "m-end.png", fullPage: true });
  const overflowEnd = await p.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  if (overflowEnd > 0)
    errors.push("results horizontal overflow: " + overflowEnd + "px");
  await p.close();

  // --- mobile results via autoplay, dark ---
  p = await page({ ...mobile, colorScheme: "dark" });
  await p.goto(URL + "?autoplay=80");
  await p.screenshot({ path: "m-results-dark.png", fullPage: true });
  await p.close();

  // --- desktop sanity ---
  p = await page({ viewport: { width: 1280, height: 900 } });
  await p.goto(URL + "?autoplay=80");
  await p.screenshot({ path: "d-results.png", fullPage: true });
  await p.close();

  await browser.close();
  if (errors.length) {
    console.error("ISSUES:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log("mobile/desktop smoke test passed");
})();
