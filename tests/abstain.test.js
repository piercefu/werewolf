// Checks the "active abstain" buttons for both votes (day elimination vote
// and Sheriff election): a player can lock in "I'm not voting" as a real
// action instead of just letting the timer run out, and — the actual point
// of the feature — once every eligible voter has EITHER voted OR abstained,
// the vote concludes immediately, without anyone waiting out the full timer
// for one holdout. Also checks that an abstain never counts toward any
// candidate/target's tally, and that it's correctly reflected (as
// abstained: true, not just "no vote") in the post-vote reveal breakdown.
const { api, state, sleep, setupRoom, configureAndStart, pollUntil, findRoles, Tally } = require('./lib');

const t = new Tally();

// ---------------------------------------------------------------------------
// Scenario A: day elimination vote — one voter abstains, the rest vote for
// the same target. Uses a deliberately long dayVote timer so an early
// conclude (not a timeout) is the only way the assertions below can pass in
// time.
// ---------------------------------------------------------------------------
async function scenarioA() {
  const allNames = ['Leader', 'Bo', 'Cy', 'Dee', 'Eli'];
  const { roomCode, players } = await setupRoom('Leader', allNames.slice(1));
  const leader = players.Leader;
  await configureAndStart(roomCode, players, 'Leader', { Werewolf: 1, Villager: 4 }, { dayVote: 6 });

  const found = await findRoles(roomCode, players, allNames, ['Werewolf']);
  const wolf = players[found.Werewolf];

  // Skip straight through night 1 (no kill) and the campaign (no candidates)
  // to reach day_vote.
  let v = await pollUntil(roomCode, leader, (v) => v.phase === 'day_vote', { timeoutMs: 15000 });
  t.ok(v.phase === 'day_vote', '[A] reached day_vote', v.phase);

  const abstainer = allNames.find((n) => n !== found.Werewolf); // anyone other than the wolf
  const remaining = allNames.filter((n) => n !== abstainer);
  const target = remaining[0]; // the elimination target — can't vote for themselves, so they vote for someone else below
  const voters = remaining.filter((n) => n !== target); // everyone left votes for target
  const targetId = players[target].playerId;

  const abstainRes = await api('player/dayVoteAbstain', { roomCode, playerId: players[abstainer].playerId, token: players[abstainer].token });
  t.ok(abstainRes.ok, '[A] abstain action accepted', abstainRes);

  const abstainerView = await state(roomCode, players[abstainer].playerId, players[abstainer].token);
  t.ok(abstainerView.dayVote && abstainerView.dayVote.yourAbstain === true, '[A] abstainer\'s own view shows yourAbstain:true', abstainerView.dayVote);
  t.ok(abstainerView.dayVote.yourVote === null, '[A] abstainer\'s yourVote is null (not the internal sentinel)', abstainerView.dayVote);

  const started = Date.now();
  for (const n of voters) {
    await api('player/dayVote', { roomCode, playerId: players[n].playerId, token: players[n].token, targetId });
  }
  // The elimination target still has to act too (vote or abstain) for the
  // "everyone has acted" count to reach the total — they just can't vote for
  // themselves, so they vote for one of the others instead. Their single
  // vote doesn't come close to outweighing the target's votes above.
  await api('player/dayVote', { roomCode, playerId: players[target].playerId, token: players[target].token, targetId: players[voters[0]].playerId });

  v = await pollUntil(roomCode, leader, (v) => v.voteResultEvent && v.voteResultEvent.kind === 'day_vote', { timeoutMs: 4000 });
  const elapsedMs = Date.now() - started;
  t.ok(!!v.voteResultEvent, '[A] the vote resolved (voteResultEvent fired)', v.voteResultEvent);
  t.ok(elapsedMs < 4000, `[A] resolved well before the 6s timer — abstain counted toward "everyone acted" (${elapsedMs}ms)`, elapsedMs);
  t.ok(v.voteResultEvent.text.includes(target) && /voted to eliminate/.test(v.voteResultEvent.text), '[A] the real votes (not the abstain) determined who was eliminated', v.voteResultEvent);

  const abstainEntry = v.voteResultEvent.breakdown.find((b) => b.voterName === abstainer);
  t.ok(abstainEntry && abstainEntry.abstained === true && abstainEntry.targetName === null, '[A] breakdown marks the abstainer distinctly (abstained:true, no target)', abstainEntry);

  console.log('--- scenario A done ---');
}

// ---------------------------------------------------------------------------
// Scenario B: Sheriff election — same idea, one voter abstains among a
// contested election, the abstain doesn't affect the outcome, and the
// election concludes early instead of waiting out the electionVote timer.
// ---------------------------------------------------------------------------
async function scenarioB() {
  const allNames = ['Nina', 'Omar', 'Priya', 'Quinn', 'Rosa', 'Sam'];
  const { roomCode, players } = await setupRoom(allNames[0], allNames.slice(1));
  const leader = players[allNames[0]];
  await configureAndStart(roomCode, players, allNames[0], { Werewolf: 1, Villager: 5 }, { electionVote: 6 });

  const found = await findRoles(roomCode, players, allNames, ['Werewolf']);
  const wolf = players[found.Werewolf];
  const wolfView = await state(roomCode, wolf.playerId, wolf.token);
  const victim = allNames.find((n) => n !== found.Werewolf && n !== allNames[0]);
  await api('player/wolfVote', { roomCode, playerId: wolf.playerId, token: wolf.token, targetId: wolfView.wolfPhase.candidates.find((c) => c.name === victim).id });

  let v = await pollUntil(roomCode, leader, (v) => v.phase === 'campaign', { timeoutMs: 8000 });
  t.ok(v.phase === 'campaign', '[B] reached the campaign phase', v.phase);

  const others = allNames.filter((n) => n !== found.Werewolf && n !== victim);
  const cand0 = others[0];
  const cand1 = others[1];
  await api('player/runForSheriff', { roomCode, playerId: players[cand0].playerId, token: players[cand0].token, action: 'run' });
  await api('player/runForSheriff', { roomCode, playerId: players[cand1].playerId, token: players[cand1].token, action: 'run' });

  v = await pollUntil(roomCode, leader, (v) => v.campaign && v.campaign.subPhase === 'vote', { timeoutMs: 8000 });
  t.ok(v.campaign && v.campaign.subPhase === 'vote', '[B] reached the election vote sub-phase', v.campaign);

  const eligibleVoters = allNames.filter((n) => n !== cand0 && n !== cand1);
  const abstainer = eligibleVoters[0];
  const abstainRes = await api('player/electionVoteAbstain', { roomCode, playerId: players[abstainer].playerId, token: players[abstainer].token });
  t.ok(abstainRes.ok, '[B] election abstain accepted', abstainRes);

  const abstainerView = await state(roomCode, players[abstainer].playerId, players[abstainer].token);
  t.ok(abstainerView.campaign && abstainerView.campaign.yourAbstain === true, '[B] abstainer\'s campaign view shows yourAbstain:true', abstainerView.campaign);

  // A candidate cannot abstain in their own election either (same rule as
  // voting) — checked while the election is still open, before the rest of
  // the votes below make it conclude.
  const candAbstainAttempt = await api('player/electionVoteAbstain', { roomCode, playerId: players[cand0].playerId, token: players[cand0].token });
  t.ok(candAbstainAttempt.ok === false, '[B] a candidate cannot abstain in their own election', candAbstainAttempt);

  const started = Date.now();
  for (const n of eligibleVoters.slice(1)) {
    await api('player/electionVote', { roomCode, playerId: players[n].playerId, token: players[n].token, targetId: players[cand0].playerId });
  }

  v = await pollUntil(roomCode, leader, (v) => v.voteResultEvent && v.voteResultEvent.kind === 'sheriff', { timeoutMs: 4000 });
  const elapsedMs = Date.now() - started;
  t.ok(!!v.voteResultEvent, '[B] the election resolved (voteResultEvent fired)', v.voteResultEvent);
  t.ok(elapsedMs < 4000, `[B] resolved well before the 6s timer — abstain counted toward "everyone acted" (${elapsedMs}ms)`, elapsedMs);
  t.ok(v.voteResultEvent.text.includes(cand0) && /elected Sheriff/.test(v.voteResultEvent.text), '[B] the real votes (not the abstain) determined the winner', v.voteResultEvent);

  const abstainEntry = v.voteResultEvent.breakdown.find((b) => b.voterName === abstainer);
  t.ok(abstainEntry && abstainEntry.abstained === true && abstainEntry.targetName === null && !abstainEntry.candidate, '[B] breakdown marks the abstainer distinctly', abstainEntry);

  console.log('--- scenario B done ---');
}

(async () => {
  await scenarioA();
  await scenarioB();
  t.finish();
})().catch((e) => { console.error(e); process.exit(1); });
