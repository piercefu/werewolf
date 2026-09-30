// Checks the public "dramatic moment" events (view.publicEvents) that drive
// the center-screen popup every player sees — a Hunter firing, a Knight's
// duel, the Werewolf King's reveal, a badge handoff, and the dawn
// announcement — plus two bugs found while auditing the UX:
//  - after a day vote is counted but paused on a reactive gate (last words,
//    Hunter's shot), players used to still see live vote buttons;
//  - during a mid-discussion duel/reveal gate, the current speaker's clock
//    kept running underneath and could skip them.
const { api, state, sleep, setupRoom, configureAndStart, pollUntil, Tally } = require('./lib');

const t = new Tally();

async function rolesOf(roomCode, players, names) {
  const roles = {};
  for (const n of names) roles[n] = (await state(roomCode, players[n].playerId, players[n].token)).you.role;
  return roles;
}
const nameById = (players, id) => Object.keys(players).find((n) => players[n].playerId === id);
const auth = (roomCode, p) => ({ roomCode, playerId: p.playerId, token: p.token });

// ---------------------------------------------------------------------------
// Scenario 1: dawn event + an executed Hunter firing -> 'hunter' event that
// every player receives; the vote is shown as closed during the gate.
// ---------------------------------------------------------------------------
async function scenarioHunter() {
  const names = ['Ada', 'Ben', 'Cal', 'Dot', 'Eve', 'Fox'];
  const { roomCode, players } = await setupRoom(names[0], names.slice(1));
  const leader = players[names[0]];
  await configureAndStart(roomCode, players, names[0], { Werewolf: 1, Hunter: 1, Villager: 4 });
  const roles = await rolesOf(roomCode, players, names);
  const hunter = names.find((n) => roles[n] === 'Hunter');
  const victim = names.find((n) => roles[n] === 'Villager');
  const bystander = names.find((n) => n !== hunter && n !== victim);

  let v = await pollUntil(roomCode, leader, (v) => v.phase === 'day_vote', { timeoutMs: 20000 });
  t.ok(v.phase === 'day_vote', '[hunter] reached day_vote', v.phase);
  const dawn = (v.publicEvents || []).find((e) => e.kind === 'dawn');
  t.ok(dawn && /Day 1/.test(dawn.title) && /No one died/.test(dawn.text), '[dawn] a dawn event announced the (empty) night to everyone', v.publicEvents);

  for (const n of names) {
    if (n === hunter) await api('player/dayVoteAbstain', auth(roomCode, players[n]));
    else await api('player/dayVote', { ...auth(roomCode, players[n]), targetId: players[hunter].playerId });
  }
  const bv = await state(roomCode, players[bystander].playerId, players[bystander].token);
  t.ok(bv.phase === 'day_vote' && bv.dayVoteClosed === true && !bv.dayVote,
    '[closed] while paused on the Hunter/last-words gate, the vote shows as closed — no live vote buttons', { phase: bv.phase, closed: bv.dayVoteClosed, dayVote: bv.dayVote });

  const shot = await api('player/hunterShoot', { ...auth(roomCode, players[hunter]), targetId: players[victim].playerId });
  t.ok(shot.ok, '[hunter] the executed Hunter fires', shot);
  const sv = await state(roomCode, players[bystander].playerId, players[bystander].token);
  const evt = (sv.publicEvents || []).find((e) => e.kind === 'hunter');
  t.ok(evt && evt.text.includes(hunter) && evt.text.includes(victim) && evt.icon === '🏹',
    '[hunter] a bystander receives a public "The Hunter fires!" event naming both the Hunter and their target', sv.publicEvents);
  t.ok(evt && evt.id > dawn.id, '[hunter] event ids keep increasing (so each shows exactly once)', { dawn: dawn && dawn.id, hunter: evt && evt.id });
  t.ok(sv.revealRoleOnDeath === false, '[default] "reveal role on death" is OFF by default', sv.revealRoleOnDeath);
  t.ok(evt && !/They were|Villager/.test(evt.text), '[default] the Hunter popup does NOT reveal the shot player\'s role', evt && evt.text);
  const victimRow = sv.players.find((p) => p.name === victim);
  const hunterRow = sv.players.find((p) => p.name === hunter);
  t.ok(victimRow && victimRow.role === undefined, '[default] the shot player\'s role stays hidden on the roster', victimRow);
  t.ok(hunterRow && hunterRow.role === 'Hunter', '[default] the Hunter themselves IS revealed (they used their ability)', hunterRow);

  const voteEvt = (sv.publicEvents || []).find((e) => e.kind === 'vote');
  t.ok(voteEvt && voteEvt.id < evt.id && /voted to eliminate/.test(voteEvt.text) && voteEvt.text.includes(hunter),
    '[vote popup] the elimination got its own popup, ordered BEFORE the Hunter\'s shot', voteEvt);
  t.ok(voteEvt && !/They were|Hunter\./.test(voteEvt.text), '[vote popup] with reveal-on-death off, the elimination popup does not name the role', voteEvt && voteEvt.text);
  const line = voteEvt && (voteEvt.details || []).find((l) => l.startsWith(hunter));
  t.ok(line && /— 5 votes:/.test(line) && names.filter((n) => n !== hunter).every((n) => line.includes(n)),
    '[vote popup] the popup lists the distribution: who voted for the eliminated player', voteEvt && voteEvt.details);
  t.ok(voteEvt && (voteEvt.details || []).some((l) => l === `Abstained: ${hunter}`), '[vote popup] abstainers are listed too', voteEvt && voteEvt.details);

  await api('player/finishLastWords', auth(roomCode, players[hunter]));
  await api('player/finishLastWords', auth(roomCode, players[victim]));
  const nv = await pollUntil(roomCode, leader, (v) => v.phase === 'night' || v.phase === 'game_over', { timeoutMs: 5000 });
  const nightEvt = (nv.publicEvents || []).find((e) => e.kind === 'night' && /Night 2/.test(e.title));
  t.ok(nv.phase !== 'night' || (nightEvt && nightEvt.id > evt.id), '[night popup] a "Night 2 falls" popup follows once the day wraps up', nv.publicEvents);
  console.log('--- hunter scenario done ---');
}

// ---------------------------------------------------------------------------
// Scenario 2: Knight duels an innocent -> 'knight' event; discussion is
// paused (speaker clock frozen) while the Knight gives last words.
// ---------------------------------------------------------------------------
async function scenarioKnightInnocent() {
  const names = ['Gil', 'Hal', 'Ivy', 'Jo', 'Kai'];
  const { roomCode, players } = await setupRoom(names[0], names.slice(1));
  const leader = players[names[0]];
  // Longer speech turns so we can let the current speaker's own deadline
  // pass while the gate (Knight's last words, same length) is still open.
  await configureAndStart(roomCode, players, names[0], { Werewolf: 1, Knight: 1, Villager: 3 }, { speech: 6 });
  const roles = await rolesOf(roomCode, players, names);
  const knight = names.find((n) => roles[n] === 'Knight');

  let v = await pollUntil(roomCode, leader, (v) => v.phase === 'day_discussion' && v.discussion && v.discussion.secondsLeft <= 3, { timeoutMs: 25000 });
  t.ok(v.phase === 'day_discussion', '[knight] reached discussion, partway through the first speaker\'s turn', v.discussion);
  const speakerBefore = v.discussion.currentSpeakerId;
  const target = names.find((n) => roles[n] === 'Villager' && players[n].playerId !== speakerBefore);

  const duel = await api('player/knightDuel', { ...auth(roomCode, players[knight]), targetId: players[target].playerId });
  t.ok(duel.ok, '[knight] Knight duels an innocent villager', duel);
  v = await state(roomCode, leader.playerId, leader.token);
  const evt = (v.publicEvents || []).find((e) => e.kind === 'knight');
  t.ok(evt && evt.text.includes(knight) && evt.text.includes(target) && /innocent/.test(evt.text) && !/Villager/.test(evt.text),
    '[knight] public duel event names both players and says "innocent" — without leaking the target\'s exact role', evt);
  t.ok(v.discussion && v.discussion.paused === true, '[pause] discussion reports paused while the Knight gives last words', v.discussion);

  await sleep(4000); // the speaker's own deadline has now passed; the last-words gate (6s) hasn't
  v = await state(roomCode, leader.playerId, leader.token);
  t.ok(v.phase === 'day_discussion' && v.discussion.currentSpeakerId === speakerBefore && v.lastWords && v.lastWords.speakerName === knight,
    '[pause critical] the current speaker was NOT skipped while the table listened to the Knight\'s last words',
    { phase: v.phase, before: nameById(players, speakerBefore), now: v.discussion && nameById(players, v.discussion.currentSpeakerId), lastWords: v.lastWords });
  const finishWhilePaused = await api('player/finishSpeech', auth(roomCode, players[nameById(players, speakerBefore)]));
  t.ok(!finishWhilePaused.ok, '[pause] "I\'m done speaking" is refused while paused', finishWhilePaused);

  await api('player/finishLastWords', auth(roomCode, players[knight]));
  v = await state(roomCode, leader.playerId, leader.token);
  t.ok(v.phase === 'day_discussion' && v.discussion && v.discussion.paused === false && v.discussion.secondsLeft >= 5,
    '[pause] once last words are done, discussion resumes with a fresh full turn', v.discussion);
  console.log('--- knight scenario done ---');
}

// ---------------------------------------------------------------------------
// Scenario 3: Werewolf King reveal -> 'wolfking' event.
// ---------------------------------------------------------------------------
async function scenarioWolfKing() {
  const names = ['Lu', 'Mo', 'Ned', 'Oli', 'Pip', 'Quo'];
  const { roomCode, players } = await setupRoom(names[0], names.slice(1));
  const leader = players[names[0]];
  await configureAndStart(roomCode, players, names[0], { WerewolfKing: 1, Werewolf: 1, Villager: 4 });
  const roles = await rolesOf(roomCode, players, names);
  const king = names.find((n) => roles[n] === 'WerewolfKing');
  const target = names.find((n) => roles[n] === 'Villager');

  await pollUntil(roomCode, leader, (v) => v.phase === 'day_discussion', { timeoutMs: 20000 });
  const res = await api('player/wolfKingReveal', { ...auth(roomCode, players[king]), targetId: players[target].playerId });
  t.ok(res.ok, '[king] Werewolf King reveals', res);
  const v = await state(roomCode, leader.playerId, leader.token);
  const evt = (v.publicEvents || []).find((e) => e.kind === 'wolfking');
  t.ok(evt && evt.text.includes(king) && evt.text.includes(target) && evt.icon === '🐺👑', '[king] public "Werewolf King strikes" event', evt);
  t.ok(evt && !/was the|Villager/.test(evt.text), '[king] the popup does NOT reveal the King\'s target\'s role', evt && evt.text);
  const targetRow = v.players.find((p) => p.name === target);
  const kingRow = v.players.find((p) => p.name === king);
  t.ok(targetRow && targetRow.role === undefined, '[king] the King\'s target\'s role stays hidden on the roster', targetRow);
  t.ok(kingRow && kingRow.role === 'WerewolfKing', '[king] the King himself IS revealed', kingRow);
  console.log('--- wolf king scenario done ---');
}

// ---------------------------------------------------------------------------
// Scenario 4: the Sheriff is executed and passes the badge -> 'badge' event.
// ---------------------------------------------------------------------------
async function scenarioBadge() {
  const names = ['Ray', 'Sol', 'Tex', 'Uma', 'Val'];
  const { roomCode, players } = await setupRoom(names[0], names.slice(1));
  const leader = players[names[0]];
  await configureAndStart(roomCode, players, names[0], { Werewolf: 1, Villager: 4 });
  const roles = await rolesOf(roomCode, players, names);
  const sheriff = names.find((n) => roles[n] === 'Villager' && n !== names[0]);
  const heir = names.find((n) => n !== sheriff && roles[n] === 'Villager');

  await pollUntil(roomCode, leader, (v) => v.phase === 'campaign', { timeoutMs: 10000 });
  await api('player/runForSheriff', { ...auth(roomCode, players[sheriff]), action: 'run' });
  let v = await pollUntil(roomCode, leader, (v) => v.phase === 'day_vote', { timeoutMs: 25000 });
  t.ok(v.sheriffId === players[sheriff].playerId, '[badge] a Sheriff was elected unopposed', v.sheriffId);
  for (const n of names) {
    if (n === sheriff) await api('player/dayVoteAbstain', auth(roomCode, players[n]));
    else await api('player/dayVote', { ...auth(roomCode, players[n]), targetId: players[sheriff].playerId });
  }
  const h = await api('player/sheriffHandoff', { ...auth(roomCode, players[sheriff]), targetId: players[heir].playerId });
  t.ok(h.ok, '[badge] the executed Sheriff passes the badge', h);
  v = await state(roomCode, leader.playerId, leader.token);
  const evt = (v.publicEvents || []).find((e) => e.kind === 'badge');
  t.ok(evt && evt.text.includes(sheriff) && evt.text.includes(heir), '[badge] public badge-handoff event names both players', evt);
  console.log('--- badge scenario done ---');
}

// ---------------------------------------------------------------------------
// Scenario 5: voting out the only wolf -> a "Village wins" game-over popup,
// fired exactly once.
// ---------------------------------------------------------------------------
async function scenarioGameOver() {
  const names = ['Wu', 'Xi', 'Yo', 'Zed'];
  const { roomCode, players } = await setupRoom(names[0], names.slice(1));
  const leader = players[names[0]];
  await configureAndStart(roomCode, players, names[0], { Werewolf: 1, Villager: 3 });
  const roles = await rolesOf(roomCode, players, names);
  const wolf = names.find((n) => roles[n] === 'Werewolf');
  await pollUntil(roomCode, leader, (v) => v.phase === 'day_vote', { timeoutMs: 20000 });
  for (const n of names) {
    if (n === wolf) await api('player/dayVoteAbstain', auth(roomCode, players[n]));
    else await api('player/dayVote', { ...auth(roomCode, players[n]), targetId: players[wolf].playerId });
  }
  await api('player/finishLastWords', auth(roomCode, players[wolf]));
  const v = await pollUntil(roomCode, leader, (v) => v.phase === 'game_over', { timeoutMs: 5000 });
  const over = (v.publicEvents || []).filter((e) => e.kind === 'gameover');
  t.ok(v.phase === 'game_over' && over.length === 1 && /Village wins/.test(over[0].title), '[game over] exactly one "The Village wins!" popup', v.publicEvents);
  t.ok(!(v.publicEvents || []).some((e) => e.kind === 'night' && /Night 2/.test(e.title)), '[game over] no stray "Night 2 falls" popup after the game ended', v.publicEvents);
  console.log('--- game over scenario done ---');
}

(async () => {
  await scenarioGameOver();
  await scenarioHunter();
  await scenarioKnightInnocent();
  await scenarioWolfKing();
  await scenarioBadge();
  t.finish();
})().catch((e) => { console.error(e); process.exit(1); });
