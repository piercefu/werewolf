// Covers the parts of the game that had no test at all before a coverage
// audit: the Fool (survives their first execution, loses their vote, dies on
// the second), the Extinction win condition, discarding the Sheriff badge,
// "Start a new game with this group", and the lobby leader's Remove button
// (which turned out to have never worked — see removePlayer in server.js).
const { api, state, setupRoom, configureAndStart, pollUntil, Tally } = require('./lib');

const t = new Tally();
const auth = (roomCode, p) => ({ roomCode, playerId: p.playerId, token: p.token });
async function rolesOf(roomCode, players, names) {
  const roles = {};
  for (const n of names) roles[n] = (await state(roomCode, players[n].playerId, players[n].token)).you.role;
  return roles;
}
// Everyone alive votes for `target` (who abstains) — resolves immediately.
async function voteOut(roomCode, players, names, target, skip = []) {
  for (const n of names) {
    if (skip.includes(n)) continue;
    if (n === target) await api('player/dayVoteAbstain', auth(roomCode, players[n]));
    else await api('player/dayVote', { ...auth(roomCode, players[n]), targetId: players[target].playerId });
  }
}

// ---------------------------------------------------------------------------
// Fool: first execution -> survives, revealed, loses vote, no last words.
// Next day: can't vote, the vote still resolves without them, and a second
// execution kills them for real.
// ---------------------------------------------------------------------------
async function scenarioFool() {
  const names = ['Al', 'Bea', 'Cid', 'Dia', 'Ed'];
  const { roomCode, players } = await setupRoom(names[0], names.slice(1));
  const leader = players[names[0]];
  await configureAndStart(roomCode, players, names[0], { Werewolf: 1, Fool: 1, Villager: 3 });
  const roles = await rolesOf(roomCode, players, names);
  const fool = names.find((n) => roles[n] === 'Fool');
  const bystander = names.find((n) => n !== fool);

  await pollUntil(roomCode, leader, (v) => v.phase === 'day_vote', { timeoutMs: 20000 });
  await voteOut(roomCode, players, names, fool);
  let v = await state(roomCode, players[bystander].playerId, players[bystander].token);
  const evt = (v.publicEvents || []).find((e) => e.kind === 'vote');
  t.ok(evt && /Fool/.test(evt.text) && evt.text.includes(fool), '[fool] the vote popup announces the Fool surviving', evt);
  const row = v.players.find((p) => p.name === fool);
  t.ok(row.alive && row.role === 'Fool' && row.canVote === false, '[fool] Fool is alive, publicly revealed, and marked as having no vote', row);
  t.ok(!v.lastWords, '[fool] no last-words turn — the Fool didn\'t die', v.lastWords);

  v = await pollUntil(roomCode, leader, (v) => v.phase === 'day_vote' && v.dayNumber === 2, { timeoutMs: 30000 });
  t.ok(v.phase === 'day_vote' && v.dayNumber === 2, '[fool] reached day 2\'s vote', { phase: v.phase, day: v.dayNumber });
  const fv = await state(roomCode, players[fool].playerId, players[fool].token);
  t.ok(fv.dayVoteBlocked === true && !fv.dayVote, '[fool] the Fool gets no vote buttons on day 2', { blocked: fv.dayVoteBlocked });
  const tryVote = await api('player/dayVote', { ...auth(roomCode, players[fool]), targetId: players[bystander].playerId });
  t.ok(!tryVote.ok, '[fool] the server rejects a vote from the Fool', tryVote);

  // Everyone else votes the Fool out again — the vote must resolve without
  // waiting on the Fool (who can't vote).
  const aliveNames = v.players.filter((p) => p.alive).map((p) => p.name);
  await voteOut(roomCode, players, aliveNames, fool, [fool]);
  v = await state(roomCode, leader.playerId, leader.token);
  const row2 = v.players.find((p) => p.name === fool);
  t.ok(!row2.alive, '[fool] a second execution kills the Fool for real (and the vote closed without their ballot)', row2);
  t.ok(v.lastWords && v.lastWords.speakerName === fool, '[fool] ...and this time they get last words', v.lastWords);
  console.log('--- fool scenario done ---');
}

// ---------------------------------------------------------------------------
// Extinction: executing the only "god" wins it for the wolves even though
// they're heavily outnumbered — then "Start a new game" resets cleanly.
// ---------------------------------------------------------------------------
async function scenarioExtinctionAndReset() {
  const names = ['Fa', 'Gi', 'Ho', 'Ix', 'Ju'];
  const { roomCode, players } = await setupRoom(names[0], names.slice(1));
  const leader = players[names[0]];
  const wc = await api('player/setWinCondition', { ...auth(roomCode, leader), mode: 'extinction' });
  t.ok(wc.ok, '[extinction] win condition set to extinction', wc);
  await configureAndStart(roomCode, players, names[0], { Werewolf: 1, Seer: 1, Villager: 3 });
  const roles = await rolesOf(roomCode, players, names);
  const seer = names.find((n) => roles[n] === 'Seer');

  await pollUntil(roomCode, leader, (v) => v.phase === 'day_vote', { timeoutMs: 20000 });
  await voteOut(roomCode, players, names, seer);
  let v = await state(roomCode, leader.playerId, leader.token);
  t.ok(v.phase !== 'game_over', '[extinction] the game waits for the Seer\'s last words before deciding', v.phase);
  await api('player/finishLastWords', auth(roomCode, players[seer]));
  v = await pollUntil(roomCode, leader, (v) => v.phase === 'game_over', { timeoutMs: 5000 });
  t.ok(v.phase === 'game_over' && v.winner === 'wolves', '[extinction] wiping out every god wins it for the wolves (1 wolf vs 3 villagers)', { phase: v.phase, winner: v.winner });
  const maxIdBefore = Math.max(...v.publicEvents.map((e) => e.id));

  // --- Start a new game with this group ---
  const nonLeader = await api('player/resetGame', auth(roomCode, players[names[1]]));
  t.ok(!nonLeader.ok, '[reset] only the lobby leader can start a new game', nonLeader);
  const r = await api('player/resetGame', auth(roomCode, leader));
  t.ok(r.ok, '[reset] leader resets the room', r);
  v = await state(roomCode, players[names[1]].playerId, players[names[1]].token);
  t.ok(v.phase === 'lobby' && v.you.role === null && v.players.every((p) => p.alive && p.role === undefined) && v.sheriffId === null && v.dayNumber === 0,
    '[reset] everyone is back in the lobby: no roles, all alive, no Sheriff', { phase: v.phase, role: v.you.role, day: v.dayNumber });
  t.ok(v.winConditionMode === 'extinction' && v.revealRoleOnDeath === false, '[reset] lobby settings are kept for the next game', { wc: v.winConditionMode, reveal: v.revealRoleOnDeath });
  t.ok((v.publicEvents || []).length === 0, '[reset] old popups are cleared', v.publicEvents);
  const again = await api('player/startGame', auth(roomCode, leader));
  t.ok(again.ok, '[reset] a second game starts in the same room', again);
  v = await state(roomCode, leader.playerId, leader.token);
  const nightEvt = (v.publicEvents || []).find((e) => e.kind === 'night');
  t.ok(v.phase === 'night' && v.dayNumber === 1 && nightEvt && nightEvt.id > maxIdBefore,
    '[reset] second game is at Night 1, and its popups get new ids (so phones still show them)', { phase: v.phase, id: nightEvt && nightEvt.id, maxIdBefore });
  console.log('--- extinction + reset scenario done ---');
}

// ---------------------------------------------------------------------------
// Sheriff badge discarded (by choice) and lost to the timer.
// ---------------------------------------------------------------------------
async function scenarioBadgeDiscard() {
  for (const how of ['discard', 'timeout']) {
    const names = how === 'discard' ? ['Ka', 'Le', 'Mi', 'No', 'Ou'] : ['Pa', 'Qi', 'Ro', 'Su', 'Ty'];
    const { roomCode, players } = await setupRoom(names[0], names.slice(1));
    const leader = players[names[0]];
    await configureAndStart(roomCode, players, names[0], { Werewolf: 1, Villager: 4 });
    const roles = await rolesOf(roomCode, players, names);
    const sheriff = names.find((n) => roles[n] === 'Villager' && n !== names[0]);
    await pollUntil(roomCode, leader, (v) => v.phase === 'campaign', { timeoutMs: 10000 });
    await api('player/runForSheriff', { ...auth(roomCode, players[sheriff]), action: 'run' });
    await pollUntil(roomCode, leader, (v) => v.phase === 'day_vote', { timeoutMs: 25000 });
    await voteOut(roomCode, players, names, sheriff);
    if (how === 'discard') {
      const d = await api('player/sheriffHandoff', { ...auth(roomCode, players[sheriff]), action: 'discard' });
      t.ok(d.ok, '[badge] the executed Sheriff discards the badge', d);
    }
    await api('player/finishLastWords', auth(roomCode, players[sheriff]));
    const v = await pollUntil(roomCode, leader, (v) => v.sheriffId === null && (v.publicEvents || []).some((e) => e.kind === 'badge'), { timeoutMs: 6000 });
    const evt = (v.publicEvents || []).find((e) => e.kind === 'badge');
    t.ok(v.sheriffId === null && evt && /discarded/.test(evt.text) && evt.text.includes(sheriff),
      `[badge ${how}] no Sheriff afterwards, and everyone gets a "badge discarded" popup`, { sheriffId: v.sheriffId, evt });
    const nv = await pollUntil(roomCode, leader, (v) => v.phase === 'night' || v.phase === 'game_over', { timeoutMs: 6000 });
    t.ok(nv.phase === 'night' || nv.phase === 'game_over', `[badge ${how}] the game carries on afterwards`, nv.phase);
  }
  console.log('--- badge discard scenario done ---');
}

// ---------------------------------------------------------------------------
// Lobby leader removes a player.
// ---------------------------------------------------------------------------
async function scenarioRemovePlayer() {
  const names = ['Va', 'We', 'Xu', 'Ya'];
  const { roomCode, players } = await setupRoom(names[0], names.slice(1));
  const leader = players[names[0]];
  const byOther = await api('player/removePlayer', { ...auth(roomCode, players.We), targetId: players.Xu.playerId });
  t.ok(!byOther.ok, '[remove] a non-leader can\'t remove anyone', byOther);
  const self = await api('player/removePlayer', { ...auth(roomCode, leader), targetId: leader.playerId });
  t.ok(!self.ok, '[remove] the leader can\'t remove themselves', self);
  const res = await api('player/removePlayer', { ...auth(roomCode, leader), targetId: players.Xu.playerId });
  t.ok(res.ok, '[remove] the leader removes Xu', res);
  const v = await state(roomCode, leader.playerId, leader.token);
  t.ok(v.players.length === 3 && !v.players.some((p) => p.name === 'Xu'), '[remove] Xu is gone from the lobby', v.players.map((p) => p.name));
  const gone = await state(roomCode, players.Xu.playerId, players.Xu.token);
  t.ok(!gone, '[remove] Xu\'s phone is no longer in the room (it drops back to the menu)', gone && gone.phase);
  await configureAndStart(roomCode, players, names[0], { Werewolf: 1, Villager: 2 });
  const mid = await api('player/removePlayer', { ...auth(roomCode, leader), targetId: players.Ya.playerId });
  t.ok(!mid.ok, '[remove] no removing players once the game has started', mid);
  console.log('--- remove player scenario done ---');
}

// ---------------------------------------------------------------------------
// Werewolf King's kill is immediate and final: the Witch's heal only ever
// applies to the wolves' NIGHT target, so she can't undo it.
// ---------------------------------------------------------------------------
async function scenarioKingKillIsFinal() {
  const names = ['Ki', 'Wi', 'Vo', 'Xa', 'Yu', 'Zo'];
  const { roomCode, players } = await setupRoom(names[0], names.slice(1));
  const leader = players[names[0]];
  // nightAction 3s: long enough to act on the Witch's turn, short enough to keep the test quick.
  await configureAndStart(roomCode, players, names[0], { WerewolfKing: 1, Werewolf: 1, Witch: 1, Villager: 3 }, { nightAction: 3 });
  const roles = await rolesOf(roomCode, players, names);
  const king = names.find((n) => roles[n] === 'WerewolfKing');
  const witch = names.find((n) => roles[n] === 'Witch');
  const victim = names.find((n) => roles[n] === 'Villager');

  await pollUntil(roomCode, leader, (v) => v.phase === 'day_discussion', { timeoutMs: 30000 });
  const r = await api('player/wolfKingReveal', { ...auth(roomCode, players[king]), targetId: players[victim].playerId });
  t.ok(r.ok, '[king] the Werewolf King takes a villager down during the day', r);
  let v = await state(roomCode, leader.playerId, leader.token);
  t.ok(!v.players.find((p) => p.name === victim).alive, '[king] the victim is dead immediately — no waiting for night', v.players.find((p) => p.name === victim));

  // Let the day finish (last words, discussion, vote) and get to the Witch's turn.
  await api('player/finishLastWords', auth(roomCode, players[king]));
  await api('player/finishLastWords', auth(roomCode, players[victim]));
  const wv = await pollUntil(roomCode, players[witch], (v) => v.phase === 'night' && v.witchPhase, { timeoutMs: 40000 });
  t.ok(!!(wv && wv.witchPhase), '[king] reached the Witch\'s turn the following night', wv && wv.phase);
  t.ok(!wv.witchPhase.revealedVictim || wv.witchPhase.revealedVictim.name !== victim,
    '[king] the Witch is NOT offered the King\'s victim to save (she only sees the wolves\' night target)', wv.witchPhase);
  const heal = await api('player/witchAction', { ...auth(roomCode, players[witch]), action: 'heal' });
  t.ok(!heal.ok, '[king] a heal attempt does nothing for the King\'s victim (nobody was attacked tonight)', heal);
  v = await pollUntil(roomCode, leader, (v) => v.phase !== 'night', { timeoutMs: 20000 });
  t.ok(!v.players.find((p) => p.name === victim).alive, '[king] the King\'s victim is still dead the next morning', { phase: v.phase });
  console.log('--- wolf king kill is final scenario done ---');
}

// ---------------------------------------------------------------------------
// Multiple Hunters (fun variant): the lobby allows 2+, a Hunter shot by
// another Hunter gets their own shot, and every queued turn (shots and last
// words) gets its full time from when it actually becomes that player's turn.
// ---------------------------------------------------------------------------
async function scenarioMultiHunter() {
  const names = ['Ha', 'Hb', 'Hc', 'Hd', 'He', 'Hf'];
  const { roomCode, players } = await setupRoom(names[0], names.slice(1));
  const leader = players[names[0]];
  const cfg = await api('player/setRoleConfig', { ...auth(roomCode, leader), roleConfig: { Werewolf: 1, Hunter: 2, Villager: 3 } });
  t.ok(cfg.ok, '[hunters] the lobby accepts 2 Hunters', cfg);
  const lv = await state(roomCode, leader.playerId, leader.token);
  t.ok(lv.lobby.roleConfig.Hunter === 2, '[hunters] ...and keeps it at 2 (no longer capped at 1)', lv.lobby.roleConfig);
  await configureAndStart(roomCode, players, names[0], { Werewolf: 1, Hunter: 2, Villager: 3 }, { speech: 3, nightAction: 3 });
  const roles = await rolesOf(roomCode, players, names);
  const [h1, h2] = names.filter((n) => roles[n] === 'Hunter');
  const villager = names.find((n) => roles[n] === 'Villager');
  t.ok(h1 && h2, '[hunters] two different players were dealt the Hunter', roles);

  await pollUntil(roomCode, leader, (v) => v.phase === 'day_vote', { timeoutMs: 40000 });
  await voteOut(roomCode, players, names, h1);
  const s1 = await api('player/hunterShoot', { ...auth(roomCode, players[h1]), targetId: players[h2].playerId });
  t.ok(s1.ok, '[hunters] the executed Hunter shoots the other Hunter', s1);
  const h2v = await state(roomCode, players[h2].playerId, players[h2].token);
  t.ok(h2v.hunterShot && h2v.hunterShot.active, '[hunters] the second Hunter now gets their own shot', h2v.hunterShot);
  const s2 = await api('player/hunterShoot', { ...auth(roomCode, players[h2]), targetId: players[villager].playerId });
  t.ok(s2.ok, '[hunters] ...and fires it', s2);
  let v = await state(roomCode, leader.playerId, leader.token);
  const shots = (v.publicEvents || []).filter((e) => e.kind === 'hunter');
  t.ok(shots.length === 2 && shots[0].text.includes(h1) && shots[1].text.includes(h2), '[hunters] both shots get their own popup, in order', shots.map((e) => e.text));
  t.ok([h1, h2, villager].every((n) => !v.players.find((p) => p.name === n).alive), '[hunters] all three are dead');

  // Three last-words turns are now queued (h1, h2, villager). Let the first
  // speaker use most of their time; the next one must still get a full turn.
  await new Promise((r) => setTimeout(r, 2200));
  await api('player/finishLastWords', auth(roomCode, players[h1]));
  v = await state(roomCode, leader.playerId, leader.token);
  t.ok(v.lastWords && v.lastWords.speakerName === h2 && v.lastWords.secondsLeft >= 2,
    '[queue] the next speaker gets a fresh full turn, not what was left over while waiting', v.lastWords);
  await api('player/finishLastWords', auth(roomCode, players[h2]));
  await api('player/finishLastWords', auth(roomCode, players[villager]));
  v = await pollUntil(roomCode, leader, (v) => v.phase === 'night' || v.phase === 'game_over', { timeoutMs: 6000 });
  t.ok(v.phase === 'night' || v.phase === 'game_over', '[hunters] the day wraps up normally afterwards', v.phase);
  console.log('--- multiple hunters scenario done ---');
}

(async () => {
  await scenarioMultiHunter();
  await scenarioKingKillIsFinal();
  await scenarioRemovePlayer();
  await scenarioFool();
  await scenarioExtinctionAndReset();
  await scenarioBadgeDiscard();
  t.finish();
})().catch((e) => { console.error(e); process.exit(1); });
