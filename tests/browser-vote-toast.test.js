// Real-browser check for the "make vote wins more obvious" toast: an
// auto-dismissing banner that appears in #toast-root whenever a Sheriff
// election or a day elimination vote resolves (view.voteResultEvent). The
// HTTP-level tests (tests/vote-toast.test.js) already verify the server
// exposes the right event/text/id in every branch; this file is the one that
// actually watches the DOM to confirm the toast (a) renders on screen at all,
// (b) plays its slide-in ('show' class) transition, and (c) auto-dismisses
// (removes itself) on its own a few seconds later, without the player having
// to do anything. Requires Playwright — see tests/README.md.
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  console.log('Playwright is not installed — skipping browser-vote-toast.test.js.');
  console.log('Run `npm install --no-save playwright` (once) to enable it, then re-run with --include-browser.');
  process.exit(0);
}

const BASE = process.env.BASE_URL || 'http://localhost:3987';
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('ok  -', label); }
  else { fail++; console.log('FAIL -', label, extra !== undefined ? JSON.stringify(extra) : ''); }
}
async function newTab(browser) {
  const page = await browser.newPage();
  // Recorded from inside the page itself (not polled from outside), so a
  // toast that appears AND fully auto-dismisses between our checks is still
  // caught — this is the log of every toast that was ever appended to
  // #toast-root, in order, for the lifetime of the page.
  await page.addInitScript(() => {
    window.__toastLog = [];
    const attach = () => {
      const root = document.getElementById('toast-root');
      if (!root) { setTimeout(attach, 50); return; }
      new MutationObserver((muts) => {
        for (const m of muts) {
          for (const node of m.addedNodes) {
            if (node.nodeType === 1) window.__toastLog.push(node.textContent);
          }
        }
      }).observe(root, { childList: true });
    };
    attach();
  });
  await page.goto(BASE);
  return page;
}
async function waitText(page, text, timeout = 15000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout });
}
async function waitToastLogMatch(page, pattern, timeout = 15000) {
  await page.waitForFunction((p) => (window.__toastLog || []).some((t) => new RegExp(p).test(t)), pattern, { timeout });
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  try {
    const leader = await newTab(browser);
    const p2 = await newTab(browser);
    const p3 = await newTab(browser);
    const p4 = await newTab(browser);

    await leader.click('#btn-create');
    await leader.fill('#in-name', 'Leader');
    await leader.click('#btn-submit');
    await waitText(leader, 'ROOM CODE');
    const roomCode = (await leader.locator('.roomcode').innerText()).trim();

    for (const [page, name] of [[p2, 'Bo'], [p3, 'Cy'], [p4, 'Dee']]) {
      await page.click('#btn-join');
      await page.fill('#in-room', roomCode);
      await page.fill('#in-name', name);
      await page.click('#btn-submit');
      await waitText(page, 'ROOM CODE');
    }

    // 1 Werewolf + 3 Villagers, no night powers — this file is about the
    // toast's DOM behavior, not game logic, which other files already cover.
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
    await leader.click('#btn-start');
    await waitText(leader, 'Night 1');

    for (const page of [leader, p2, p3, p4]) {
      await page.click('#btn-reveal-role');
      await page.waitForSelector('#rolecard .rolename');
    }

    let wolfPage = null;
    for (const page of [leader, p2, p3, p4]) {
      const roleName = (await page.locator('#rolecard .rolename').innerText()).trim();
      if (roleName === 'Werewolf') wolfPage = page;
    }
    ok(!!wolfPage, 'found the Werewolf\'s tab');
    await wolfPage.waitForSelector('#wolf-choices .choicebtn', { timeout: 8000 });
    await wolfPage.click('#wolf-choices .choicebtn');

    await waitText(leader, 'Sheriff campaign', 15000);

    // Leader runs unopposed -> the "ran unopposed" sheriff toast.
    await leader.click('#btn-run');
    await waitToastLogMatch(leader, 'ran unopposed', 12000);
    ok(true, 'the "ran unopposed" sheriff toast appeared in #toast-root');

    // It should visibly transition in (not just exist off-screen/invisible).
    const becameVisible = await leader.waitForFunction(() => {
      const el = document.querySelector('#toast-root .toast');
      return el && el.classList.contains('show');
    }, { timeout: 3000 }).then(() => true).catch(() => false);
    ok(becameVisible, 'the toast gained the "show" class (its slide-in/fade-in transition fired)');

    // And it should auto-dismiss (remove itself from the DOM) with no click,
    // well within the ~4.6s the client schedules for this.
    const autoDismissed = await leader.waitForFunction(() => document.querySelectorAll('#toast-root .toast').length === 0, { timeout: 8000 })
      .then(() => true).catch(() => false);
    ok(autoDismissed, 'the toast auto-dismissed itself (removed from the DOM) without any user action');

    // Play through to the day vote and cast votes, then confirm a SECOND,
    // distinct toast appears for the day-vote outcome.
    await waitText(leader, 'voting', 30000);
    for (const page of [leader, p2, p3, p4]) {
      const btns = page.locator('#vote-choices .choicebtn');
      const count = await btns.count().catch(() => 0);
      if (count > 0) await btns.first().click().catch(() => {});
    }

    const sawDayVoteToast = await waitToastLogMatch(leader, 'voted to eliminate|No votes were cast', 20000).then(() => true).catch(() => false);
    ok(sawDayVoteToast, 'a second, distinct toast appeared for the day-vote outcome');

    const toastLog = await leader.evaluate(() => window.__toastLog);
    ok(Array.isArray(toastLog) && toastLog.length >= 2, `saw at least 2 toasts total over the game (${toastLog ? toastLog.length : 0})`, toastLog);
  } finally {
    await browser.close();
  }

  console.log(`\n${pass}/${pass + fail} checks passed.`);
  if (fail > 0) { console.log('SOME FAILED'); process.exit(1); }
  console.log('ALL GOOD');
})().catch((e) => { console.error(e); process.exit(1); });
