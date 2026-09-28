// Checks the vote-result "toast" event (view.voteResultEvent): a durable,
// phase-independent, one-time-per-id server signal fired whenever a Sheriff
// election or a day elimination vote resolves, in every one of their distinct
// outcome branches. This is a real regression guard, not just a nice-to-have:
// before this field existed, the day-vote elimination message was written
// into room.lastAnnouncement and then wiped by beginNight()'s reset in the
// very same tick (no reactive gate sits between resolveDayVote and the next
// night), so a client polling every ~900ms could never actually observe it.
// voteResultEvent is deliberately never reset that way — only ever replaced
// by the next vote's own event — so a poll landing after the phase has
// already moved on can still catch it via the incrementing `id`.
const { api, state, sleep, setupRoom, configureAndStart, pollUntil, findRoles, Tally } = require('./lib');

const t = new Tally();

// ---------------------------------------------------------------------------
// Scenario A: contested Sheriff election, then a normal day-vote elimination
// (with role-reveal note) that carries the game straight into night 2.
// ---------------------------------------------------------------------------
async function scenarioA() {
  const allNames = ['Leader', 'Bo', 'Cy', 'Dee', 'Eli', 'Fi'];
  const { roomCode, players } = await setupRoom('Leader', allNames.slice(1));
  const leader = players.Leader;
  await configureAndStart(roomCode, players, 'Leader', { Werewolf: 1, Villager: 5 });

  const found = await findRoles(roomCode, players, allNames, ['Werewolf']);
  t.ok(!!found.Werewolf, '[A setup] identified the Werewolf', found);
  const wolf = players[found.Werewolf];
  const others = allNames.filter((n) => n !== found.Werewolf);

  // Wolf picks a kill target so night 1 resolves and the campaign starts.
  const wolfView = await state(roomCode, wolf.playerId, wolf.token);
  const victimName = others.find((n) => n !== 'Leader');
  await api('player/wolfVote', { roomCode, playerId: wolf.playerId, token: wolf.token, targetId: wolfView.wolfPhase.candidates.find((c) => c.name === victimName).id });

  let v = await pollUntil(roomCode, leader, (v) => v.phase === 'campaign', { timeoutMs: 8000 });
  t.ok(v.phase === 'campaign', '[A] reached the campaign phase after night 1', v.phase);

  // Two candidates run (excluding the leader, so the leader can vote).
  const cand0 = others.find((n) => n !== victimName);
  const cand1 = others.filter((n) => n !== victimName && n !== cand0)[0];
  await api('player/runForSheriff', { roomCode, playerId: players[cand0].playerId, token: players[cand0].token, action: 'run' });
  await api('player/runForSheriff', { roomCode, playerId: players[cand1].playerId, token: players[cand1].token, action: 'run' });

  v = await pollUntil(roomCode, leader, (v) => v.campaign && v.campaign.subPhase === 'vote', { timeoutMs: 8000 });
  t.ok(v.campaign && v.campaign.subPhase === 'vote', '[A] reached the election vote sub-phase', v.campaign);

  // Every eligible (non-candidate) voter votes for cand0 — once the last one
  // is in, concludeCampaign fires immediately (no need to wait out the timer).
  const eligibleVoters = allNames.filter((n) => n !== cand0 && n !== cand1);
  for (const n of eligibleVoters) {
    await api('player/electionVote', { roomCode, playerId: players[n].playerId, token: players[n].token, targetId: players[cand0].playerId });
  }

  v = await pollUntil(roomCode, leader, (v) => v.voteResultEvent && v.voteResultEvent.kind === 'sheriff', { timeoutMs: 5000 });
  t.ok(!!v.voteResultEvent, '[A] a voteResultEvent appeared after the election concluded', v.voteResultEvent);
  const sheriffEvent = v.voteResultEvent;
  t.ok(sheriffEvent && sheriffEvent.kind === 'sheriff', '[A] event kind is "sheriff"', sheriffEvent);
  t.ok(sheriffEvent && typeof sheriffEvent.id === 'number' && sheriffEvent.id > 0, '[A] event carries a positive numeric id', sheriffEvent);
  t.ok(sheriffEvent && sheriffEvent.text.includes(cand0) && /elected Sheriff/.test(sheriffEvent.text), '[A] event text names the winner and says they were elected', sheriffEvent);
  // Every player gets it, not just the winner — it's phase-independent, not role-gated.
  const bystanderView = await state(roomCode, players[eligibleVoters[0]].playerId, players[eligibleVoters[0]].token);
  t.ok(bystanderView.voteResultEvent && bystanderView.voteResultEvent.id === sheriffEvent.id, '[A] a non-candidate, non-leader player sees the same event', bystanderView.voteResultEvent);

  // The "who voted for whom" reveal — candidates listed separately (they had
  // no vote to give), everyone else showing who they actually backed.
  t.ok(Array.isArray(sheriffEvent.breakdown), '[A] sheriff event carries a breakdown array', sheriffEvent.breakdown);
  const cand0Entry = sheriffEvent.breakdown.find((b) => b.voterName === cand0);
  const cand1Entry = sheriffEvent.breakdown.find((b) => b.voterName === cand1);
  t.ok(cand0Entry && cand0Entry.candidate === true, '[A] cand0 is marked as a candidate, not a voter, in the breakdown', cand0Entry);
  t.ok(cand1Entry && cand1Entry.candidate === true, '[A] cand1 is marked as a candidate too', cand1Entry);
  const sheriffVoterEntries = sheriffEvent.breakdown.filter((b) => !b.candidate);
  t.ok(sheriffVoterEntries.length === eligibleVoters.length && sheriffVoterEntries.every((b) => b.targetName === cand0),
    '[A] every eligible voter\'s breakdown entry shows they voted for cand0', sheriffVoterEntries);

  // Let discussion + the vote countdown play out (fast timers), then everyone
  // still alive and eligible votes to eliminate the same target so the
  // outcome is unambiguous.
  v = await pollUntil(roomCode, leader, (v) => v.phase === 'day_vote', { timeoutMs: 15000 });
  t.ok(v.phase === 'day_vote', '[A] reached day_vote', v.phase);

  const eliminateTarget = cand1; // anyone still alive and not the sheriff
  const dayVoteView = await state(roomCode, leader.playerId, leader.token);
  const targetId = players[eliminateTarget].playerId;
  for (const n of allNames) {
    if (n === eliminateTarget) continue;
    const pv = await state(roomCode, players[n].playerId, players[n].token);
    if (pv.dayVoteBlocked) continue; // e.g. a revealed Fool with no vote (not expected here, but safe)
    await api('player/dayVote', { roomCode, playerId: players[n].playerId, token: players[n].token, targetId });
  }

  // The vote resolves immediately (no Hunter/Sheriff-death reactive gate
  // here) — but the eliminated player now owes a "last words" turn before
  // the game can move on to night. The event itself still fires right away
  // regardless, which is the real regression this test guards against.
  v = await pollUntil(roomCode, leader, (v) => v.voteResultEvent && v.voteResultEvent.id !== sheriffEvent.id, { timeoutMs: 8000 });
  const dayVoteEvent = v.voteResultEvent;
  t.ok(!!dayVoteEvent && dayVoteEvent.id > sheriffEvent.id, '[A] a new, distinct voteResultEvent appeared for the day vote', { sheriffEvent, dayVoteEvent });
  t.ok(dayVoteEvent && dayVoteEvent.kind === 'day_vote', '[A] event kind is "day_vote"', dayVoteEvent);
  t.ok(dayVoteEvent && dayVoteEvent.text.includes(eliminateTarget) && /voted to eliminate/.test(dayVoteEvent.text), '[A] event text names who was eliminated', dayVoteEvent);
  t.ok(v.phase === 'day_vote', '[A] the game is paused, waiting on the eliminated player\'s last words, before night falls', v.phase);

  const lastWordsRes = await api('player/finishLastWords', { roomCode, playerId: players[eliminateTarget].playerId, token: players[eliminateTarget].token });
  t.ok(lastWordsRes.ok, '[A] the eliminated player finishes their last words', lastWordsRes);

  v = await pollUntil(roomCode, leader, (v) => v.phase === 'night', { timeoutMs: 5000 });
  t.ok(v.phase === 'night' && v.voteResultEvent && v.voteResultEvent.id === dayVoteEvent.id,
    '[A] only now, after last words, has the game moved on to night — the event survived the transition', { phase: v.phase, voteResultEvent: v.voteResultEvent });

  t.ok(Array.isArray(dayVoteEvent.breakdown), '[A] day-vote event carries a breakdown array', dayVoteEvent.breakdown);
  const eliminatedEntry = dayVoteEvent.breakdown.find((b) => b.voterName === eliminateTarget);
  t.ok(eliminatedEntry && eliminatedEntry.targetName === null, '[A] the eliminated player\'s own entry shows they never voted (never asked to)', eliminatedEntry);
  const otherVoterEntries = dayVoteEvent.breakdown.filter((b) => b.voterName !== eliminateTarget);
  t.ok(otherVoterEntries.length > 0 && otherVoterEntries.every((b) => b.targetName === eliminateTarget),
    '[A] every other voter\'s entry shows they voted to eliminate the target', otherVoterEntries);

  console.log('--- scenario A done ---');
}

// ---------------------------------------------------------------------------
// Scenario B: nobody runs for Sheriff, and nobody votes in the day vote —
// the two "nothing happened" branches, which still deserve their own event.
// ---------------------------------------------------------------------------
async function scenarioB() {
  const names = ['Nina', 'Omar', 'Priya', 'Quinn', 'Rosa'];
  const { roomCode, players } = await setupRoom(names[0], names.slice(1));
  const leader = players[names[0]];
  await configureAndStart(roomCode, players, names[0], { Werewolf: 1, Villager: 3, Seer: 1 });

  // Let night 1 time out entirely (no one acts) -> straight to the campaign.
  let v = await pollUntil(roomCode, leader, (v) => v.phase === 'campaign', { timeoutMs: 8000 });
  t.ok(v.phase === 'campaign', '[B] campaign reached after night 1 timed out', v.phase);

  // Nobody runs -> concludeCampaign's "0 candidates" branch.
  v = await pollUntil(roomCode, leader, (v) => v.voteResultEvent && v.voteResultEvent.kind === 'sheriff', { timeoutMs: 8000 });
  t.ok(!!v.voteResultEvent, '[B] a sheriff voteResultEvent appeared with no candidates', v.voteResultEvent);
  const noRunEvent = v.voteResultEvent;
  t.ok(/No one ran for Sheriff/.test(noRunEvent.text), '[B] event text says no one ran', noRunEvent);
  t.ok(v.sheriffId === null, '[B] there is indeed no sheriff', v.sheriffId);
  t.ok(noRunEvent.breakdown === null, '[B] no breakdown when there was no vote round to reveal (no one ran)', noRunEvent.breakdown);

  // Let the day vote time out with no one voting -> resolveDayVote's
  // "no votes cast" branch, which goes straight into night 2 in one tick.
  v = await pollUntil(roomCode, leader, (v) => v.voteResultEvent && v.voteResultEvent.id !== noRunEvent.id, { timeoutMs: 15000 });
  const noVotesEvent = v.voteResultEvent;
  t.ok(!!noVotesEvent && noVotesEvent.id > noRunEvent.id, '[B] a new voteResultEvent appeared for the day vote', { noRunEvent, noVotesEvent });
  t.ok(noVotesEvent && noVotesEvent.kind === 'day_vote', '[B] event kind is "day_vote"', noVotesEvent);
  t.ok(noVotesEvent && /No votes were cast/.test(noVotesEvent.text), '[B] event text says no votes were cast', noVotesEvent);
  t.ok(v.phase === 'night' && v.dayNumber === 2, '[B] moved on to night 2 by the time this is observed', { phase: v.phase, day: v.dayNumber });

  t.ok(Array.isArray(noVotesEvent.breakdown) && noVotesEvent.breakdown.length === names.length && noVotesEvent.breakdown.every((b) => b.targetName === null),
    '[B] breakdown shows every eligible player as having abstained', noVotesEvent.breakdown);

  console.log('--- scenario B done ---');
}

(async () => {
  await scenarioA();
  await scenarioB();
  t.finish();
})().catch((e) => { console.error(e); process.exit(1); });
