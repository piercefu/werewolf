// Real-browser check for the center-screen event popup (#event-root) — the
// big "stop the table" notification every player gets for game transitions:
// vote results (with the who-voted-for-whom distribution), Sheriff election,
// dawn, night falling, Hunter/Knight/King abilities, badge handoffs, game
// over. The HTTP-level tests (tests/public-events.test.js, vote-toast.test.js)
// verify the server side; this file watches the real DOM to confirm a popup
// (a) actually renders, (b) animates in ('show'), (c) auto-dismisses on its
// own, and (d) shows the vote distribution. Requires Playwright — see
// tests/README.md.
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  console.log('Playwright is not installed — skipping browser-event-popup.test.js.');
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
  // popup that appears AND fully auto-dismisses between our checks is still
  // caught — this is the log of every popup ever appended to #event-root, in
  // order, for the lifetime of the page.
  await page.addInitScript(() => {
    window.__popupLog = [];
    const attach = () => {
      const root = document.getElementById('event-root');
      if (!root) { setTimeout(attach, 50); return; }
      new MutationObserver((muts) => {
        for (const m of muts) {
          for (const node of m.addedNodes) {
            if (node.nodeType === 1) window.__popupLog.push(node.textContent);
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
async function waitPopupLogMatch(page, pattern, timeout = 15000) {
  await page.waitForFunction((p) => (window.__popupLog || []).some((t) => new RegExp(p).test(t)), pattern, { timeout });
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
    // popup's DOM behavior, not game logic, which other files already cover.
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

    const sawNight = await waitPopupLogMatch(leader, 'Night 1 falls', 5000).then(() => true).catch(() => false);
    ok(sawNight, 'a "Night 1 falls" popup appeared when the game started');

    // Leader runs unopposed -> the "ran unopposed" Sheriff popup.
    await leader.click('#btn-run');
    await waitPopupLogMatch(leader, 'ran unopposed', 15000);
    ok(true, 'the "ran unopposed" Sheriff popup appeared in #event-root');

    // It should visibly animate in (not just exist invisibly).
    const becameVisible = await leader.waitForFunction(() => {
      const el = document.querySelector('#event-root .event-overlay');
      return el && el.classList.contains('show');
    }, { timeout: 3000 }).then(() => true).catch(() => false);
    ok(becameVisible, 'the popup gained the "show" class (its fade/scale-in transition fired)');

    // And it should clear itself with no tap (Sheriff popups stay ~9s; the
    // dawn popup queued behind it then shows and clears too).
    const autoDismissed = await leader.waitForFunction(() => !/ran unopposed/.test(document.getElementById('event-root').textContent), { timeout: 14000 })
      .then(() => true).catch(() => false);
    ok(autoDismissed, 'the popup auto-dismissed itself without any user action');

    // Play through to the day vote and cast votes, then confirm the day-vote
    // popup appears and carries the vote distribution.
    await waitText(leader, 'voting', 30000);
    for (const page of [leader, p2, p3, p4]) {
      const btns = page.locator('#vote-choices .choicebtn');
      const count = await btns.count().catch(() => 0);
      if (count > 0) await btns.first().click().catch(() => {});
    }

    const sawDayVote = await waitPopupLogMatch(leader, 'voted to eliminate|tie|No votes were cast', 30000).then(() => true).catch(() => false);
    ok(sawDayVote, 'a popup appeared for the day-vote outcome');
    const popupLog = await leader.evaluate(() => window.__popupLog);
    const votePopup = (popupLog || []).find((t) => /voted to eliminate|tie/i.test(t));
    ok(!votePopup || /\d+(\.5)? votes?:/.test(votePopup), 'the day-vote popup lists who voted for whom', votePopup);
    ok(Array.isArray(popupLog) && popupLog.length >= 3, `saw several popups over the game (${popupLog ? popupLog.length : 0})`, popupLog);
  } finally {
    await browser.close();
  }

  console.log(`\n${pass}/${pass + fail} checks passed.`);
  if (fail > 0) { console.log('SOME FAILED'); process.exit(1); }
  console.log('ALL GOOD');
})().catch((e) => { console.error(e); process.exit(1); });
