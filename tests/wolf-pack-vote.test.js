// Live wolf-pack vote visibility: wolves see each other's current picks in
// real time, can change votes freely, and the phase only auto-advances once
// the whole pack actually agrees on the same target.
const { api, state, sleep, setupRoom, pollUntil, Tally } = require('./lib');

const t = new Tally();

(async () => {
  // 2 Werewolves + 3 Villagers, so the pack has more than one member.
  const { roomCode, players } = await setupRoom('Leader', ['Bo', 'Cy', 'Dee', 'Eli']);
  const leader = players.Leader;
  await api('player/setRoleConfig', { roomCode, playerId: leader.playerId, token: leader.token, roleConfig: { Werewolf: 2, Villager: 3 } });
  await api('player/setTimers', { roomCode, playerId: leader.playerId, token: leader.token, timers: { candidacy: 1, electionVote: 1, nightAction: 5, dayVote: 1, speech: 1 } });
  const startRes = await api('player/startGame', { roomCode, playerId: leader.playerId, token: leader.token });
  t.ok(startRes.ok, '[pack] 2 Werewolf + 3 Villager game started', startRes);

  const allNames = ['Leader', 'Bo', 'Cy', 'Dee', 'Eli'];
  const wolfNames = [];
  for (const n of allNames) {
    const v = await state(roomCode, players[n].playerId, players[n].token);
    if (v.you.role === 'Werewolf') wolfNames.push(n);
  }
  t.ok(wolfNames.length === 2, '[pack] found 2 wolves', wolfNames);
  const [w1n, w2n] = wolfNames;
  const w1 = players[w1n], w2 = players[w2n];
  const villagerNames = allNames.filter((n) => !wolfNames.includes(n));
  const targetA = players[villagerNames[0]];
  const targetB = players[villagerNames[1]];

  // Wolf 1 votes for target A.
  await api('player/wolfVote', { roomCode, playerId: w1.playerId, token: w1.token, targetId: targetA.playerId });

  // Wolf 2 should immediately see wolf 1's live pick without having voted themselves.
  let v2 = await state(roomCode, w2.playerId, w2.token);
  t.ok(!!v2.wolfPhase, '[pack] wolf 2 has an active wolfPhase');
  const w1StatusBefore = v2.wolfPhase.packStatus.find((s) => s.id === w1.playerId);
  t.ok(w1StatusBefore && w1StatusBefore.targetId === targetA.playerId, '[pack] wolf 2 sees wolf 1\'s live pick (target A) before voting themselves', w1StatusBefore);
  const candA = v2.wolfPhase.candidates.find((c) => c.id === targetA.playerId);
  t.ok(candA && candA.votedBy.includes(w1n), '[pack] target A candidate shows wolf 1 in votedBy', candA);

  // Wolf 2 disagrees and votes for target B instead — the phase must NOT
  // auto-advance, since the pack hasn't actually converged yet.
  await api('player/wolfVote', { roomCode, playerId: w2.playerId, token: w2.token, targetId: targetB.playerId });
  await sleep(200);
  let v1 = await state(roomCode, w1.playerId, w1.token);
  t.ok(!!v1.wolfPhase, '[pack] phase has NOT auto-advanced while the pack disagrees (A vs B), even though both have voted');
  const w2StatusForW1 = v1.wolfPhase && v1.wolfPhase.packStatus.find((s) => s.id === w2.playerId);
  t.ok(w2StatusForW1 && w2StatusForW1.targetId === targetB.playerId, '[pack] wolf 1 sees wolf 2\'s live pick (target B) despite disagreement', w2StatusForW1);

  // Wolf 1 changes their mind to match wolf 2's pick — now the pack is
  // unanimous, and this final matching vote should trigger the advance.
  await api('player/wolfVote', { roomCode, playerId: w1.playerId, token: w1.token, targetId: targetB.playerId });
  let sawAdvance = false;
  for (let deadline = Date.now() + 5000; Date.now() < deadline; ) {
    const v = await state(roomCode, leader.playerId, leader.token);
    if (v.nightSubPhase !== 'wolves') { sawAdvance = true; break; }
    await sleep(150);
  }
  t.ok(sawAdvance, '[pack] once the pack converges on the same target (even after switching), the wolves sub-phase advances immediately');

  await selfKillScenario();
  t.finish();
})().catch((e) => { console.error(e); process.exit(1); });

// A wolf can vote to kill themselves ("self-kill"), and can target a fellow
// wolf. With the pack agreeing on wolf A, wolf A dies overnight.
async function selfKillScenario() {
  const names = ['Ma', 'Ni', 'Os', 'Pe', 'Qu'];
  const { roomCode, players } = await setupRoom(names[0], names.slice(1));
  const L = players[names[0]];
  await api('player/setRoleConfig', { roomCode, playerId: L.playerId, token: L.token, roleConfig: { Werewolf: 2, Villager: 3 } });
  await api('player/setTimers', { roomCode, playerId: L.playerId, token: L.token, timers: { candidacy: 1, electionVote: 1, nightAction: 5, dayVote: 1, speech: 1 } });
  await api('player/startGame', { roomCode, playerId: L.playerId, token: L.token });
  const wolves = [];
  for (const n of names) if ((await state(roomCode, players[n].playerId, players[n].token)).you.role === 'Werewolf') wolves.push(n);
  const [a, b] = wolves;
  const va = await state(roomCode, players[a].playerId, players[a].token);
  const selfEntry = va.wolfPhase.candidates.find((c) => c.id === players[a].playerId);
  t.ok(selfEntry && selfEntry.isYou === true, '[self-kill] a wolf sees THEMSELVES on the kill screen, marked as "you"', va.wolfPhase.candidates);
  t.ok(va.wolfPhase.candidates.some((c) => c.id === players[b].playerId), '[self-kill] ...and their fellow wolf too', va.wolfPhase.candidates);
  const r1 = await api('player/wolfVote', { roomCode, playerId: players[a].playerId, token: players[a].token, targetId: players[a].playerId });
  t.ok(r1.ok, '[self-kill] the server accepts a wolf voting to kill themselves', r1);
  const r2 = await api('player/wolfVote', { roomCode, playerId: players[b].playerId, token: players[b].token, targetId: players[a].playerId });
  t.ok(r2.ok, '[self-kill] the other wolf votes to kill their teammate', r2);
  const deadA = await pollUntil(roomCode, L, (v) => v.phase === 'day_discussion' || v.phase === 'game_over', { timeoutMs: 15000 });
  const rowA = deadA.players.find((p) => p.name === a);
  t.ok(rowA && rowA.alive === false, `[self-kill] the self-killed wolf (${a}) died overnight`, { phase: deadA.phase, row: rowA });
  const dawn = (deadA.publicEvents || []).find((e) => e.kind === 'dawn');
  t.ok(dawn && dawn.text.includes(a) && !/wolf/i.test(dawn.text), '[self-kill] the dawn popup just says they died — not how, or that they were a wolf', dawn);
}
