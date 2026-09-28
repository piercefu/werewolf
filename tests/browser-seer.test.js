// Real-browser check that the Seer actually SEES their result banner on
// screen after clicking a candidate, and that it survives well past their
// own turn. This is a permanent regression guard for a real bug: the result
// used to be tied to a one-shot API response and a razor-thin sub-phase
// window, so in a minimal game (no Guard/Witch) it could resolve the whole
// night inside the Seer's own click and the banner would never render.
// Requires Playwright — see tests/README.md.
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  console.log('Playwright is not installed — skipping browser-seer.test.js.');
  console.log('Run `npm install --no-save playwright` (once) to enable it, then re-run with --include-browser.');
  process.exit(0);
}

const BASE = process.env.BASE_URL || 'http://localhost:3987';
let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('ok  -', label); }
  else { fail++; console.log('FAIL -', label); }
}
async function newTab(browser) {
  const page = await browser.newPage();
  await page.goto(BASE);
  return page;
}
async function waitText(page, text, timeout = 10000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout });
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  try {
    const leader = await newTab(browser);
    const p2 = await newTab(browser);
    const p3 = await newTab(browser);
    const p4 = await newTab(browser);
    const p5 = await newTab(browser);

    await leader.click('#btn-create');
    await leader.fill('#in-name', 'Leader');
    await leader.click('#btn-submit');
    await waitText(leader, 'ROOM CODE');
    const roomCode = (await leader.locator('.roomcode').innerText()).trim();

    for (const [page, name] of [[p2, 'Bo'], [p3, 'Cy'], [p4, 'Dee'], [p5, 'Eli']]) {
      await page.click('#btn-join');
      await page.fill('#in-room', roomCode);
      await page.fill('#in-name', name);
      await page.click('#btn-submit');
      await waitText(page, 'ROOM CODE');
    }

    // 1 Werewolf + 1 Seer + 3 Villagers, no Guard/Witch — the minimal-roles
    // case where the whole night resolves synchronously right inside the
    // Seer's own click.
    await leader.fill('input[data-role="Werewolf"]', '1');
    await leader.fill('input[data-role="Seer"]', '1');
    await leader.fill('input[data-role="Villager"]', '3');
    for (const role of ['Villager', 'Seer', 'Werewolf']) {
      await leader.locator(`input[data-role="${role}"]`).dispatchEvent('change');
    }
    for (const key of ['candidacy', 'electionVote', 'nightAction', 'dayVote', 'speech']) {
      const sel = `input[data-timer="${key}"]`;
      await leader.fill(sel, '5');
      await leader.locator(sel).dispatchEvent('change');
    }
    await leader.waitForTimeout(900);
    await leader.click('#btn-start');
    await waitText(leader, 'Night 1');

    for (const page of [leader, p2, p3, p4, p5]) {
      await page.click('#btn-reveal-role');
      await page.waitForSelector('#rolecard .rolename');
    }

    let seerPage = null, wolfPage = null;
    for (const page of [leader, p2, p3, p4, p5]) {
      const roleName = (await page.locator('#rolecard .rolename').innerText()).trim();
      if (roleName === 'Seer') seerPage = page;
      if (roleName === 'Werewolf') wolfPage = page;
    }
    ok(!!seerPage && !!wolfPage, 'found the Seer and Werewolf tabs');

    await wolfPage.waitForSelector('#wolf-choices .choicebtn', { timeout: 8000 });
    await wolfPage.locator('#wolf-choices .choicebtn').first().click();

    await seerPage.waitForSelector('#seer-choices .choicebtn', { timeout: 8000 });
    const targetName = (await seerPage.locator('#seer-choices .choicebtn').first().innerText()).trim();
    await seerPage.locator('#seer-choices .choicebtn').first().click();

    await seerPage.waitForTimeout(2500);
    const bodyText = await seerPage.locator('#app').innerText();
    const sawBanner = bodyText.includes(targetName) && (bodyText.includes('Werewolf') || bodyText.includes('Village'));
    ok(sawBanner, `Seer's screen shows the check result for ${targetName} shortly after clicking`);

    await Promise.all([leader, p2, p3, p4, p5].map((page) => waitText(page, 'Sheriff campaign', 15000).catch(() => {})));
    await seerPage.waitForTimeout(500);
    const bodyTextLater = await seerPage.locator('#app').innerText();
    const stillThere = bodyTextLater.includes(targetName) && (bodyTextLater.includes('Werewolf') || bodyTextLater.includes('Village'));
    ok(stillThere, 'Seer\'s result is STILL visible once the game has moved into the campaign/day');
  } finally {
    await browser.close();
  }

  console.log(`\n${pass}/${pass + fail} checks passed.`);
  if (fail > 0) { console.log('SOME FAILED'); process.exit(1); }
  console.log('ALL GOOD');
})().catch((e) => { console.error(e); process.exit(1); });
