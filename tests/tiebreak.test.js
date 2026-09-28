// Checks the tie-break "runoff" feature for both the day elimination vote
// and the Sheriff election: a tie is no longer broken by a coin flip. The
// tied players get one extra speech turn (reusing the normal discussion /
// campaign-speech machinery, restricted to just them), then everyone votes
// again choosing only among the tied players. A SECOND tie in that runoff
// means nothing happens — no one is eliminated / there is no Sheriff — not
// another round and not a random pick either.
const { api, state, setupRoom, configureAndStart, pollUntil, Tally } = require('./lib');

const t = new Tally();

async function rolesOf(roomCode, players, names) {
  const roles = {};
  for (const n of names) {
    const v = await state(roomCode, players[n].playerId, players[n].token);
    roles[n] = v.you.role;
  }
  return roles;
}

// Drains a day_discussion round (used for the runoff's "tied players speak
// once more" step) by having whoever the current speaker is finish their
// turn, until the discussion ends on its own (queue exhausted).
async function drainDiscussion(roomCode, players, leader, maxTurns) {
  for (let i = 0; i < maxTurns; i++) {
    const v = await state(roomCode, leader.playerId, leader.token);
    if (v.phase !== 'day_discussion' || !v.discussion) return v;
    const speakerId = v.discussion.currentSpeakerId;
    const speakerName = Object.keys(players).find((n) => players[n].playerId === speakerId);
    if (!speakerName) return v;
    await api('player/finishSpeech', { roomCode, playerId: players[speakerName].playerId, token: players[speakerName].token });
  }
  return state(roomCode, leader.playerId, leader.token);
}

// ---------------------------------------------------------------------------
// Common setup for the day-vote scenarios: 5 players, night 1 times out with
// no kill, nobody runs for Sheriff (keeps every vote weight at a plain 1x),
// straight into day_discussion with all 5, then through to day_vote.
// ---------------------------------------------------------------------------
async function setupDayVoteFive(tag, names) {
  const { roomCode, players } = await setupRoom(names[0], names.slice(1));
  const leader = players[names[0]];
  await configureAndStart(roomCode, players, names[0], { Werewolf: 1, Villager: 4 });

  let v = await pollUntil(roomCode, leader, (v) => v.phase === 'campaign', { timeoutMs: 8000 });
  t.ok(v.phase === 'campaign', `[${tag} setup] reached the campaign after night 1 (no kill)`, v.phase);

  // Nobody runs -> straight into discussion with no Sheriff (weight stays 1x
  // for everyone, keeping the tie arithmetic simple and unambiguous).
  v = await pollUntil(roomCode, leader, (v) => v.phase === 'day_discussion', { timeoutMs: 8000 });
  t.ok(v.phase === 'day_discussion' && v.sheriffId === null, `[${tag} setup] no candidates -> no Sheriff, straight into discussion`, { phase: v.phase, sheriffId: v.sheriffId });

  v = await drainDiscussion(roomCode, players, leader, names.length + 2);
  v = await pollUntil(roomCode, leader, (v) => v.phase === 'day_vote', { timeoutMs: 8000 });
  t.ok(v.phase === 'day_vote', `[${tag} setup] reached day_vote with all 5 still alive`, v.phase);

  const roles = await rolesOf(roomCode, players, names);
  return { roomCode, players, leader, roles };
}

// ---------------------------------------------------------------------------
// Scenario A: a tied execution vote (2 vs 2) triggers a runoff — the tied
// pair get one more speech turn, then the village votes again among just
// them, and this time it's a clean majority -> that player is eliminated.
// ---------------------------------------------------------------------------
async function scenarioA() {
  const names = ['Ann', 'Bo', 'Cy', 'Dee', 'Emi'];
  const { roomCode, players, leader, roles } = await setupDayVoteFive('A', names);

  // Pick the tied pair from among the VILLAGERS specifically — this test is
  // about the tie-break mechanic, not the win condition, so the runoff's
  // eventual "loser" must not happen to be the game's only Werewolf (which
  // would end the game right there and never reach night 2, making this
  // test flaky depending on the random role deal).
  const villagerNames = names.filter((n) => roles[n] === 'Villager');
  const [v1, v2] = villagerNames; // the tied pair
  const [r1, r2, r3] = names.filter((n) => n !== v1 && n !== v2); // everyone else (may include the Werewolf)

  // Round 1: v1 and v2 tie at 2 votes each.
  await api('player/dayVote', { roomCode, playerId: players[r1].playerId, token: players[r1].token, targetId: players[v1].playerId });
  await api('player/dayVote', { roomCode, playerId: players[r2].playerId, token: players[r2].token, targetId: players[v1].playerId });
  await api('player/dayVote', { roomCode, playerId: players[v1].playerId, token: players[v1].token, targetId: players[v2].playerId });
  await api('player/dayVote', { roomCode, playerId: players[r3].playerId, token: players[r3].token, targetId: players[v2].playerId });
  const round1Res = await api('player/dayVote', { roomCode, playerId: players[v2].playerId, token: players[v2].token, targetId: players[r1].playerId });
  t.ok(round1Res.ok, `[A] fifth vote cast, completing round 1 (${v1}=2, ${v2}=2 — a clean tie)`, round1Res);

  let v = await pollUntil(roomCode, leader, (v) => v.voteResultEvent && v.voteResultEvent.kind === 'day_vote', { timeoutMs: 5000 });
  t.ok(v.voteResultEvent && /[Tt]ied/.test(v.voteResultEvent.text), '[A] a "tied" voteResultEvent fired for round 1 (no random pick)', v.voteResultEvent);
  t.ok(v.phase === 'day_discussion' && v.discussion && v.discussion.isRunoff, '[A] the game moved straight into a runoff speech round', { phase: v.phase, discussion: v.discussion });

  const tiedNames = v.discussion.queue.map((id) => Object.keys(players).find((n) => players[n].playerId === id)).sort();
  t.ok(JSON.stringify(tiedNames) === JSON.stringify([v1, v2].sort()), `[A] exactly the two tied players (${v1} and ${v2}) are queued to speak again`, tiedNames);

  v = await drainDiscussion(roomCode, players, leader, 4);
  v = await pollUntil(roomCode, leader, (v) => v.phase === 'day_vote', { timeoutMs: 5000 });
  t.ok(v.phase === 'day_vote' && v.dayVote && v.dayVote.isRunoff, '[A] the runoff vote is now open', v.dayVote);
  t.ok(JSON.stringify((v.dayVote.tiedNames || []).slice().sort()) === JSON.stringify([v1, v2].sort()), '[A] the runoff vote names exactly the tied pair as the choices', v.dayVote.tiedNames);

  // Round 2: everyone piles onto v1 (v1 and v2 themselves can only choose
  // between the two tied candidates).
  await api('player/dayVote', { roomCode, playerId: players[r1].playerId, token: players[r1].token, targetId: players[v1].playerId });
  await api('player/dayVote', { roomCode, playerId: players[r2].playerId, token: players[r2].token, targetId: players[v1].playerId });
  await api('player/dayVote', { roomCode, playerId: players[r3].playerId, token: players[r3].token, targetId: players[v1].playerId });
  await api('player/dayVote', { roomCode, playerId: players[v2].playerId, token: players[v2].token, targetId: players[v1].playerId });
  const round2Res = await api('player/dayVote', { roomCode, playerId: players[v1].playerId, token: players[v1].token, targetId: players[v2].playerId });
  t.ok(round2Res.ok, `[A] ${v1} casts the fifth and final runoff vote (for ${v2}, the only legal choice)`, round2Res);

  v = await pollUntil(roomCode, leader, (v) => v.voteResultEvent && /runoff/i.test(v.voteResultEvent.text), { timeoutMs: 5000 });
  t.ok(v.voteResultEvent && /runoff/i.test(v.voteResultEvent.text) && v.voteResultEvent.text.includes(v1) && /eliminate/i.test(v.voteResultEvent.text),
    `[A] the runoff breaks the tie — ${v1} (4 votes) is eliminated, not a coin flip`, v.voteResultEvent);
  t.ok(v.lastWords && v.lastWords.speakerName === v1, '[A] the eliminated player now owes a last-words turn, exactly like any other day-vote elimination', v.lastWords);

  await api('player/finishLastWords', { roomCode, playerId: players[v1].playerId, token: players[v1].token });
  v = await pollUntil(roomCode, leader, (v) => v.phase === 'night' && v.dayNumber === 2, { timeoutMs: 5000 });
  t.ok(v.phase === 'night' && v.dayNumber === 2, '[A] the game proceeds into night 2 after the runoff-decided elimination', { phase: v.phase, day: v.dayNumber });
  const aliveNames = v.players.filter((p) => p.alive).map((p) => p.name).sort();
  t.ok(JSON.stringify(aliveNames) === JSON.stringify(names.filter((n) => n !== v1).sort()), `[A] ${v1} (and only ${v1}) is dead — ${v2}, who was equally tied, survives`, aliveNames);

  console.log('--- scenario A done ---');
}

// ---------------------------------------------------------------------------
// Scenario B: the runoff ALSO ties (2 vs 2 again) -> no one is eliminated
// today at all, and the game proceeds straight to the next night.
// ---------------------------------------------------------------------------
async function scenarioB() {
  const names = ['Fay', 'Gus', 'Hana', 'Ivo', 'Jax'];
  const [fay, gus, hana, ivo, jax] = names;
  const { roomCode, players, leader } = await setupDayVoteFive('B', names);

  // Round 1: Hana and Jax tie at 2 votes each.
  await api('player/dayVote', { roomCode, playerId: players[gus].playerId, token: players[gus].token, targetId: players[hana].playerId });
  await api('player/dayVote', { roomCode, playerId: players[ivo].playerId, token: players[ivo].token, targetId: players[hana].playerId });
  await api('player/dayVote', { roomCode, playerId: players[hana].playerId, token: players[hana].token, targetId: players[jax].playerId });
  await api('player/dayVote', { roomCode, playerId: players[jax].playerId, token: players[jax].token, targetId: players[ivo].playerId });
  await api('player/dayVote', { roomCode, playerId: players[fay].playerId, token: players[fay].token, targetId: players[jax].playerId });

  let v = await pollUntil(roomCode, leader, (v) => v.phase === 'day_discussion' && v.discussion && v.discussion.isRunoff, { timeoutMs: 5000 });
  t.ok(v.phase === 'day_discussion' && v.discussion.isRunoff, '[B] round 1 tied (Hana=2, Jax=2) -> runoff speeches begin', v.discussion);

  v = await drainDiscussion(roomCode, players, leader, 4);
  v = await pollUntil(roomCode, leader, (v) => v.phase === 'day_vote' && v.dayVote && v.dayVote.isRunoff, { timeoutMs: 5000 });
  t.ok(v.phase === 'day_vote' && v.dayVote.isRunoff, '[B] the runoff vote opened', v.dayVote);

  // Round 2 ties again: Hana and Jax are each forced to vote for the other
  // (their only legal choice besides themselves); Fay and Gus split evenly
  // (one each way) and Ivo abstains, keeping it 2-2.
  await api('player/dayVote', { roomCode, playerId: players[hana].playerId, token: players[hana].token, targetId: players[jax].playerId });
  await api('player/dayVote', { roomCode, playerId: players[jax].playerId, token: players[jax].token, targetId: players[hana].playerId });
  await api('player/dayVote', { roomCode, playerId: players[fay].playerId, token: players[fay].token, targetId: players[hana].playerId });
  await api('player/dayVote', { roomCode, playerId: players[gus].playerId, token: players[gus].token, targetId: players[jax].playerId });
  const abstainRes = await api('player/dayVoteAbstain', { roomCode, playerId: players[ivo].playerId, token: players[ivo].token });
  t.ok(abstainRes.ok, '[B] Ivo abstains, completing round 2 with Hana=2 and Jax=2 again', abstainRes);

  v = await pollUntil(roomCode, leader, (v) => v.voteResultEvent && /runoff/i.test(v.voteResultEvent.text), { timeoutMs: 5000 });
  t.ok(v.voteResultEvent && /tied again/i.test(v.voteResultEvent.text) && /no one is eliminated/i.test(v.voteResultEvent.text),
    '[B critical] the runoff tied again -> explicitly "no one is eliminated", not another round and not a random pick', v.voteResultEvent);
  t.ok(!v.lastWords, '[B] there is no last-words prompt at all — nobody actually died', v.lastWords);

  v = await pollUntil(roomCode, leader, (v) => v.phase === 'night' && v.dayNumber === 2, { timeoutMs: 5000 });
  t.ok(v.phase === 'night' && v.dayNumber === 2, '[B] the game moved straight on to night 2', { phase: v.phase, day: v.dayNumber });
  t.ok(v.players.filter((p) => p.alive).length === 5, '[B critical] all 5 players are still alive — a double tie kills no one', v.players.filter((p) => p.alive).length);

  console.log('--- scenario B done ---');
}

// ---------------------------------------------------------------------------
// Common setup for the Sheriff-election scenarios: 6 players, two candidates
// (B and C) run, and the other 4 are the eligible voters.
// ---------------------------------------------------------------------------
async function setupSheriffSix(tag, names) {
  const { roomCode, players } = await setupRoom(names[0], names.slice(1));
  const leader = players[names[0]];
  await configureAndStart(roomCode, players, names[0], { Werewolf: 1, Villager: 5 });

  let v = await pollUntil(roomCode, leader, (v) => v.phase === 'campaign', { timeoutMs: 8000 });
  t.ok(v.phase === 'campaign', `[${tag} setup] reached the campaign after night 1`, v.phase);

  const [cand0, cand1] = [names[1], names[2]]; // B, C
  await api('player/runForSheriff', { roomCode, playerId: players[cand0].playerId, token: players[cand0].token, action: 'run' });
  await api('player/runForSheriff', { roomCode, playerId: players[cand1].playerId, token: players[cand1].token, action: 'run' });

  v = await pollUntil(roomCode, leader, (v) => v.campaign && v.campaign.subPhase === 'speeches', { timeoutMs: 5000 });
  t.ok(v.campaign && v.campaign.subPhase === 'speeches', `[${tag} setup] both candidates registered, speeches begin`, v.campaign);

  // Drain the two candidate speeches to reach the vote.
  for (let i = 0; i < 2; i++) {
    v = await state(roomCode, leader.playerId, leader.token);
    const speakerId = v.campaign.currentSpeakerId;
    const speakerName = Object.keys(players).find((n) => players[n].playerId === speakerId);
    await api('player/campaignSpeechDone', { roomCode, playerId: players[speakerName].playerId, token: players[speakerName].token });
  }
  v = await pollUntil(roomCode, leader, (v) => v.campaign && v.campaign.subPhase === 'vote', { timeoutMs: 5000 });
  t.ok(v.campaign && v.campaign.subPhase === 'vote', `[${tag} setup] reached the election vote`, v.campaign);

  return { roomCode, players, leader, cand0, cand1, voters: [names[0], names[3], names[4], names[5]] };
}

// ---------------------------------------------------------------------------
// Scenario C: a tied Sheriff election (2 vs 2) triggers a runoff — same two
// candidates speak once more, then the same voters decide again, and this
// time it's a clean majority.
// ---------------------------------------------------------------------------
async function scenarioC() {
  const names = ['Kim', 'Leo', 'Moe', 'Nia', 'Oz', 'Pia'];
  const { roomCode, players, leader, cand0, cand1, voters } = await setupSheriffSix('C', names);
  const [v0, v1, v2, v3] = voters; // Kim, Nia, Oz, Pia

  // Round 1: Leo and Moe tie at 2 votes each.
  await api('player/electionVote', { roomCode, playerId: players[v0].playerId, token: players[v0].token, targetId: players[cand0].playerId });
  await api('player/electionVote', { roomCode, playerId: players[v1].playerId, token: players[v1].token, targetId: players[cand1].playerId });
  await api('player/electionVote', { roomCode, playerId: players[v2].playerId, token: players[v2].token, targetId: players[cand0].playerId });
  const round1Res = await api('player/electionVote', { roomCode, playerId: players[v3].playerId, token: players[v3].token, targetId: players[cand1].playerId });
  t.ok(round1Res.ok, '[C] fourth vote cast, completing round 1 (a clean 2-2 tie)', round1Res);

  let v = await pollUntil(roomCode, leader, (v) => v.voteResultEvent && v.voteResultEvent.kind === 'sheriff', { timeoutMs: 5000 });
  t.ok(v.voteResultEvent && /[Tt]ied/.test(v.voteResultEvent.text), '[C] a "tied" sheriff voteResultEvent fired for round 1 (no random pick)', v.voteResultEvent);
  t.ok(v.campaign && v.campaign.subPhase === 'speeches' && v.campaign.isRunoff, '[C] the same two candidates go straight into a runoff speech round', v.campaign);
  t.ok(JSON.stringify(v.campaign.candidateNames.slice().sort()) === JSON.stringify([cand0, cand1].sort()), '[C] the runoff candidates are exactly the tied pair', v.campaign.candidateNames);

  for (let i = 0; i < 2; i++) {
    v = await state(roomCode, leader.playerId, leader.token);
    const speakerId = v.campaign.currentSpeakerId;
    const speakerName = Object.keys(players).find((n) => players[n].playerId === speakerId);
    await api('player/campaignSpeechDone', { roomCode, playerId: players[speakerName].playerId, token: players[speakerName].token });
  }
  v = await pollUntil(roomCode, leader, (v) => v.campaign && v.campaign.subPhase === 'vote', { timeoutMs: 5000 });
  t.ok(v.campaign && v.campaign.subPhase === 'vote' && v.campaign.isRunoff, '[C] the runoff vote is open', v.campaign);

  // Round 2: a clean 3-1 majority for cand0 (Leo).
  await api('player/electionVote', { roomCode, playerId: players[v0].playerId, token: players[v0].token, targetId: players[cand0].playerId });
  await api('player/electionVote', { roomCode, playerId: players[v1].playerId, token: players[v1].token, targetId: players[cand0].playerId });
  await api('player/electionVote', { roomCode, playerId: players[v2].playerId, token: players[v2].token, targetId: players[cand1].playerId });
  const round2Res = await api('player/electionVote', { roomCode, playerId: players[v3].playerId, token: players[v3].token, targetId: players[cand0].playerId });
  t.ok(round2Res.ok, '[C] fourth runoff vote cast (Leo=3, Moe=1)', round2Res);

  v = await pollUntil(roomCode, leader, (v) => v.voteResultEvent && /runoff/i.test(v.voteResultEvent.text), { timeoutMs: 5000 });
  t.ok(v.voteResultEvent && /runoff/i.test(v.voteResultEvent.text) && v.voteResultEvent.text.includes(cand0) && /elected Sheriff/i.test(v.voteResultEvent.text),
    '[C] the runoff breaks the tie — Leo is elected Sheriff, not a coin flip', v.voteResultEvent);
  t.ok(v.sheriffId === players[cand0].playerId, '[C] sheriffId is actually set to Leo', { sheriffId: v.sheriffId, expected: players[cand0].playerId });

  console.log('--- scenario C done ---');
}

// ---------------------------------------------------------------------------
// Scenario D: the Sheriff runoff ALSO ties -> there is no Sheriff this game
// at all (no further rounds, no random pick).
// ---------------------------------------------------------------------------
async function scenarioD() {
  const names = ['Quin', 'Rex', 'Sia', 'Tam', 'Uri', 'Vil'];
  const { roomCode, players, leader, cand0, cand1, voters } = await setupSheriffSix('D', names);
  const [v0, v1, v2, v3] = voters;

  // Round 1: cand0 and cand1 tie at 2 votes each.
  await api('player/electionVote', { roomCode, playerId: players[v0].playerId, token: players[v0].token, targetId: players[cand0].playerId });
  await api('player/electionVote', { roomCode, playerId: players[v1].playerId, token: players[v1].token, targetId: players[cand1].playerId });
  await api('player/electionVote', { roomCode, playerId: players[v2].playerId, token: players[v2].token, targetId: players[cand0].playerId });
  await api('player/electionVote', { roomCode, playerId: players[v3].playerId, token: players[v3].token, targetId: players[cand1].playerId });

  let v = await pollUntil(roomCode, leader, (v) => v.campaign && v.campaign.subPhase === 'speeches' && v.campaign.isRunoff, { timeoutMs: 5000 });
  t.ok(v.campaign && v.campaign.isRunoff, '[D] round 1 tied -> runoff speeches begin', v.campaign);

  for (let i = 0; i < 2; i++) {
    v = await state(roomCode, leader.playerId, leader.token);
    const speakerId = v.campaign.currentSpeakerId;
    const speakerName = Object.keys(players).find((n) => players[n].playerId === speakerId);
    await api('player/campaignSpeechDone', { roomCode, playerId: players[speakerName].playerId, token: players[speakerName].token });
  }
  v = await pollUntil(roomCode, leader, (v) => v.campaign && v.campaign.subPhase === 'vote', { timeoutMs: 5000 });

  // Round 2: the exact same 2-2 split again.
  await api('player/electionVote', { roomCode, playerId: players[v0].playerId, token: players[v0].token, targetId: players[cand0].playerId });
  await api('player/electionVote', { roomCode, playerId: players[v1].playerId, token: players[v1].token, targetId: players[cand1].playerId });
  await api('player/electionVote', { roomCode, playerId: players[v2].playerId, token: players[v2].token, targetId: players[cand0].playerId });
  const round2Res = await api('player/electionVote', { roomCode, playerId: players[v3].playerId, token: players[v3].token, targetId: players[cand1].playerId });
  t.ok(round2Res.ok, '[D] fourth runoff vote cast, tying again', round2Res);

  v = await pollUntil(roomCode, leader, (v) => v.voteResultEvent && /runoff/i.test(v.voteResultEvent.text), { timeoutMs: 5000 });
  t.ok(v.voteResultEvent && /tied again/i.test(v.voteResultEvent.text) && /no Sheriff/i.test(v.voteResultEvent.text),
    '[D critical] the runoff tied again -> explicitly no Sheriff this game, not another round and not a random pick', v.voteResultEvent);
  t.ok(v.sheriffId === null, '[D critical] sheriffId stays null', v.sheriffId);

  // Sanity: the game still moves on normally afterward (doesn't get stuck).
  v = await pollUntil(roomCode, leader, (v) => v.phase === 'day_announce' || v.phase === 'day_discussion', { timeoutMs: 5000 });
  t.ok(v.phase === 'day_announce' || v.phase === 'day_discussion', '[D] the game proceeds normally into the day after the runoff concludes', v.phase);

  console.log('--- scenario D done ---');
}

(async () => {
  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();
  t.finish();
})().catch((e) => { console.error(e); process.exit(1); });
