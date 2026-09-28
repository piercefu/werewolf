// Checks for two Day-1 ordering/eligibility bugs:
//  1. A Sheriff candidate cannot vote in their own election (server rejects
//     the call, and the view marks canVote:false for them specifically).
//  2. A Hunter killed on night 1 does NOT get their revenge-shot prompt (or
//     ability to fire) until the Day-1 campaign has fully concluded — the
//     campaign must run completely undisturbed first.
const { api, state, sleep, setupRoom, findRoles, Tally } = require('./lib');

const t = new Tally();

(async () => {
  // 1 Werewolf + 1 Hunter + 4 Villagers (6 players) — wolves kill the Hunter
  // on night 1, then a contested Sheriff campaign runs.
  const allNames = ['Leader', 'Bo', 'Cy', 'Dee', 'Eli', 'Fi'];
  const { roomCode, players } = await setupRoom('Leader', allNames.slice(1));
  const leader = players.Leader;
  await api('player/setRoleConfig', { roomCode, playerId: leader.playerId, token: leader.token, roleConfig: { Werewolf: 1, Hunter: 1, Villager: 4 } });
  // nightAction needs real headroom here: the Hunter's shot is deferred and
  // its deadline gets refreshed once the campaign concludes, so it must
  // outlast candidacy+speeches+vote, not just a single phase.
  await api('player/setTimers', { roomCode, playerId: leader.playerId, token: leader.token, timers: { candidacy: 1, electionVote: 1, nightAction: 4, dayVote: 1, speech: 1 } });
  await api('player/startGame', { roomCode, playerId: leader.playerId, token: leader.token });

  const found = await findRoles(roomCode, players, allNames, ['Werewolf', 'Hunter']);
  t.ok(!!found.Werewolf && !!found.Hunter, '[setup] identified Werewolf and Hunter', found);
  const wolf = players[found.Werewolf];
  const hunter = players[found.Hunter];
  const others = allNames.filter((n) => n !== found.Werewolf && n !== found.Hunter);

  // Wolf kills the Hunter on night 1.
  await api('player/wolfVote', { roomCode, playerId: wolf.playerId, token: wolf.token, targetId: hunter.playerId });

  let phase = null;
  for (let deadline = Date.now() + 5000; Date.now() < deadline; ) {
    await sleep(150);
    const v = await state(roomCode, leader.playerId, leader.token);
    phase = v.phase;
    if (phase === 'campaign') break;
  }
  t.ok(phase === 'campaign', '[order] reached the campaign phase after night 1', phase);

  // While still in the campaign, the (now-dead) Hunter must NOT see a
  // hunterShot prompt yet — that would mean their death/revenge shot leaked
  // before the campaign finished.
  const hunterViewDuringCampaign = await state(roomCode, hunter.playerId, hunter.token);
  t.ok(!hunterViewDuringCampaign.hunterShot, '[order] Hunter has NO hunterShot prompt while the campaign is still running', hunterViewDuringCampaign.hunterShot);
  const shootAttempt = await api('player/hunterShoot', { roomCode, playerId: hunter.playerId, token: hunter.token, targetId: players[others[0]].playerId });
  t.ok(shootAttempt.ok === false, '[order] Hunter cannot fire their revenge shot while the campaign is running', shootAttempt);

  // Run a contested campaign: two candidates run (the Hunter's own death is
  // still secret, so they can run too — that part is unchanged/expected).
  const runRes0 = await api('player/runForSheriff', { roomCode, playerId: players[others[0]].playerId, token: players[others[0]].token, action: 'run' });
  const runRes1 = await api('player/runForSheriff', { roomCode, playerId: players[others[1]].playerId, token: players[others[1]].token, action: 'run' });
  t.ok(runRes0.ok && runRes1.ok, '[campaign] two candidates registered to run', { runRes0, runRes1 });

  let voteSub = null;
  for (let deadline = Date.now() + 5000; Date.now() < deadline; ) {
    await sleep(150);
    const v = await state(roomCode, players[others[0]].playerId, players[others[0]].token);
    if (v.campaign && v.campaign.subPhase === 'vote') { voteSub = v.campaign; break; }
    if (v.phase !== 'campaign') break;
  }
  t.ok(!!voteSub, '[campaign] reached the election vote sub-phase with 2 candidates', voteSub);

  if (voteSub) {
    const cand0 = others[0], cand1 = others[1];
    const cand0View = await state(roomCode, players[cand0].playerId, players[cand0].token);
    t.ok(cand0View.campaign && cand0View.campaign.canVote === false, '[vote] a candidate\'s own view shows canVote:false', cand0View.campaign);

    const candVoteAttempt = await api('player/electionVote', { roomCode, playerId: players[cand0].playerId, token: players[cand0].token, targetId: players[cand1].playerId });
    t.ok(candVoteAttempt.ok === false, '[vote] server rejects a candidate\'s vote attempt', candVoteAttempt);

    const nonCandidate = others.find((n) => n !== cand0 && n !== cand1) || found.Hunter;
    const voterAuth = players[nonCandidate];
    const voteRes = await api('player/electionVote', { roomCode, playerId: voterAuth.playerId, token: voterAuth.token, targetId: players[cand0].playerId });
    t.ok(voteRes.ok === true, '[vote] a non-candidate\'s vote is accepted', voteRes);
  }

  // Let the campaign wrap up AND catch the Hunter's revenge-shot prompt
  // becoming active right after. Note: room.phase can stay the string
  // 'campaign' for a moment even after room.campaign itself has gone null
  // (while the deferred hunter shot resolves) — that's an intentional brief
  // transitional state, so we key off view.campaign being gone, not phase.
  let campaignObjectGone = false;
  let hunterShotNowActive = false;
  let lastHunterView = null;
  for (let deadline = Date.now() + 6000; Date.now() < deadline; ) {
    const v = await state(roomCode, hunter.playerId, hunter.token);
    lastHunterView = v;
    if (!v.campaign) campaignObjectGone = true;
    if (v.hunterShot && v.hunterShot.active) { hunterShotNowActive = true; break; }
    await sleep(150);
  }
  t.ok(campaignObjectGone, '[order] the campaign object itself has concluded (view.campaign is gone)');
  t.ok(hunterShotNowActive, '[order] Hunter\'s revenge-shot prompt becomes available only AFTER the campaign concludes',
    { phase: lastHunterView && lastHunterView.phase, hunterShot: lastHunterView && lastHunterView.hunterShot });

  t.finish();
})().catch((e) => { console.error(e); process.exit(1); });
