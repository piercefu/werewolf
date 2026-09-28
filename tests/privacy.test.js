// Checks for:
//  1. The Seer's result persists in view.seerLastResult for the rest of the
//     night (and into the day), surviving a page reload/re-poll — even in a
//     minimal game where the whole night resolves synchronously inside their
//     own click (no Guard/Witch to wait on).
//  2. Day vote view never includes a live tally/breakdown while voting is open.
const { api, state, sleep, setupRoom, findRoles, Tally } = require('./lib');

const t = new Tally();

(async () => {
  const allNames = ['Leader', 'Bo', 'Cy', 'Dee', 'Eli'];
  const { roomCode, players } = await setupRoom('Leader', allNames.slice(1));
  const leader = players.Leader;
  await api('player/setRoleConfig', { roomCode, playerId: leader.playerId, token: leader.token, roleConfig: { Werewolf: 1, Seer: 1, Villager: 3 } });
  await api('player/setTimers', { roomCode, playerId: leader.playerId, token: leader.token, timers: { candidacy: 1, electionVote: 1, nightAction: 3, dayVote: 1, speech: 1 } });
  await api('player/startGame', { roomCode, playerId: leader.playerId, token: leader.token });

  const found = await findRoles(roomCode, players, allNames, ['Werewolf', 'Seer']);
  const wolf = players[found.Werewolf];
  const seer = players[found.Seer];
  const otherName = allNames.find((n) => n !== found.Werewolf && n !== found.Seer);
  const other = players[otherName];

  // Wait for the Seer's turn (may already be gone if the night resolves fast).
  for (let deadline = Date.now() + 4000; Date.now() < deadline; ) {
    const v = await state(roomCode, seer.playerId, seer.token);
    if ((v.seerPhase && v.seerPhase.active && !v.seerPhase.acted) || v.phase !== 'night') break;
    await sleep(100);
  }
  const checkResult = await api('player/seerView', { roomCode, playerId: seer.playerId, token: seer.token, targetId: other.playerId });
  t.ok(checkResult.ok, '[seer] seerView call succeeded', checkResult);

  // Immediately after acting — in a minimal game with no Guard/Witch, the
  // whole night can resolve synchronously inside this very call, so we check
  // the DURABLE view.seerLastResult field, not the transient seerPhase.
  await sleep(200);
  const vAfter = await state(roomCode, seer.playerId, seer.token);
  t.ok(!!vAfter.seerLastResult, '[seer] view.seerLastResult is present even after the night fully resolved', vAfter.phase);
  t.ok(vAfter.seerLastResult && vAfter.seerLastResult.name === otherName, '[seer] seerLastResult is correct', vAfter.seerLastResult);

  // Simulate a "page reload" — poll state again fresh; the result must still
  // be there (the bug: it used to live only in the one-shot POST response).
  await sleep(200);
  const vReload = await state(roomCode, seer.playerId, seer.token);
  t.ok(vReload.seerLastResult && vReload.seerLastResult.name === otherName, '[seer] result survives a fresh state poll ("reload")', vReload.seerLastResult);

  // --- Day vote: no live tally while voting is open ---
  await api('player/wolfVote', { roomCode, playerId: wolf.playerId, token: wolf.token, targetId: other.playerId }).catch(() => {});
  let phase = null;
  for (let deadline = Date.now() + 10000; Date.now() < deadline; ) {
    await sleep(200);
    const v = await state(roomCode, leader.playerId, leader.token);
    phase = v.phase;
    if (phase === 'day_vote') break;
  }
  t.ok(phase === 'day_vote', '[dayvote] reached day_vote', phase);

  if (phase === 'day_vote') {
    const aliveNames = allNames.filter((n) => n !== otherName);
    await api('player/dayVote', { roomCode, playerId: players[aliveNames[0]].playerId, token: players[aliveNames[0]].token, targetId: players[aliveNames[1]].playerId });
    await sleep(200);
    const vVote = await state(roomCode, players[aliveNames[2]].playerId, players[aliveNames[2]].token);
    t.ok(!!vVote.dayVote, '[dayvote] dayVote view present for a voter');
    t.ok(vVote.dayVote && vVote.dayVote.tally === undefined, '[dayvote] no "tally" field is exposed in the view while voting is open', vVote.dayVote);
    t.ok(vVote.dayVote && typeof vVote.dayVote.votedCount === 'number', '[dayvote] votedCount (just a number, not a breakdown) is still present', vVote.dayVote);
  }

  t.finish();
})().catch((e) => { console.error(e); process.exit(1); });
