// Real browser click-through of the client against a live server, using
// Playwright. This is the one test file with an actual dependency, so it's
// excluded from the default `npm test` run — see tests/README.md for how to
// install Playwright and run it. Four tabs (leader + 3 players) play a
// minimal 4-player game (1 Werewolf + 3 Villagers — no night powers, since
// this file is about UI wiring, not game logic, which the other test files
// already cover).
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  console.log('Playwright is not installed — skipping browser.test.js.');
  console.log('Run `npm install --no-save playwright` (once) to enable it, then re-run with --include-browser.');
  process.exit(0);
}

const BASE = process.env.BASE_URL || 'http://localhost:3987';

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('ok  -', label); }
  else { fail++; console.log('FAIL -', label); }
}

const consoleErrors = [];

async function newTab(browser, label) {
  const page = await browser.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(`[${label}] ${msg.text()}`); });
  page.on('pageerror', (err) => { consoleErrors.push(`[${label}] pageerror: ${err.message}`); });
  await page.goto(BASE);
  return page;
}

async function waitText(page, text, timeout = 8000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout });
}

(async () => {
  // PW_CHROMIUM_PATH lets a sandboxed/preinstalled Chromium be used instead
  // of Playwright's own downloaded browser; leave it unset to use Playwright's
  // default (what a normal `npx playwright install` sets up).
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  try {
    const leader = await newTab(browser, 'leader');
    const p2 = await newTab(browser, 'p2');
    const p3 = await newTab(browser, 'p3');
    const p4 = await newTab(browser, 'p4');

    await leader.click('#btn-create');
    await leader.fill('#in-name', 'Leader');
    await leader.click('#btn-submit');
    await waitText(leader, 'ROOM CODE');
    ok(true, '[browser] leader created a room and sees the lobby');
    const roomCode = (await leader.locator('.roomcode').innerText()).trim();
    ok(/^[A-Z0-9]{4}$/.test(roomCode), '[browser] got a room code: ' + roomCode);

    for (const [page, name] of [[p2, 'Bo'], [p3, 'Casey'], [p4, 'Drew']]) {
      await page.click('#btn-join');
      await page.fill('#in-room', roomCode);
      await page.fill('#in-name', name);
      await page.click('#btn-submit');
      await waitText(page, 'ROOM CODE');
    }
    ok(true, '[browser] both other players joined and see the lobby');

    await leader.fill('input[data-role="Werewolf"]', '1');
    await leader.fill('input[data-role="Villager"]', '3');
    await leader.locator('input[data-role="Villager"]').dispatchEvent('change');
    await leader.locator('input[data-role="Werewolf"]').dispatchEvent('change');
    for (const key of ['candidacy', 'electionVote', 'nightAction', 'dayVote', 'speech']) {
      const sel = `input[data-timer="${key}"]`;
      await leader.fill(sel, '5');
      await leader.locator(sel).dispatchEvent('change');
    }
    await leader.waitForTimeout(900);
    const startEnabled = await leader.isEnabled('#btn-start');
    ok(startEnabled, '[browser] Start Game button enabled once roles balance');
    await leader.click('#btn-start');
    await waitText(leader, 'Night 1');
    ok(true, '[browser] game started, leader sees Night 1');

    for (const page of [leader, p2, p3, p4]) {
      await page.click('#btn-reveal-role');
      await page.waitForSelector('#rolecard .rolename');
    }
    ok(true, '[browser] all three players revealed their roles');

    let wolfPage = null;
    for (const page of [leader, p2, p3, p4]) {
      const roleName = await page.locator('#rolecard .rolename').innerText();
      if (roleName.trim() === 'Werewolf') wolfPage = page;
    }
    ok(!!wolfPage, '[browser] identified the Werewolf\'s tab');
    await wolfPage.waitForSelector('#wolf-choices .choicebtn', { timeout: 8000 });
    await wolfPage.click('#wolf-choices .choicebtn:not([data-self])');
    ok(true, '[browser] wolf cast a kill vote via the UI');

    await Promise.all([leader, p2, p3, p4].map((page) => waitText(page, 'Sheriff campaign', 15000)));
    ok(true, '[browser] all three tabs reached the campaign phase');

    await leader.click('#btn-run');
    await leader.waitForTimeout(300);
    const running = await leader.locator('button:has-text("Withdraw my candidacy")').count();
    ok(running === 1, '[browser] leader\'s candidacy registered in the UI');

    await Promise.all([leader, p2, p3, p4].map((page) => waitText(page, 'Day 1 — announcement', 25000).catch(() => waitText(page, 'Day 1 — discussion', 25000))));
    ok(true, '[browser] campaign concluded and the game reached the day announcement/discussion');

    await Promise.all([leader, p2, p3, p4].map((page) => waitText(page, 'voting', 50000)));
    ok(true, '[browser] reached the day vote screen in all three tabs (discussion + countdown resolved via timers)');

    for (const page of [leader, p2, p3, p4]) {
      const btns = page.locator('#vote-choices .choicebtn');
      const count = await btns.count().catch(() => 0);
      if (count > 0) await btns.first().click().catch(() => {});
    }
    ok(true, '[browser] votes submitted where possible');

    await leader.waitForFunction(() => /Night 2|Game over/.test(document.body.innerText), { timeout: 20000 });
    const finalText = await leader.locator('.banner').innerText();
    ok(/Night 2|Game over/.test(finalText), '[browser] game progressed past the vote into ' + finalText);

    ok(consoleErrors.length === 0, '[browser] no console errors across any tab: ' + JSON.stringify(consoleErrors));
  } finally {
    await browser.close();
  }

  console.log(`\n${pass}/${pass + fail} checks passed.`);
  if (fail > 0) { console.log('SOME FAILED'); process.exit(1); }
  console.log('ALL GOOD');
})().catch((e) => { console.error(e); process.exit(1); });
