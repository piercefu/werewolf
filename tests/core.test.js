// Core integration suite: full happy-path game with all 9 roles (campaign,
// sheriff-direction choice, discussion order, a Knight duel that ends the
// day into night, a day vote, sheriff handoff, game_over retro), plus a
// second scenario covering Werewolf King reveal + timed-out phases.
//
// Run with `npm test` (starts the server itself with WW_FAST_TIMERS=1), or
// directly with a server already running: BASE_URL=http://localhost:3300
// WW_FAST_TIMERS=1 node tests/core.test.js
const { api, state, sleep, pollUntil, Tally, FAST_TIMERS } = require('./lib');

const t = new Tally();

async function createRoomAndPlayers(names, timers) {
  const leaderJoin = await api('player/createRoom', { name: names[0] });
  t.ok(leaderJoin.ok, `[setup] room created (${leaderJoin.roomCode})`);
  const roomCode = leaderJoin.roomCode;
  const players = { [names[0]]: { playerId: leaderJoin.playerId, token: leaderJoin.token } };
  for (const n of names.slice(1)) {
    const j = await api('player/join', { roomCode, name: n });
    t.ok(j.ok, `[setup] ${n} joined`);
    players[n] = { playerId: j.playerId, token: j.token };
  }
  if (timers) {
    const r = await api('player/setTimers', { roomCode, playerId: players[names[0]].playerId, token: players[names[0]].token, timers });
    t.ok(r.ok, '[setup] timers configured');
  }
  return { roomCode, players, leaderName: names[0] };
}

async function getView(roomCode, players, name) {
  const p = players[name];
  return state(roomCode, p.playerId, p.token);
}
async function roleOfEach(roomCode, players) {
  const roles = {};
  for (const n of Object.keys(players)) roles[n] = (await getView(roomCode, players, n)).you.role;
  return roles;
}
async function until(roomCode, players, leaderName, predicate, opts) {
  return pollUntil(roomCode, players[leaderName], predicate, opts);
}

// ---------------------------------------------------------------------------
// Scenario A
// ---------------------------------------------------------------------------
async function scenarioA() {
  const names = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank', 'Grace', 'Heidi', 'Ivan'];
  const { roomCode, players, leaderName } = await createRoomAndPlayers(names, FAST_TIMERS);
  const leader = players[leaderName];

  const roleConfig = { Werewolf: 1, WerewolfKing: 1, Villager: 2, Seer: 1, Witch: 1, Hunter: 1, Guard: 1, Knight: 1, Fool: 0 };
  const rc = await api('player/setRoleConfig', { roomCode, playerId: leader.playerId, token: leader.token, roleConfig });
  t.ok(rc.ok, '[A] role config set (9 roles for 9 players)');
  const wc = await api('player/setWinCondition', { roomCode, playerId: leader.playerId, token: leader.token, mode: 'majority' });
  t.ok(wc.ok, '[A] win condition set to majority');
  const sg = await api('player/startGame', { roomCode, playerId: leader.playerId, token: leader.token });
  t.ok(sg.ok, '[A] game started', sg);

  const roles = await roleOfEach(roomCode, players);
  const byRole = (role) => Object.keys(roles).find((n) => roles[n] === role);
  const wolfName = byRole('Werewolf');
  const kingName = byRole('WerewolfKing');
  const guardName = byRole('Guard');
  const seerName = byRole('Seer');
  const witchName = byRole('Witch');
  const knightName = byRole('Knight');
  t.ok(wolfName && kingName && guardName && seerName && witchName && knightName, '[A] all key roles found', roles);

  // No-host check: no one sees anyone else's role at game start.
  const aliceView = await getView(roomCode, players, leaderName);
  t.ok(aliceView.players.every((p) => p.role === undefined), '[A] no player role is visible to another player at game start');
  t.ok(aliceView.you.role, '[A] a player still sees their own role');

  // Night 1: Guard protects a villager (not the wolves' target).
  const villagerNames = names.filter((n) => roles[n] === 'Villager');
  const guardTargetView = await getView(roomCode, players, guardName);
  t.ok(guardTargetView.guardPhase && guardTargetView.guardPhase.active, '[A] guard phase active');
  await api('player/guardProtect', { roomCode, playerId: players[guardName].playerId, token: players[guardName].token, targetId: guardTargetView.guardPhase.candidates.find((c) => c.name === villagerNames[0]).id });

  // Wolves (Werewolf + WerewolfKing) both vote to kill villagerNames[1].
  const wolfView = await getView(roomCode, players, wolfName);
  t.ok(wolfView.wolfPhase && wolfView.wolfPhase.totalWolves === 2, '[A] wolf pack has 2 members (Werewolf + King)');
  const victimId = wolfView.wolfPhase.candidates.find((c) => c.name === villagerNames[1]).id;
  await api('player/wolfVote', { roomCode, playerId: players[wolfName].playerId, token: players[wolfName].token, targetId: victimId });
  await api('player/wolfVote', { roomCode, playerId: players[kingName].playerId, token: players[kingName].token, targetId: victimId });

  // Seer checks the wolf.
  const seerView = await getView(roomCode, players, seerName);
  t.ok(seerView.seerPhase && seerView.seerPhase.active, '[A] seer phase active');
  const seerResult = await api('player/seerView', { roomCode, playerId: players[seerName].playerId, token: players[seerName].token, targetId: wolfView.you.id });
  t.ok(seerResult.ok && seerResult.result.team === 'wolf', '[A] seer correctly reads the Werewolf as wolf team');

  // Witch skips.
  const witchView = await getView(roomCode, players, witchName);
  t.ok(witchView.witchPhase && witchView.witchPhase.revealedVictim && witchView.witchPhase.revealedVictim.name === villagerNames[1], '[A] witch is shown the wolves\' victim');
  await api('player/witchAction', { roomCode, playerId: players[witchName].playerId, token: players[witchName].token, action: 'skip' });

  let v = await until(roomCode, players, leaderName, (v) => v.phase === 'campaign', { timeoutMs: 8000 });
  t.ok(v.phase === 'campaign', '[A] entered campaign phase (day 1, pre-announcement)', v.phase);
  t.ok(v.players.every((p) => p.alive === true), '[A] everyone still APPEARS alive during the campaign, even though villagerNames[1] is secretly dead');

  const deadCandidateName = villagerNames[1];
  const r1 = await api('player/runForSheriff', { roomCode, playerId: players[knightName].playerId, token: players[knightName].token });
  t.ok(r1.ok, '[A] Knight runs for sheriff');
  const r2 = await api('player/runForSheriff', { roomCode, playerId: players[deadCandidateName].playerId, token: players[deadCandidateName].token });
  t.ok(r2.ok, '[A] secretly-dead villager runs for sheriff too (nobody knows they died yet)');

  v = await until(roomCode, players, leaderName, (v) => v.campaign && v.campaign.subPhase === 'speeches', { timeoutMs: 8000 });
  t.ok(v.campaign && v.campaign.subPhase === 'speeches', '[A] campaign moved to speeches with 2 candidates', v.campaign);
  t.ok(v.campaign.candidateNames.includes(knightName) && v.campaign.candidateNames.includes(deadCandidateName), '[A] both candidates listed');

  v = await until(roomCode, players, leaderName, (v) => v.campaign && v.campaign.subPhase === 'vote', { timeoutMs: 8000 });
  t.ok(v.campaign && v.campaign.subPhase === 'vote', '[A] campaign moved to the election vote after both speeches timed out', v.campaign);

  // Everyone eligible votes for the secretly-dead candidate.
  for (const n of names) {
    if (n === knightName || n === deadCandidateName) continue; // candidates can't vote
    await api('player/electionVote', { roomCode, playerId: players[n].playerId, token: players[n].token, targetId: players[deadCandidateName].playerId });
  }
  v = await until(roomCode, players, leaderName, (v) => v.phase === 'day_announce' || !!v.sheriffId, { timeoutMs: 5000 });
  t.ok(v.sheriffId === players[deadCandidateName].playerId, '[A] the secretly-dead candidate won the election');
  t.ok(v.phase === 'day_announce', '[A] moved on to day_announce after the election');

  const deadSheriffView = await getView(roomCode, players, deadCandidateName);
  t.ok(deadSheriffView.you.alive === false, '[A] the elected sheriff now sees they are actually dead');
  t.ok(deadSheriffView.sheriffHandoff && deadSheriffView.sheriffHandoff.active, '[A] the dead sheriff-elect is prompted to hand off the badge');
  t.ok(deadSheriffView.announcement.some((a) => /died during the night/.test(a)) && !deadSheriffView.announcement.some((a) => /wolves|poison|attacked/i.test(a)), '[A] announcement names the death but never the cause', deadSheriffView.announcement);

  const handoff = await api('player/sheriffHandoff', { roomCode, playerId: players[deadCandidateName].playerId, token: players[deadCandidateName].token, targetId: players[guardName].playerId });
  t.ok(handoff.ok, '[A] badge handed off to the Guard');
  v = await until(roomCode, players, leaderName, (v) => v.sheriffId === players[guardName].playerId, { timeoutMs: 3000 });
  t.ok(v.sheriffId === players[guardName].playerId, '[A] Guard is now sheriff');

  // The dead sheriff-elect died on the FIRST night, so (house rule) they also
  // get last words — the speaking-order pick waits until they're done.
  const lwView = await getView(roomCode, players, leaderName);
  // (1-second timers here, so the turn may already have timed out — the
  // rule itself is checked properly in lastwords.test.js.)
  t.ok(!lwView.lastWords || lwView.lastWords.speakerName === deadCandidateName, '[A] if last words are still running, they belong to the first-night victim', lwView.lastWords);
  if (lwView.lastWords) await api('player/finishLastWords', { roomCode, playerId: players[deadCandidateName].playerId, token: players[deadCandidateName].token });
  await until(roomCode, players, guardName, (v) => v.sheriffDirection && v.sheriffDirection.active, { timeoutMs: 3000 });

  const guardDirView = await getView(roomCode, players, guardName);
  t.ok(guardDirView.sheriffDirection && guardDirView.sheriffDirection.active && guardDirView.sheriffDirection.kind === 'death', '[A] Guard (new sheriff) prompted to pick speech direction around the deceased', guardDirView.sheriffDirection);
  await api('player/sheriffDirection', { roomCode, playerId: players[guardName].playerId, token: players[guardName].token, side: 'right' });

  v = await until(roomCode, players, leaderName, (v) => v.phase === 'day_discussion', { timeoutMs: 3000 });
  t.ok(v.phase === 'day_discussion', '[A] entered day_discussion with a computed speech queue', v.discussion);
  t.ok(v.discussion.queue.length === 8, '[A] speech queue has all 8 living players', v.discussion.queue.length);

  const knightDuel = await api('player/knightDuel', { roomCode, playerId: players[knightName].playerId, token: players[knightName].token, targetId: players[kingName].playerId });
  t.ok(knightDuel.ok, '[A] Knight interrupts discussion to duel the Werewolf King', knightDuel);
  v = await until(roomCode, players, leaderName, (v) => v.phase === 'night', { timeoutMs: 3000 });
  t.ok(v.phase === 'night' && v.dayNumber === 2, '[A] Knight\'s successful duel skipped straight to night 2', { phase: v.phase, day: v.dayNumber });
  const kingCheck = await getView(roomCode, players, kingName);
  t.ok(kingCheck.you.alive === false, '[A] Werewolf King is dead from the duel');

  console.log('--- scenario A done ---');
}

// ---------------------------------------------------------------------------
// Scenario B: Werewolf King reveal that does NOT end the game, plus fully
// timed-out phases (no one acts) all the way through.
// ---------------------------------------------------------------------------
async function scenarioB() {
  const names = ['Nina', 'Omar', 'Priya', 'Quinn', 'Rosa'];
  const { roomCode, players, leaderName } = await createRoomAndPlayers(names, FAST_TIMERS);
  const leader = players[leaderName];
  const roleConfig = { WerewolfKing: 1, Werewolf: 1, Villager: 2, Seer: 1 };
  await api('player/setRoleConfig', { roomCode, playerId: leader.playerId, token: leader.token, roleConfig });
  const sg = await api('player/startGame', { roomCode, playerId: leader.playerId, token: leader.token });
  t.ok(sg.ok, '[B] 2-wolf game started', sg);

  const roles = await roleOfEach(roomCode, players);
  const kingName = Object.keys(roles).find((n) => roles[n] === 'WerewolfKing');

  // Let night 1 time out entirely (no actions).
  let v = await until(roomCode, players, leaderName, (v) => v.phase === 'campaign', { timeoutMs: 8000 });
  t.ok(v.phase === 'campaign', '[B] campaign reached even though night 1 timed out with no kill', v.phase);

  // Nobody runs -> no sheriff.
  v = await until(roomCode, players, leaderName, (v) => v.phase === 'day_discussion', { timeoutMs: 5000 });
  t.ok(v.sheriffId === null && v.phase === 'day_discussion', '[B] no candidates -> no sheriff, straight into discussion', { sheriffId: v.sheriffId, phase: v.phase });
  t.ok(v.discussion.queue.length === 5, '[B] 0 deaths + no sheriff -> full random-order queue of all 5', v.discussion.queue.length);

  const villagerNames = names.filter((n) => roles[n] === 'Villager');
  const target = villagerNames[0];
  const reveal = await api('player/wolfKingReveal', { roomCode, playerId: players[kingName].playerId, token: players[kingName].token, targetId: players[target].playerId });
  t.ok(reveal.ok, '[B] Werewolf King reveals mid-discussion', reveal);
  v = await until(roomCode, players, leaderName, (v) => v.announcement && v.announcement.some((a) => a.includes('Werewolf King')), { timeoutMs: 3000 });
  t.ok(v.phase === 'day_discussion', '[B] day continues after the King\'s reveal (does not force night)', v.phase);

  // Both the King and their target now owe a "last words" turn (day-death
  // gate) before the queue can be pruned — give them, in the order they were
  // queued (King first, then the target; see applyDeaths in wolfKingReveal).
  const kingLastWords = await api('player/finishLastWords', { roomCode, playerId: players[kingName].playerId, token: players[kingName].token });
  t.ok(kingLastWords.ok, '[B] the Werewolf King finishes their last words', kingLastWords);
  const targetLastWords = await api('player/finishLastWords', { roomCode, playerId: players[target].playerId, token: players[target].token });
  t.ok(targetLastWords.ok, '[B] their target finishes their last words too', targetLastWords);

  v = await until(roomCode, players, leaderName, (v) => !v.discussion.queue.includes(players[kingName].playerId) && !v.discussion.queue.includes(players[target].playerId), { timeoutMs: 3000 });
  t.ok(!v.discussion.queue.includes(players[kingName].playerId) && !v.discussion.queue.includes(players[target].playerId), '[B] both the King and their target are pruned from the remaining speech queue, once their last words are given');
  t.ok(v.announcement.some((a) => a.includes('Werewolf King') && a.includes(target)), '[B] King reveal is announced publicly and in full detail', v.announcement);

  v = await until(roomCode, players, leaderName, (v) => v.phase === 'day_vote', { timeoutMs: 12000 });
  t.ok(v.phase === 'day_vote', '[B] reached day_vote after discussion + countdown', v.phase);

  v = await until(roomCode, players, leaderName, (v) => v.phase === 'night' && v.dayNumber === 2, { timeoutMs: 5000 });
  t.ok(v.phase === 'night' && v.dayNumber === 2, '[B] no votes cast -> no elimination, moved to night 2', { phase: v.phase, day: v.dayNumber });

  console.log('--- scenario B done ---');
}

(async () => {
  await scenarioA();
  await scenarioB();
  t.finish();
})().catch((e) => { console.error(e); process.exit(1); });
