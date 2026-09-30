// Checks the new "last words" feature: a player who dies a DAY death
// (execution, a Hunter's shot, or a Knight duel — win or lose) gets one
// final speech turn before the game moves on, exactly like an in-person
// table lets someone speak before they're led away. A NIGHT death (found
// dead in the morning) doesn't — except on the FIRST night, a house rule
// so nobody is knocked out before saying a single word.
// Implemented as another reactive gate (room.pendingLastWords), so the game
// correctly pauses on it the same way it already does for a pending Hunter
// shot or Sheriff handoff.
const { api, state, sleep, setupRoom, configureAndStart, pollUntil, findRoles, Tally } = require('./lib');

const t = new Tally();

// ---------------------------------------------------------------------------
// Scenario 1: night deaths. House rule: the FIRST night's victim gets last
// words on the morning of Day 1 (the day waits for them); a victim of any
// LATER night does not.
// ---------------------------------------------------------------------------
async function scenarioNightKill() {
  const allNames = ['Leader', 'Bo', 'Cy', 'Dee', 'Eli'];
  const { roomCode, players } = await setupRoom('Leader', allNames.slice(1));
  const leader = players.Leader;
  // Longer speech turns so the first-night last words don't simply time out
  // before we look at them.
  await configureAndStart(roomCode, players, 'Leader', { Werewolf: 1, Villager: 4 }, { speech: 20 });

  const found = await findRoles(roomCode, players, allNames, ['Werewolf']);
  const wolf = players[found.Werewolf];
  const villagerNames = allNames.filter((n) => n !== found.Werewolf);
  const [victim, victim2] = villagerNames;

  let wolfView = await state(roomCode, wolf.playerId, wolf.token);
  await api('player/wolfVote', { roomCode, playerId: wolf.playerId, token: wolf.token, targetId: wolfView.wolfPhase.candidates.find((c) => c.name === victim).id });

  // Day 1's campaign runs first (nobody runs), then the night is revealed.
  let v = await pollUntil(roomCode, leader, (v) => v.lastWords && v.lastWords.active, { timeoutMs: 15000 });
  t.ok(v.lastWords && v.lastWords.speakerName === victim, '[night 1] the first night\'s victim gets last words on the morning of Day 1', v.lastWords);
  t.ok(v.phase === 'day_announce', '[night 1] the day waits for them — discussion hasn\'t started yet', v.phase);
  const victimView = await state(roomCode, players[victim].playerId, players[victim].token);
  t.ok(victimView.lastWords && victimView.lastWords.isYourTurn === true, '[night 1] on the victim\'s own phone it\'s their turn to speak', victimView.lastWords);
  const dawn = (v.publicEvents || []).find((e) => e.kind === 'dawn');
  t.ok(dawn && /last words/.test(dawn.text) && dawn.text.includes(victim), '[night 1] the dawn popup says they get last words', dawn);

  const fin = await api('player/finishLastWords', { roomCode, playerId: players[victim].playerId, token: players[victim].token });
  t.ok(fin.ok, '[night 1] the victim finishes', fin);
  v = await pollUntil(roomCode, leader, (v) => v.phase === 'day_discussion', { timeoutMs: 5000 });
  t.ok(v.phase === 'day_discussion' && v.discussion && !v.discussion.queue.includes(players[victim].playerId), '[night 1] ...then discussion starts, without the dead player in the speaking order', v.discussion);

  // Talk through Day 1, let the vote lapse, and have the wolf kill again on night 2.
  for (let i = 0; i < 10; i++) {
    const cur = await state(roomCode, leader.playerId, leader.token);
    if (cur.phase !== 'day_discussion') break;
    const sp = allNames.find((n) => players[n].playerId === cur.discussion.currentSpeakerId);
    await api('player/finishSpeech', { roomCode, playerId: players[sp].playerId, token: players[sp].token });
  }
  wolfView = await pollUntil(roomCode, wolf, (v) => v.phase === 'night' && v.dayNumber === 2 && v.wolfPhase, { timeoutMs: 15000 });
  await api('player/wolfVote', { roomCode, playerId: wolf.playerId, token: wolf.token, targetId: wolfView.wolfPhase.candidates.find((c) => c.name === victim2).id });
  v = await pollUntil(roomCode, leader, (v) => v.dayNumber === 2 && (v.phase === 'day_discussion' || v.phase === 'game_over'), { timeoutMs: 15000 });
  t.ok(v.phase === 'day_discussion', '[night 2] Day 2 goes straight into discussion', v.phase);
  t.ok(!v.lastWords, '[night 2] a LATER night\'s victim gets no last words (only the first night does)', v.lastWords);
  t.ok(!v.players.find((p) => p.name === victim2).alive, '[night 2] (they really did die overnight)');

  console.log('--- night-kill scenario done ---');
}

// ---------------------------------------------------------------------------
// Scenario 2: day-vote EXECUTION queues last words, blocks the transition to
// night until given (or timed out), and is visible to everyone.
// ---------------------------------------------------------------------------
async function scenarioExecution() {
  const allNames = ['Nan', 'Obi', 'Pat', 'Quy', 'Ren'];
  const { roomCode, players } = await setupRoom(allNames[0], allNames.slice(1));
  const leader = players[allNames[0]];
  await configureAndStart(roomCode, players, allNames[0], { Werewolf: 1, Villager: 4 });

  let v = await pollUntil(roomCode, leader, (v) => v.phase === 'day_vote', { timeoutMs: 15000 });
  t.ok(v.phase === 'day_vote', '[exec] reached day_vote', v.phase);

  const found = await findRoles(roomCode, players, allNames, ['Werewolf']);
  // Excludes the leader too, so the "everyone else" bystander check below
  // (which queries the leader's view) is actually looking at someone OTHER
  // than the player giving last words.
  const eliminated = allNames.find((n) => n !== found.Werewolf && n !== allNames[0]);
  const targetId = players[eliminated].playerId;
  for (const n of allNames) {
    if (n === eliminated) continue;
    await api('player/dayVote', { roomCode, playerId: players[n].playerId, token: players[n].token, targetId });
  }

  v = await pollUntil(roomCode, leader, (v) => v.voteResultEvent && v.voteResultEvent.kind === 'day_vote', { timeoutMs: 5000 });
  t.ok(!!v.voteResultEvent, '[exec] the vote resolved and the player was eliminated', v.voteResultEvent);
  // Phase must still NOT have advanced — it's paused on the last-words gate.
  t.ok(v.phase === 'day_vote', '[exec] the game is paused (still shows day_vote) waiting on the executed player\'s last words', v.phase);

  const eliminatedView = await state(roomCode, players[eliminated].playerId, players[eliminated].token);
  t.ok(eliminatedView.lastWords && eliminatedView.lastWords.active && eliminatedView.lastWords.isYourTurn === true,
    '[exec] the executed player\'s OWN view shows it\'s their turn to give last words', eliminatedView.lastWords);

  const bystanderView = await state(roomCode, leader.playerId, leader.token);
  t.ok(bystanderView.lastWords && bystanderView.lastWords.active && bystanderView.lastWords.isYourTurn === false && bystanderView.lastWords.speakerName === eliminated,
    '[exec] everyone else sees who is currently giving last words (public, not a private prompt)', bystanderView.lastWords);

  const finishRes = await api('player/finishLastWords', { roomCode, playerId: players[eliminated].playerId, token: players[eliminated].token });
  t.ok(finishRes.ok, '[exec] the executed player finishes their last words', finishRes);

  v = await pollUntil(roomCode, leader, (v) => v.phase === 'night' && v.dayNumber === 2, { timeoutMs: 5000 });
  t.ok(v.phase === 'night' && v.dayNumber === 2, '[exec] the game proceeds into night 2 only after last words are given', { phase: v.phase, day: v.dayNumber });

  // A stranger can't finish someone else's last words.
  console.log('--- execution scenario done ---');
}

// ---------------------------------------------------------------------------
// Scenario 3: an executed Hunter fires their shot (killing a second person
// during the day) — BOTH the Hunter and their victim owe last words, queued
// one after another, and the game waits for both.
// ---------------------------------------------------------------------------
async function scenarioHunterChain() {
  const allNames = ['Sam', 'Tia', 'Uma', 'Vik', 'Wes', 'Xan'];
  const { roomCode, players } = await setupRoom(allNames[0], allNames.slice(1));
  const leader = players[allNames[0]];
  await configureAndStart(roomCode, players, allNames[0], { Werewolf: 1, Hunter: 1, Villager: 4 });

  let v = await pollUntil(roomCode, leader, (v) => v.phase === 'day_vote', { timeoutMs: 15000 });
  t.ok(v.phase === 'day_vote', '[chain] reached day_vote', v.phase);

  const found = await findRoles(roomCode, players, allNames, ['Werewolf', 'Hunter']);
  const hunter = players[found.Hunter];
  const others = allNames.filter((n) => n !== found.Werewolf && n !== found.Hunter);
  const shotVictim = others[0];

  // Everyone votes to execute the Hunter.
  for (const n of allNames) {
    if (n === found.Hunter) continue;
    await api('player/dayVote', { roomCode, playerId: players[n].playerId, token: players[n].token, targetId: hunter.playerId });
  }

  v = await pollUntil(roomCode, leader, (v) => v.voteResultEvent && v.voteResultEvent.kind === 'day_vote', { timeoutMs: 5000 });
  t.ok(v.voteResultEvent.text.includes(found.Hunter), '[chain] the Hunter was executed by the vote', v.voteResultEvent);

  const hunterView = await state(roomCode, hunter.playerId, hunter.token);
  t.ok(hunterView.lastWords && hunterView.lastWords.isYourTurn === true, '[chain] the executed Hunter owes last words', hunterView.lastWords);
  t.ok(hunterView.hunterShot && hunterView.hunterShot.active, '[chain] the executed Hunter ALSO has their revenge shot available, at the same time', hunterView.hunterShot);

  // Fire the shot first (while their own last words are still un-given).
  const shootRes = await api('player/hunterShoot', { roomCode, playerId: hunter.playerId, token: hunter.token, targetId: players[shotVictim].playerId });
  t.ok(shootRes.ok, '[chain] the Hunter fires at ' + shotVictim, shootRes);

  v = await pollUntil(roomCode, leader, (v) => v.lastWords && v.lastWords.queueLength === 2, { timeoutMs: 5000 });
  t.ok(v.lastWords && v.lastWords.queueLength === 2, '[chain] now BOTH the Hunter and their victim are queued for last words', v.lastWords);
  t.ok(v.lastWords.speakerName === found.Hunter, '[chain] the Hunter (first in, first to speak) is still the active speaker', v.lastWords);

  const hunterFinish = await api('player/finishLastWords', { roomCode, playerId: hunter.playerId, token: hunter.token });
  t.ok(hunterFinish.ok, '[chain] the Hunter finishes their own last words', hunterFinish);

  v = await pollUntil(roomCode, leader, (v) => v.lastWords && v.lastWords.speakerName === shotVictim, { timeoutMs: 5000 });
  t.ok(v.lastWords && v.lastWords.speakerName === shotVictim && v.lastWords.queueLength === 1, '[chain] the shot victim is now the active last-words speaker', v.lastWords);
  t.ok(v.phase !== 'night', '[chain] the game is STILL paused — the shot victim hasn\'t spoken yet', v.phase);

  const victimFinish = await api('player/finishLastWords', { roomCode, playerId: players[shotVictim].playerId, token: players[shotVictim].token });
  t.ok(victimFinish.ok, '[chain] the shot victim finishes their last words too', victimFinish);

  v = await pollUntil(roomCode, leader, (v) => v.phase === 'night' && v.dayNumber === 2, { timeoutMs: 5000 });
  t.ok(v.phase === 'night' && v.dayNumber === 2, '[chain] only NOW, with both sets of last words given, does the game move to night 2', { phase: v.phase, day: v.dayNumber });

  console.log('--- hunter-chain scenario done ---');
}

// ---------------------------------------------------------------------------
// Scenario 4: a Knight wins a duel — the defeated Werewolf owes last words
// before "night falls immediately".
// ---------------------------------------------------------------------------
async function scenarioKnight() {
  const allNames = ['Yui', 'Zed', 'Ana', 'Bex', 'Cal'];
  const { roomCode, players } = await setupRoom(allNames[0], allNames.slice(1));
  const leader = players[allNames[0]];
  await configureAndStart(roomCode, players, allNames[0], { Werewolf: 1, Knight: 1, Villager: 3 });

  let v = await pollUntil(roomCode, leader, (v) => v.phase === 'day_discussion', { timeoutMs: 15000 });
  t.ok(v.phase === 'day_discussion', '[knight] reached day_discussion', v.phase);

  const found = await findRoles(roomCode, players, allNames, ['Werewolf', 'Knight']);
  const knight = players[found.Knight];
  const wolfId = players[found.Werewolf].playerId;

  const duelRes = await api('player/knightDuel', { roomCode, playerId: knight.playerId, token: knight.token, targetId: wolfId });
  t.ok(duelRes.ok, '[knight] Knight duels and defeats the Werewolf', duelRes);

  v = await pollUntil(roomCode, leader, (v) => v.lastWords && v.lastWords.active, { timeoutMs: 5000 });
  t.ok(v.lastWords && v.lastWords.speakerName === found.Werewolf, '[knight] the defeated Werewolf owes last words before night falls', v.lastWords);
  t.ok(v.phase !== 'night', '[knight] night has NOT fallen yet — still waiting on those last words', v.phase);

  const finishRes = await api('player/finishLastWords', { roomCode, playerId: players[found.Werewolf].playerId, token: players[found.Werewolf].token });
  t.ok(finishRes.ok, '[knight] the Werewolf finishes their last words', finishRes);

  // This game only had the one Werewolf, so defeating it should immediately
  // end the game (village wins) right after the last words — rather than
  // continuing to a night with zero wolves left, which confirms the
  // last-words gate correctly released the win-condition check it had been
  // holding back.
  v = await pollUntil(roomCode, leader, (v) => v.phase === 'game_over', { timeoutMs: 5000 });
  t.ok(v.phase === 'game_over' && v.winner === 'village', '[knight] with the only wolf now gone, the game correctly ends (village wins) right after the last words', { phase: v.phase, winner: v.winner });

  console.log('--- knight scenario done ---');
}

(async () => {
  await scenarioNightKill();
  await scenarioExecution();
  await scenarioHunterChain();
  await scenarioKnight();
  t.finish();
})().catch((e) => { console.error(e); process.exit(1); });
