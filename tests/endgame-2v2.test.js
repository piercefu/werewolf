// Verifies a specific late-game edge case the user was worried about.
//
// Starting population: 2 Werewolves + 3 Villagers (5 alive) — NOT yet a
// terminal population under the default 'majority' win condition (wolves
// only win once they equal or outnumber the village, i.e. at 2v2). A day
// vote is about to decide which way this goes:
//
//  - Scenario A (the case the user specifically asked about): the village
//    correctly votes out a Werewolf, with a weighted tally of 2.5 (a
//    Sheriff-villager's 1.5x vote plus a regular villager's 1x) against a
//    competing tally of 2 for a villager the wolves targeted. 2.5 > 2 is a
//    clean win for the village's choice, not a tie. Afterward: 1 Werewolf +
//    3 Villagers remain (1v3) — the game must NOT end here (wolves neither
//    hit 0 nor equal/outnumber the village) and must continue into night 2.
//    This directly checks that the vote's WEIGHTED TALLY (2.5 vs 2, used
//    only to pick who gets eliminated) is never confused with the ACTUAL
//    POST-VOTE ALIVE HEADCOUNT (1 wolf vs 3 villagers) that the win
//    condition itself is computed from — those are two entirely different
//    numbers computed by two entirely different functions.
//
//  - Scenario B (the contrasting case, so the boundary is fully verified):
//    the same starting population, but the vote instead eliminates a
//    Villager. Afterward: 2 Werewolves + 2 Villagers remain (2v2) — under
//    the default majority rule, the werewolves equaling the village IS a
//    win condition, so the game SHOULD end here, immediately, in the
//    werewolves' favor. (This is the "werewolves win by [population] tying"
//    the user described as the normal/expected case.)
const { api, state, sleep, setupRoom, configureAndStart, pollUntil, Tally } = require('./lib');

const t = new Tally();

async function rolesOf(roomCode, players, names) {
  const roles = {};
  for (const n of names) {
    const v = await state(roomCode, players[n].playerId, players[n].token);
    roles[n] = v.you.role;
  }
  return roles;
}

// Common setup: 2 Werewolves + 3 Villagers, night 1 times out with no kill,
// one villager runs unopposed for Sheriff, reach day_vote with all 5 alive.
async function setupFiveAlive(tag) {
  const names = ['A', 'B', 'C', 'D', 'E'];
  const { roomCode, players } = await setupRoom(names[0], names.slice(1));
  const leader = players[names[0]];
  await configureAndStart(roomCode, players, names[0], { Werewolf: 2, Villager: 3 });

  const roles = await rolesOf(roomCode, players, names);
  const wolves = names.filter((n) => roles[n] === 'Werewolf');
  const villagers = names.filter((n) => roles[n] === 'Villager');
  t.ok(wolves.length === 2 && villagers.length === 3, `[${tag} setup] 2 wolves and 3 villagers identified`, roles);

  let v = await pollUntil(roomCode, leader, (v) => v.phase === 'campaign', { timeoutMs: 8000 });
  t.ok(v.phase === 'campaign', `[${tag} setup] reached the campaign after night 1 (no kill)`, v.phase);

  const sheriffVillager = villagers[0];
  const runRes = await api('player/runForSheriff', { roomCode, playerId: players[sheriffVillager].playerId, token: players[sheriffVillager].token, action: 'run' });
  t.ok(runRes.ok, `[${tag} setup] a villager runs for Sheriff`, runRes);

  v = await pollUntil(roomCode, leader, (v) => v.sheriffId === players[sheriffVillager].playerId, { timeoutMs: 8000 });
  t.ok(v.sheriffId === players[sheriffVillager].playerId, `[${tag} setup] that villager is the (unopposed) Sheriff`, v.sheriffId);

  v = await pollUntil(roomCode, leader, (v) => v.phase === 'day_vote', { timeoutMs: 15000 });
  t.ok(v.phase === 'day_vote', `[${tag} setup] reached day_vote with all 5 still alive (not yet terminal — 2 wolves < 3 village)`, v.phase);
  t.ok(v.players.filter((p) => p.alive).length === 5, `[${tag} setup] all 5 players are still alive at the vote`, v.players.filter((p) => p.alive).length);

  return { roomCode, players, leader, wolves, villagers, sheriffVillager };
}

// ---------------------------------------------------------------------------
// Scenario A: village correctly eliminates a wolf via a 2.5-vs-2 weighted
// tally -> 1 wolf vs 3 villagers remain -> game must NOT end.
// ---------------------------------------------------------------------------
async function scenarioA() {
  const { roomCode, players, leader, wolves, villagers, sheriffVillager } = await setupFiveAlive('A');
  const otherVillager = villagers[1];
  const thirdVillager = villagers[2];
  const targetWolf = wolves[0];
  const targetVillager = otherVillager;

  // Villagers gang up on a wolf: Sheriff (1.5) + one more (1) = 2.5.
  await api('player/dayVote', { roomCode, playerId: players[sheriffVillager].playerId, token: players[sheriffVillager].token, targetId: players[targetWolf].playerId });
  await api('player/dayVote', { roomCode, playerId: players[otherVillager].playerId, token: players[otherVillager].token, targetId: players[targetWolf].playerId });
  // Both wolves gang up on the third villager: 1 + 1 = 2.
  await api('player/dayVote', { roomCode, playerId: players[wolves[0]].playerId, token: players[wolves[0]].token, targetId: players[targetVillager].playerId });
  await api('player/dayVote', { roomCode, playerId: players[wolves[1]].playerId, token: players[wolves[1]].token, targetId: players[targetVillager].playerId });
  // The fifth player (third villager) abstains — completes the "everyone's
  // acted" count so the vote resolves immediately.
  const abstainRes = await api('player/dayVoteAbstain', { roomCode, playerId: players[thirdVillager].playerId, token: players[thirdVillager].token });
  t.ok(abstainRes.ok, '[A] fifth player abstains to complete the vote', abstainRes);

  let v = await pollUntil(roomCode, leader, (v) => v.voteResultEvent && v.voteResultEvent.kind === 'day_vote', { timeoutMs: 5000 });
  t.ok(!!v.voteResultEvent, '[A] the vote resolved', v.voteResultEvent);
  t.ok(v.voteResultEvent.text.includes(targetWolf) && /voted to eliminate/.test(v.voteResultEvent.text),
    '[A] the wolf with 2.5 votes against them (not the villager with 2) was eliminated', v.voteResultEvent);

  const sheriffEntry = v.voteResultEvent.breakdown.find((b) => b.voterName === sheriffVillager);
  t.ok(sheriffEntry && sheriffEntry.targetName === targetWolf, '[A] breakdown confirms the 1.5x Sheriff-villager vote went to the wolf', sheriffEntry);
  t.ok(v.phase !== 'game_over', '[A critical] the game did NOT end prematurely — 1 wolf vs 3 villagers is not a win for either side', v.phase);

  // The eliminated wolf gets a "last words" turn before the game proceeds —
  // give it so we can confirm what happens right after, instead of just
  // waiting out its timer.
  const lastWordsRes = await api('player/finishLastWords', { roomCode, playerId: players[targetWolf].playerId, token: players[targetWolf].token });
  t.ok(lastWordsRes.ok, '[A] the eliminated wolf\'s last words resolved', lastWordsRes);

  v = await pollUntil(roomCode, leader, (v) => v.phase === 'night' && v.dayNumber === 2, { timeoutMs: 8000 });
  t.ok(v.phase === 'night' && v.dayNumber === 2, '[A critical] the game correctly continued into night 2', { phase: v.phase, day: v.dayNumber });

  const alive = v.players.filter((p) => p.alive);
  t.ok(alive.length === 4 && alive.filter((p) => wolves.includes(p.name)).length === 1 && alive.filter((p) => villagers.includes(p.name)).length === 3,
    '[A critical] exactly 1 wolf and 3 villagers remain alive (2v3 -> 1v3, correctly non-terminal)', alive.map((p) => p.name));

  console.log('--- scenario A done ---');
}

// ---------------------------------------------------------------------------
// Scenario B (contrast): the village instead eliminates a villager -> 2
// wolves vs 2 villagers remain -> under majority rules, that DOES end the
// game (wolves equal the village), immediately, in the werewolves' favor.
// ---------------------------------------------------------------------------
async function scenarioB() {
  const { roomCode, players, leader, wolves, villagers, sheriffVillager } = await setupFiveAlive('B');
  const otherVillager = villagers[1];
  const targetVillager = villagers[2]; // everyone piles onto this one

  await api('player/dayVote', { roomCode, playerId: players[sheriffVillager].playerId, token: players[sheriffVillager].token, targetId: players[targetVillager].playerId });
  await api('player/dayVote', { roomCode, playerId: players[otherVillager].playerId, token: players[otherVillager].token, targetId: players[targetVillager].playerId });
  await api('player/dayVote', { roomCode, playerId: players[wolves[0]].playerId, token: players[wolves[0]].token, targetId: players[targetVillager].playerId });
  await api('player/dayVote', { roomCode, playerId: players[wolves[1]].playerId, token: players[wolves[1]].token, targetId: players[targetVillager].playerId });
  await api('player/dayVote', { roomCode, playerId: players[targetVillager].playerId, token: players[targetVillager].token, targetId: players[wolves[0]].playerId });

  let v = await pollUntil(roomCode, leader, (v) => v.voteResultEvent && v.voteResultEvent.kind === 'day_vote', { timeoutMs: 5000 });
  t.ok(!!v.voteResultEvent, '[B] the vote resolved', v.voteResultEvent);

  // Same as scenario A: the eliminated villager gets a last-words turn
  // before the win condition is even checked — give it so the game can
  // proceed instead of waiting out its timer.
  const lastWordsRes = await api('player/finishLastWords', { roomCode, playerId: players[targetVillager].playerId, token: players[targetVillager].token });
  t.ok(lastWordsRes.ok, '[B] the eliminated villager\'s last words resolved', lastWordsRes);

  v = await pollUntil(roomCode, leader, (v) => v.phase === 'game_over', { timeoutMs: 8000 });
  t.ok(v.phase === 'game_over', '[B critical] the game DID correctly end once population hit 2 wolves vs 2 villagers', v.phase);
  t.ok(v.winner === 'wolves', '[B critical] the werewolves are declared the winner at a tied 2v2 population', v.winner);

  console.log('--- scenario B done ---');
}

(async () => {
  await scenarioA();
  await scenarioB();
  t.finish();
})().catch((e) => { console.error(e); process.exit(1); });
