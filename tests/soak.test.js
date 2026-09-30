// "Does a whole game still play through?" — plays complete games end to end
// with every role in the pool, every player making random (but legal)
// choices from whatever their own screen offers them: night actions, running
// for Sheriff, speeches, votes/abstains, Hunter shots, badge handoffs, Knight
// duels, Werewolf King reveals, last words — or sometimes just letting the
// timer run out. It fails if:
//   - a game ever stalls (nothing changes for too long), or never finishes;
//   - anyone's screen shows a role it shouldn't (with "reveal role on death"
//     off, a Villager/Seer/Witch/Guard role must never be shown to another
//     player before the game ends, and a wolf only once they're dead);
//   - anyone who isn't a wolf sees the 🐺 teammate marker;
//   - the server rejects an action the player's own screen offered them
//     (a sign the UI and server disagree about what's allowed).
// Randomized on purpose, so each run explores different paths. SOAK_GAMES
// (default 5, one per role setup) controls how many games are played.
const { api, state, sleep, setupRoom, configureAndStart, Tally } = require('./lib');

const t = new Tally();
const GAMES = Number(process.env.SOAK_GAMES || 5);
const STALL_MS = 15000;
const GAME_MS = 240000;
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const chance = (p) => Math.random() < p;
const WOLF_ROLES = ['Werewolf', 'WerewolfKing', 'HiddenWolf'];
const NEVER_SHOWN = ['Villager', 'Seer', 'Witch', 'Guard'];

const CONFIGS = [
  { Werewolf: 2, WerewolfKing: 1, Seer: 1, Witch: 1, Hunter: 1, Guard: 1, Knight: 1, Fool: 1, Villager: 1 },
  { Werewolf: 1, WerewolfKing: 1, HiddenWolf: 1, Seer: 1, Witch: 1, Hunter: 1, Knight: 1, Villager: 2 },
  { Werewolf: 2, Seer: 1, Hunter: 1, Guard: 1, Fool: 1, Villager: 2 },
  { Werewolf: 1, HiddenWolf: 1, Witch: 1, Knight: 1, Hunter: 1, Villager: 2 },
  { Werewolf: 2, Hunter: 3, Witch: 1, Villager: 2 }, // "multiple Hunters" fun variant
];

async function playGame(g) {
  const cfg = CONFIGS[g % CONFIGS.length];
  const count = Object.values(cfg).reduce((a, b) => a + b, 0);
  const names = Array.from({ length: count }, (_, i) => `G${g}P${i}`);
  const { roomCode, players } = await setupRoom(names[0], names.slice(1));
  if (g % 2 === 1) await api('player/setWinCondition', { roomCode, playerId: players[names[0]].playerId, token: players[names[0]].token, mode: 'extinction' });
  const started = await configureAndStart(roomCode, players, names[0], cfg);
  if (!started.ok) { t.ok(false, `[game ${g}] started`, started); return; }

  const roleOf = {};
  const problems = [];
  let lastKey = ''; let lastChange = Date.now(); const t0 = Date.now();
  let final = null; let actions = 0; let days = 0;

  const act = async (n, action, extra) => {
    const p = players[n];
    const res = await api(action, { roomCode, playerId: p.playerId, token: p.token, ...(extra || {}) });
    actions++;
    // "Not your turn"-style races are expected when several players act on
    // views fetched a moment apart; anything else means UI and server disagree.
    if (!res.ok && !/not your turn|not open|already|resolve|cannot|paused|not the wolves|nominations|not your call|campaign must finish|Invalid target|It is not your turn|No discussion|Not found/i.test(res.error || '')) {
      problems.push(`${action} by ${n} (${roleOf[n]}): ${res.error}`);
    }
  };

  while (true) {
    for (const n of names) {
      const v = await state(roomCode, players[n].playerId, players[n].token);
      if (!v) continue;
      roleOf[n] = v.you.role;
      const over = v.phase === 'game_over';
      if (over) { final = v; break; }
      days = v.dayNumber;

      // --- invariants on what this player can see ---
      for (const p of v.players) {
        if (p.id === players[n].playerId) continue;
        const real = roleOf[p.name];
        if (p.role && NEVER_SHOWN.includes(p.role)) problems.push(`${n} can see ${p.name} is ${p.role}`);
        if (p.role && WOLF_ROLES.includes(p.role) && p.alive && p.role !== 'WerewolfKing') problems.push(`${n} can see living wolf ${p.name}`);
        if (p.isWolfTeammate && !WOLF_ROLES.includes(v.you.role)) problems.push(`${n} (${v.you.role}) sees a wolf-teammate marker on ${p.name}`);
        if (p.role && real && p.role !== real) problems.push(`${n} sees wrong role for ${p.name}`);
      }

      // --- take a random legal action from this player's own screen ---
      if (!v.you.viewedRole) { await act(n, 'player/viewedRole'); continue; }
      if (v.guardPhase && !v.guardPhase.acted && chance(0.7)) {
        const c = v.guardPhase.candidates.filter((x) => !x.disabled);
        if (c.length && chance(0.8)) await act(n, 'player/guardProtect', { action: 'protect', targetId: pick(c).id });
        else await act(n, 'player/guardProtect', { action: 'skip' });
      }
      if (v.wolfPhase && chance(0.7)) {
        const packPick = v.wolfPhase.packStatus.find((w) => w.targetId && !w.isYou);
        const target = packPick && chance(0.8) ? packPick.targetId : pick(v.wolfPhase.candidates).id;
        if (target !== v.wolfPhase.yourVote) await act(n, 'player/wolfVote', { targetId: target });
      }
      if (v.seerPhase && !v.seerPhase.acted && chance(0.7)) await act(n, 'player/seerView', { targetId: pick(v.seerPhase.candidates).id });
      if (v.witchPhase && !v.witchPhase.acted && chance(0.7)) {
        const r = Math.random();
        if (v.witchPhase.canHeal && r < 0.3) await act(n, 'player/witchAction', { action: 'heal' });
        else if (v.witchPhase.canPoison && r < 0.45) await act(n, 'player/witchAction', { action: 'poison', targetId: pick(v.witchPhase.candidates).id });
        else await act(n, 'player/witchAction', { action: 'skip' });
      }
      if (v.campaign) {
        const c = v.campaign;
        if (c.subPhase === 'nominate' && c.canToggle && !c.youAreCandidate && chance(0.15)) await act(n, 'player/runForSheriff', { action: 'run' });
        if (c.subPhase === 'speeches' && c.isYourTurn && chance(0.6)) await act(n, 'player/campaignSpeechDone');
        if (c.subPhase === 'vote' && c.canVote && !c.yourVote && !c.yourAbstain && chance(0.7)) {
          if (chance(0.15)) await act(n, 'player/electionVoteAbstain');
          else await act(n, 'player/electionVote', { targetId: pick(c.candidates).id });
        }
      }
      if (v.hunterShot && chance(0.6)) await act(n, 'player/hunterShoot', { targetId: pick(v.hunterShot.candidates).id });
      if (v.sheriffHandoff && chance(0.6)) {
        if (chance(0.25)) await act(n, 'player/sheriffHandoff', { action: 'discard' });
        else await act(n, 'player/sheriffHandoff', { targetId: pick(v.sheriffHandoff.candidates).id });
      }
      if (v.sheriffDirection && chance(0.6)) {
        const sides = [v.sheriffDirection.leftId && 'left', v.sheriffDirection.rightId && 'right'].filter(Boolean);
        if (sides.length) await act(n, 'player/sheriffDirection', { side: pick(sides) });
      }
      if (v.lastWords && v.lastWords.isYourTurn && chance(0.6)) await act(n, 'player/finishLastWords');
      if (v.discussion && v.discussion.isYourTurn && !v.discussion.paused && chance(0.6)) await act(n, 'player/finishSpeech');
      if (v.knightDuel && chance(0.04)) await act(n, 'player/knightDuel', { targetId: pick(v.knightDuel.candidates).id });
      if (v.wolfKingReveal && chance(0.03)) await act(n, 'player/wolfKingReveal', { targetId: pick(v.wolfKingReveal.candidates).id });
      if (v.dayVote && !v.dayVote.yourVote && !v.dayVote.yourAbstain && chance(0.7)) {
        if (chance(0.1)) await act(n, 'player/dayVoteAbstain');
        else if (v.dayVote.candidates.length) await act(n, 'player/dayVote', { targetId: pick(v.dayVote.candidates).id });
      }
    }
    if (final) break;

    const lv = await state(roomCode, players[names[0]].playerId, players[names[0]].token);
    const key = JSON.stringify([lv.phase, lv.dayNumber, lv.nightSubPhase, lv.discussion && lv.discussion.pointer, lv.campaign && lv.campaign.subPhase,
      lv.campaign && lv.campaign.pointer, lv.lastWords && lv.lastWords.speakerId, lv.players.map((p) => p.alive), lv.sheriffId, (lv.publicEvents || []).length && lv.publicEvents[lv.publicEvents.length - 1].id,
      lv.dayVote && lv.dayVote.votedCount]);
    if (key !== lastKey) { lastKey = key; lastChange = Date.now(); }
    if (Date.now() - lastChange > STALL_MS) { problems.push(`STALLED for ${STALL_MS / 1000}s at ${key}`); break; }
    if (Date.now() - t0 > GAME_MS) { problems.push(`game did not finish within ${GAME_MS / 1000}s (day ${lv.dayNumber})`); break; }
    await sleep(120);
  }

  const secs = Math.round((Date.now() - t0) / 1000);
  t.ok(!!final && (final.winner === 'village' || final.winner === 'wolves'),
    `[game ${g}] ${count} players (${Object.keys(cfg).join('/')}, ${g % 2 ? 'extinction' : 'majority'}) played to the end — ${final ? final.winner + ' win' : 'NO WINNER'} on day ${days}, ${actions} actions, ${secs}s`);
  const uniq = [...new Set(problems)];
  t.ok(uniq.length === 0, `[game ${g}] no stalls, role leaks, or rejected on-screen actions`, uniq.slice(0, 8));
  if (final) {
    const wolvesAlive = final.reveal.filter((p) => WOLF_ROLES.includes(p.role) && p.alive).length;
    t.ok(final.winner !== 'village' || wolvesAlive === 0, `[game ${g}] a village win really means no wolves are left alive`, final.reveal);
  }
}

(async () => {
  for (let g = 0; g < GAMES; g++) await playGame(g);
  t.finish();
})().catch((e) => { console.error(e); process.exit(1); });
