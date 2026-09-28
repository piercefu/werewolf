// Real-browser regression guard for a bug the user hit live: once a session
// was saved to localStorage there was no way to leave it (no "leave game"
// control existed at all), and — worse — opening a brand-new invite link
// while an old/stale session was still saved silently resumed the OLD room
// instead of joining the one the link pointed to, forcing players to clear
// site data just to start a new game. Requires Playwright — see
// tests/README.md.
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  console.log('Playwright is not installed — skipping browser-session.test.js.');
  console.log('Run `npm install --no-save playwright` (once) to enable it, then re-run with --include-browser.');
  process.exit(0);
}

const BASE = process.env.BASE_URL || 'http://localhost:3987';
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('ok  -', label); }
  else { fail++; console.log('FAIL -', label, extra !== undefined ? JSON.stringify(extra) : ''); }
}
async function waitText(page, text, timeout = 8000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout });
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    // Auto-accept the confirm() dialog the Leave button raises — otherwise
    // Playwright's default is to dismiss it, which would make the click a
    // no-op and this test would pass for the wrong reason.
    page.on('dialog', (d) => d.accept());

    await page.goto(BASE);
    await page.click('#btn-create');
    await page.fill('#in-name', 'Alice');
    await page.click('#btn-submit');
    await waitText(page, 'ROOM CODE');
    const roomA = (await page.locator('.roomcode').innerText()).trim();
    ok(/^[A-Z0-9]{4}$/.test(roomA), '[session] created room A: ' + roomA);

    const savedBeforeLeave = await page.evaluate(() => localStorage.getItem('werewolf_session_v2'));
    ok(!!savedBeforeLeave, '[session] a session was saved to localStorage after creating room A');

    // --- Leave button actually works ---
    await page.click('#btn-leave');
    await page.waitForSelector('#btn-create', { timeout: 5000 });
    ok(true, '[leave] after confirming, back at the landing menu (Create/Join buttons visible)');
    const savedAfterLeave = await page.evaluate(() => localStorage.getItem('werewolf_session_v2'));
    ok(savedAfterLeave === null, '[leave] the session was actually cleared from localStorage', savedAfterLeave);

    // --- Create a second room (fresh session) ---
    await page.click('#btn-create');
    await page.fill('#in-name', 'Alice2');
    await page.click('#btn-submit');
    await waitText(page, 'ROOM CODE');
    const roomB = (await page.locator('.roomcode').innerText()).trim();
    ok(roomB !== roomA, '[session] created a second, different room B: ' + roomB);

    // --- The core bug: reopening a link to a DIFFERENT (older) room while a
    // newer session (room B) is saved must NOT silently resume room B. ---
    await page.goto(BASE + '/?room=' + roomA);
    await page.waitForSelector('#in-room', { timeout: 5000 }).catch(() => {});
    const inRoomValue = await page.locator('#in-room').inputValue().catch(() => null);
    const onJoinForm = await page.locator('#in-room').count().catch(() => 0);
    ok(onJoinForm > 0, '[url-mismatch] visiting a link for a DIFFERENT room shows the Join form instead of silently resuming room B');
    ok(inRoomValue === roomA, `[url-mismatch] the Join form is pre-filled with room A's code from the URL (got "${inRoomValue}")`, inRoomValue);
    const staleSessionGone = await page.evaluate(() => localStorage.getItem('werewolf_session_v2'));
    ok(staleSessionGone === null, '[url-mismatch] the stale room-B session was cleared, not left dangling', staleSessionGone);

    // --- Sanity: reopening YOUR OWN room's link still reconnects normally
    // (this persistence exists on purpose, for a reload/reopen mid-game). ---
    await page.click('#btn-back'); // back out of the join-room-A form from above
    await page.click('#btn-create');
    await page.fill('#in-name', 'Bob');
    await page.click('#btn-submit');
    await waitText(page, 'ROOM CODE');
    const roomC = (await page.locator('.roomcode').innerText()).trim();
    await page.goto(BASE + '/?room=' + roomC);
    await waitText(page, 'ROOM CODE');
    const resumedCode = (await page.locator('.roomcode').innerText()).trim();
    ok(resumedCode === roomC, '[same-room] reopening YOUR OWN room\'s own link still reconnects to it normally (not treated as a mismatch)', { resumedCode, roomC });
  } finally {
    await browser.close();
  }

  console.log(`\n${pass}/${pass + fail} checks passed.`);
  if (fail > 0) { console.log('SOME FAILED'); process.exit(1); }
  console.log('ALL GOOD');
})().catch((e) => { console.error(e); process.exit(1); });
