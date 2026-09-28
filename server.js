// Werewolf Moderator — server.js
//
// Zero-dependency Node server (only core `http`/`crypto`/`fs`/`path` modules —
// nothing to `npm install`, nothing that can fail to install on a host).
// Realtime-ish updates are done with short client-side polling rather than
// WebSockets: every phone GETs /api/state a few times a second. For a
// turn-based party game that lag (well under a second) is imperceptible and
// it's dramatically simpler and more portable than a WebSocket server.
//
// Rooms live only in memory: if the process restarts, active games are lost
// (fine for a casual game-night app — just start a new room).
//
// There is no separate "host" role. Whoever creates the room joins as a
// normal player (the "lobby leader") with a few extra pre-game/admin
// permissions layered on top of an otherwise completely ordinary player
// view. No client ever sees another player's role, or any night-action
// detail, before it's supposed to be known. Every point where the game used
// to wait on a human moderator to click "continue" is instead driven by a
// tunable timer with a defined default outcome, checked lazily (`tickRoom`)
// whenever any client touches the room — since clients poll ~every 900ms,
// timers fire within about a second of expiring.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------------------
// Role definitions
// ---------------------------------------------------------------------------
// team: 'wolf' | 'village' — used by the Seer's reveal and the "majority" win
//       condition (kept as a simple binary, same as before).
// category: 'wolf' | 'god' | 'villager' — a finer split used only by the
//       "extinction" win condition (wolves win by wiping either every "god"
//       special role or every plain Villager).
const ROLE_DEFS = {
  Werewolf: {
    team: 'wolf',
    category: 'wolf',
    label: 'Werewolf',
    icon: '🐺',
    blurb: 'Each night you and the other wolves choose one player to kill. Whoever gets the most wolf votes dies (ties are broken at random). During the day, blend in with the villagers.',
  },
  WerewolfKing: {
    team: 'wolf',
    category: 'wolf',
    label: 'Werewolf King',
    icon: '🐺👑',
    blurb: 'You vote with the other wolves each night, same as a normal Werewolf. In addition, once per game — at any point during the day discussion, even interrupting whoever is currently speaking — you may reveal your identity and choose another player. You both die immediately.',
    maxCount: 1,
  },
  HiddenWolf: {
    team: 'wolf',
    category: 'wolf',
    label: 'Hidden Wolf',
    icon: '🐺🫥',
    blurb: 'You are a Werewolf, but you do not wake up with the wolf pack and have no idea who your teammates are. You have no kill ability of your own until every other wolf has died — once you are the last wolf standing, you wake alone each night and choose the kill by yourself. The Seer\'s magic can\'t see through your disguise: checked on you, they learn you are Village-aligned. A Knight\'s duel is not fooled and correctly reveals you as a wolf. Because your fellow wolves don\'t know about you either, they could vote to kill you by mistake.',
    maxCount: 1,
  },
  Villager: {
    team: 'village',
    category: 'villager',
    label: 'Villager',
    icon: '🧑‍🌾',
    blurb: 'You have no special power. Use the day discussion to find the wolves and vote them out.',
  },
  Seer: {
    team: 'village',
    category: 'god',
    label: 'Seer',
    icon: '🔮',
    blurb: 'Each night you may look at one player and learn whether they are on the Werewolf team or the Village team.',
    maxCount: 1,
  },
  Witch: {
    team: 'village',
    category: 'god',
    label: 'Witch',
    icon: '🧪',
    blurb: 'You have one healing potion and one poison potion, each usable once per game, and only one potion per night. If you still have your healing potion, you will be shown who the wolves attacked and may save them. You may also poison any living player.',
    maxCount: 1,
  },
  Hunter: {
    team: 'village',
    category: 'god',
    label: 'Hunter',
    icon: '🏹',
    blurb: 'If you die for any reason other than the witch’s poison, you immediately fire back and take one other player down with you.',
    maxCount: 1,
  },
  Fool: {
    team: 'village',
    category: 'god',
    label: 'Fool',
    icon: '🃏',
    blurb: 'You act like a normal villager and have no night power. The first time the village votes to eliminate you, you survive — your identity is revealed to everyone, but you lose your right to vote for the rest of the game.',
    maxCount: 1,
  },
  Guard: {
    team: 'village',
    category: 'god',
    label: 'Guard',
    icon: '🛡️',
    blurb: 'Each night you may protect one player from the wolves\' kill. If the wolves target whoever you protected, nothing happens to them. You cannot protect the same player two nights in a row.',
    maxCount: 1,
  },
  Knight: {
    team: 'village',
    category: 'god',
    label: 'Knight',
    icon: '⚔️',
    blurb: 'Once per game — at any point during the day discussion, even interrupting whoever is currently speaking — you may reveal your identity and challenge another player to a duel. Their identity is revealed: if they are a Werewolf, they die and night falls immediately; if they are innocent, you die of shame instead and the day continues.',
    maxCount: 1,
  },
};
const ROLE_NAMES = Object.keys(ROLE_DEFS);

const WIN_CONDITION_DESCRIPTIONS = {
  majority: 'Village wins when every wolf is eliminated. Wolves win as soon as they equal or outnumber the rest of the village.',
  extinction: '("Extinction" / 屠边 rules) Village wins when every wolf is eliminated. Wolves win the instant either every "god" special role (Seer, Witch, Hunter, Fool, Guard, Knight) OR every plain Villager has been eliminated — whichever side gets wiped out first.',
};

const DEFAULT_TIMERS = {
  candidacy: 30,     // sheriff campaign: nomination window (seconds)
  electionVote: 20,  // sheriff campaign: election vote window
  nightAction: 45,   // each night sub-phase, plus hunter shot / sheriff handoff / sheriff direction-choice
  dayVote: 20,       // day elimination vote window
  speech: 90,        // max length of a single discussion speech turn
};
const TIMER_KEYS = Object.keys(DEFAULT_TIMERS);
const TIMER_LIMITS = { min: 5, max: 600 };
const VOTE_COUNTDOWN_SECONDS = 10; // fixed, short "get ready" pause before voting opens

function isWolfRole(role) {
  return !!ROLE_DEFS[role] && ROLE_DEFS[role].team === 'wolf';
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
/** @type {Map<string, Room>} */
const rooms = new Map();

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
function genRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}
function genToken() { return crypto.randomUUID(); }
function genId() { return crypto.randomUUID(); }
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function defaultRoleConfig() {
  const cfg = {};
  for (const r of ROLE_NAMES) cfg[r] = 0;
  cfg.Werewolf = 1;
  cfg.Villager = 1;
  return cfg;
}

function newRoom(code) {
  return {
    code,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    // lobby | night | campaign | day_announce | day_discussion | day_vote_countdown | day_vote | game_over
    phase: 'lobby',
    players: new Map(), // playerId -> player
    lobbyLeaderId: null,
    seatOrder: [], // playerId[], assigned once at game start, fixed for the game
    roleConfig: defaultRoleConfig(),
    revealRoleOnDeath: true,
    winConditionMode: 'majority', // 'majority' | 'extinction'
    timers: { ...DEFAULT_TIMERS },
    dayNumber: 0,
    sheriffId: null,
    winner: null,
    log: [], // [{t, text, secret}] — secret entries hidden from players until game_over

    // --- night state ---
    nightSubPhase: null, // guard | wolves | seer | witch | resolve
    nightDeadline: null,
    wolfVotes: new Map(), // wolfPlayerId -> targetId
    pendingNightVictim: null,
    wolfVictimResolved: false,
    guardProtectedId: null,
    guardLastProtectedId: null,
    guardActedThisNight: false,
    seerActedThisNight: false,
    // The Seer's own result, persisted server-side (not just returned once in
    // the API response to their click) so it survives a page reload/refresh —
    // otherwise a player whose phone reloads the page mid-night permanently
    // loses the ability to see what they learned that night.
    seerResult: null,
    witch: { healUsed: false, poisonUsed: false },
    witchActedThisNight: false,
    healedTargetId: null,
    poisonTargetId: null,
    lastNightDeaths: [], // [{id, cause}]
    hunterNightStatus: new Map(),

    // --- day-1 campaign state (only while phase === 'campaign') ---
    campaign: null,

    // --- reactive gates (can be pending during night, campaign wrap-up, or discussion) ---
    pendingHunterShots: [], // [{hunterId, deadline}]
    pendingSheriffHandoff: null, // {sheriffId, deadline} | null
    pendingSheriffDirection: null, // {deadline, kind:'death'|'last', leftId, rightId, deceasedId?} | null
    afterReactive: null, // what to do once all of the above are clear: 'to_discussion' | 'to_night' | 'resume_discussion' | 'to_next_night_after_vote'

    // --- day discussion state ---
    lastAnnouncement: [],
    discussion: null, // {queue:[playerId], pointer, deadline}
    voteCountdownDeadline: null,

    // --- day vote ---
    dayVotes: new Map(),
    voteDeadline: null,
  };
}

function newPlayer(name) {
  return {
    id: genId(),
    token: genToken(),
    name,
    role: null,
    alive: true,
    publicAlive: true, // what other players (and the player itself) are allowed to know; lags `alive` until announced
    connected: true,
    lastSeen: Date.now(),
    viewedRole: false,
    joinedAt: Date.now(),
    canVote: true,
    foolRevealed: false,
    knightUsed: false,
    wolfKingUsed: false,
    publiclyRevealed: false,
  };
}

function touch(room) { room.lastActivity = Date.now(); }

function alivePlayers(room) { return [...room.players.values()].filter((p) => p.alive); }
function publicAlivePlayers(room) { return [...room.players.values()].filter((p) => p.publicAlive); }
function aliveByRole(room, role) { return alivePlayers(room).filter((p) => p.role === role); }
function aliveWolfTeam(room) { return alivePlayers(room).filter((p) => isWolfRole(p.role)); }
// The wolves who can actually act tonight. A Hidden Wolf stays dormant
// (no vote, no view of the wolves' night phase at all) for as long as any
// other wolf-team member is still alive; once every other wolf has died,
// the Hidden Wolf becomes the sole active wolf and wakes alone each night.
function activeWolfTeam(room) {
  const wolves = aliveWolfTeam(room);
  const regular = wolves.filter((p) => p.role !== 'HiddenWolf');
  return regular.length > 0 ? regular : wolves;
}
function votingEligible(room) { return alivePlayers(room).filter((p) => p.canVote !== false); }
function getPlayer(room, playerId) { return room.players.get(playerId); }

function log(room, text, opts = {}) {
  room.log.push({ t: Date.now(), text, secret: !!opts.secret });
  if (room.log.length > 400) room.log.shift();
}
function publicLog(room, n) {
  const gameOver = room.phase === 'game_over';
  return room.log
    .filter((e) => gameOver || !e.secret)
    .slice(-n)
    .map((e) => ({ t: e.t, text: e.text }));
}
function refreshConnectedFlags(room) {
  const now = Date.now();
  for (const p of room.players.values()) p.connected = now - p.lastSeen < 6000;
}
function clampTimer(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return null;
  return Math.max(TIMER_LIMITS.min, Math.min(TIMER_LIMITS.max, v));
}

// ---------------------------------------------------------------------------
// Seating / speech-order helpers
// ---------------------------------------------------------------------------
// "right" = clockwise (seat index + 1), "left" = counterclockwise (index - 1).
function neighborInDirection(room, playerId, direction, predicate) {
  const order = room.seatOrder;
  const n = order.length;
  const startIdx = order.indexOf(playerId);
  if (startIdx === -1) return null;
  for (let step = 1; step <= n; step++) {
    const idx = direction === 'right' ? (startIdx + step) % n : (((startIdx - step) % n) + n) % n;
    const pid = order[idx];
    if (pid === playerId) return null; // wrapped all the way around
    if (!predicate || predicate(getPlayer(room, pid))) return pid;
  }
  return null;
}
// Builds a full rotation starting at `startId`, walking `direction`, collecting
// every player that passes `predicate` (default: alive), for up to one full
// loop. `startId` itself is included first if it passes the predicate.
function buildRotation(room, startId, direction, predicate) {
  const order = room.seatOrder;
  const n = order.length;
  const startIdx = order.indexOf(startId);
  if (startIdx === -1) return [];
  const pred = predicate || ((p) => p && p.alive);
  const result = [];
  for (let step = 0; step < n; step++) {
    const idx = direction === 'right' ? (startIdx + step) % n : (((startIdx - step) % n) + n) % n;
    const pid = order[idx];
    const p = getPlayer(room, pid);
    if (pred(p)) result.push(pid);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Game flow — setup
// ---------------------------------------------------------------------------
function startGame(room) {
  const playerIds = shuffle([...room.players.keys()]);
  const pool = [];
  for (const role of ROLE_NAMES) {
    const n = room.roleConfig[role] || 0;
    for (let i = 0; i < n; i++) pool.push(role);
  }
  const shuffledPool = shuffle(pool);
  playerIds.forEach((pid, i) => {
    getPlayer(room, pid).role = shuffledPool[i] || 'Villager';
  });

  room.seatOrder = shuffle([...room.players.keys()]);
  room.phase = 'night';
  room.dayNumber = 1;
  room.sheriffId = null;
  room.winner = null;
  room.log = [];
  room.guardLastProtectedId = null;
  log(room, 'The game begins. Night falls on the village.');
  beginNight(room);
}

function resetGame(room) {
  for (const p of room.players.values()) {
    p.role = null;
    p.alive = true;
    p.publicAlive = true;
    p.viewedRole = false;
    p.canVote = true;
    p.foolRevealed = false;
    p.knightUsed = false;
    p.wolfKingUsed = false;
    p.publiclyRevealed = false;
  }
  room.phase = 'lobby';
  room.seatOrder = [];
  room.dayNumber = 0;
  room.sheriffId = null;
  room.winner = null;
  room.log = [];
  room.nightSubPhase = null;
  room.nightDeadline = null;
  room.wolfVotes = new Map();
  room.pendingNightVictim = null;
  room.wolfVictimResolved = false;
  room.guardProtectedId = null;
  room.guardLastProtectedId = null;
  room.guardActedThisNight = false;
  room.witch = { healUsed: false, poisonUsed: false };
  room.healedTargetId = null;
  room.poisonTargetId = null;
  room.lastNightDeaths = [];
  room.hunterNightStatus = new Map();
  room.campaign = null;
  room.pendingHunterShots = [];
  room.pendingSheriffHandoff = null;
  room.pendingSheriffDirection = null;
  room.afterReactive = null;
  room.lastAnnouncement = [];
  room.discussion = null;
  room.voteCountdownDeadline = null;
  room.dayVotes = new Map();
  room.voteDeadline = null;
}

// ---------------------------------------------------------------------------
// Game flow — night
// ---------------------------------------------------------------------------
function beginNight(room) {
  room.phase = 'night';
  room.wolfVotes = new Map();
  room.pendingNightVictim = null;
  room.wolfVictimResolved = false;
  room.guardProtectedId = null;
  room.guardActedThisNight = false;
  room.seerActedThisNight = false;
  room.seerResult = null;
  room.witchActedThisNight = false;
  room.healedTargetId = null;
  room.poisonTargetId = null;
  room.lastNightDeaths = [];
  room.hunterNightStatus = new Map();
  advanceNightSubPhase(room, true);
}

const NIGHT_ORDER = ['guard', 'wolves', 'seer', 'witch', 'resolve'];
const NIGHT_WOLVES_IDX = NIGHT_ORDER.indexOf('wolves');

function advanceNightSubPhase(room, isStart = false) {
  let idx = isStart ? -1 : NIGHT_ORDER.indexOf(room.nightSubPhase);
  idx += 1;
  while (idx < NIGHT_ORDER.length - 1) {
    const step = NIGHT_ORDER[idx];
    if (step === 'guard' && aliveByRole(room, 'Guard').length === 0) { idx++; continue; }
    if (step === 'wolves' && aliveWolfTeam(room).length === 0) { idx++; continue; }
    if (step === 'seer' && aliveByRole(room, 'Seer').length === 0) { idx++; continue; }
    if (step === 'witch' && aliveByRole(room, 'Witch').length === 0) { idx++; continue; }
    break;
  }
  room.nightSubPhase = NIGHT_ORDER[idx];
  if (idx > NIGHT_WOLVES_IDX && !room.wolfVictimResolved) {
    room.pendingNightVictim = tallyWolfVotes(room);
    if (room.pendingNightVictim && room.pendingNightVictim === room.guardProtectedId) {
      log(room, 'The Guard\'s protection worked — the wolves\' target survived the night.', { secret: true });
      room.pendingNightVictim = null;
    }
    room.wolfVictimResolved = true;
  }
  if (room.nightSubPhase === 'resolve') {
    resolveNight(room);
  } else {
    room.nightDeadline = Date.now() + room.timers.nightAction * 1000;
  }
}

function tallyWolfVotes(room) {
  const counts = new Map();
  for (const targetId of room.wolfVotes.values()) counts.set(targetId, (counts.get(targetId) || 0) + 1);
  if (counts.size === 0) return null;
  let max = -1;
  for (const c of counts.values()) max = Math.max(max, c);
  const top = [...counts.entries()].filter(([, c]) => c === max).map(([id]) => id);
  return pickRandom(top);
}

function resolveNight(room) {
  const deathCauses = new Map();
  if (room.pendingNightVictim && room.pendingNightVictim !== room.healedTargetId) {
    deathCauses.set(room.pendingNightVictim, 'wolves');
  }
  if (room.poisonTargetId) deathCauses.set(room.poisonTargetId, 'witch_poison');
  const deaths = [...deathCauses.entries()].map(([id, cause]) => ({ id, cause }));

  for (const hunter of aliveByRole(room, 'Hunter')) {
    room.hunterNightStatus.set(hunter.id, room.poisonTargetId !== hunter.id);
  }

  applyDeaths(room, deaths); // does NOT reveal publicly — deaths stay hidden until announced
  room.lastNightDeaths = deaths;
  room.dayVotes = new Map();

  if (room.dayNumber === 1) {
    // The Day-1 campaign is a "before anything is known" ritual — nothing
    // from night 1 should be revealed or acted on before it, including a
    // Hunter's own death and revenge shot. So unlike every later day, don't
    // wait on the reactive gate (pendingHunterShots) here: start the
    // campaign immediately. Any pending hunter shot stays queued and is
    // deferred until concludeCampaign() explicitly lets it through.
    startCampaign(room);
    return;
  }
  room.afterReactive = 'to_discussion';
  trySettleReactive(room);
}

function applyDeaths(room, deaths, { announceImmediately = false } = {}) {
  for (const d of deaths) {
    const p = getPlayer(room, d.id);
    if (!p || !p.alive) continue;
    p.alive = false;
    if (announceImmediately) p.publicAlive = false;
    if (d.cause !== 'witch_poison' && p.role === 'Hunter') {
      room.pendingHunterShots.push({ hunterId: p.id, deadline: Date.now() + room.timers.nightAction * 1000 });
    }
    if (room.sheriffId === p.id) {
      room.pendingSheriffHandoff = { sheriffId: p.id, deadline: Date.now() + room.timers.nightAction * 1000 };
    }
  }
}

// ---------------------------------------------------------------------------
// Reactive gate: resolves once pendingHunterShots / pendingSheriffHandoff are
// both empty, then does whatever `room.afterReactive` says.
// ---------------------------------------------------------------------------
function reactiveClear(room) {
  return room.pendingHunterShots.length === 0 && !room.pendingSheriffHandoff;
}

// Safety net: if the game ends the instant a night resolves (before the
// campaign or the day announcement ever runs), the "X died" lines would
// otherwise never make it into the log/retro. Cause is still never stated.
function logNightDeathsPlain(room) {
  for (const d of room.lastNightDeaths) {
    const n = getPlayer(room, d.id)?.name;
    if (n) log(room, `${n} died during the night.`);
  }
}

function trySettleReactive(room) {
  if (!reactiveClear(room)) return;
  const action = room.afterReactive;
  room.afterReactive = null;
  if (!action) return;

  if (action === 'to_discussion') {
    if (checkWinCondition(room)) { logNightDeathsPlain(room); return; }
    revealNightAndEnterAnnounce(room);
    return;
  }
  if (action === 'to_next_night_after_vote' || action === 'to_night_knight') {
    if (checkWinCondition(room)) return;
    startNextNight(room);
    return;
  }
  if (action === 'to_discussion_from_announce') {
    if (checkWinCondition(room)) return;
    finalizeAnnounceIntoDiscussion(room);
    return;
  }
  if (action === 'resume_discussion') {
    if (checkWinCondition(room)) return;
    pruneDiscussionQueue(room);
  }
}

// ---------------------------------------------------------------------------
// Day-1 campaign (sheriff election) — runs BEFORE the night's events are
// revealed. Every eligibility check here uses publicAlive (apparent-alive),
// not the true `alive` flag, so a secretly-killed player can fully run,
// speak, and vote without anyone — including themselves — knowing yet.
// ---------------------------------------------------------------------------
function startCampaign(room) {
  room.phase = 'campaign';
  room.campaign = {
    subPhase: 'nominate',
    candidateIds: [],
    deadline: Date.now() + room.timers.candidacy * 1000,
    speechQueue: [],
    speechPointer: 0,
    speechDeadline: null,
    votes: new Map(),
    voteDeadline: null,
  };
  log(room, 'Before anything else, the village holds a Sheriff campaign.');
}

function campaignCloseNominations(room) {
  const c = room.campaign;
  if (c.candidateIds.length >= 2) {
    c.subPhase = 'speeches';
    const startId = pickRandom(c.candidateIds);
    const direction = Math.random() < 0.5 ? 'left' : 'right';
    c.speechQueue = buildRotation(room, startId, direction, (p) => p && c.candidateIds.includes(p.id));
    c.speechPointer = 0;
    c.speechDeadline = Date.now() + room.timers.speech * 1000;
    log(room, `${c.candidateIds.length} players are running for Sheriff. Campaign speeches begin.`);
  } else {
    concludeCampaign(room); // 0 or 1 candidate: nothing more to do
  }
}

function campaignAdvanceSpeech(room) {
  const c = room.campaign;
  c.speechPointer += 1;
  if (c.speechPointer >= c.speechQueue.length) {
    c.subPhase = 'vote';
    c.votes = new Map();
    c.voteDeadline = Date.now() + room.timers.electionVote * 1000;
    log(room, 'Campaign speeches are done. The village votes for Sheriff.');
  } else {
    c.speechDeadline = Date.now() + room.timers.speech * 1000;
  }
}

function concludeCampaign(room) {
  const c = room.campaign;
  if (c.candidateIds.length === 1) {
    room.sheriffId = c.candidateIds[0];
    log(room, `${getPlayer(room, room.sheriffId)?.name} ran unopposed and is the new Sheriff.`);
  } else if (c.candidateIds.length >= 2) {
    const counts = new Map();
    for (const targetId of c.votes.values()) counts.set(targetId, (counts.get(targetId) || 0) + 1);
    if (counts.size > 0) {
      let max = -1;
      for (const v of counts.values()) max = Math.max(max, v);
      const top = [...counts.entries()].filter(([, v]) => v === max).map(([id]) => id);
      room.sheriffId = pickRandom(top);
      log(room, `${getPlayer(room, room.sheriffId)?.name} is elected Sheriff.`);
    } else {
      log(room, 'No votes were cast. There is no Sheriff this game.');
    }
  } else {
    log(room, 'No one ran for Sheriff. There is no Sheriff this game.');
  }
  room.campaign = null;
  // A Hunter who died on night 1 has been sitting on a queued revenge shot
  // this whole time, deliberately held back from resolving until now (see
  // resolveNight). Its original deadline was set assuming it would resolve
  // right away, so refresh it here to give the Hunter a fair window instead
  // of it having already silently expired during the campaign.
  if (room.pendingHunterShots.length > 0) {
    room.pendingHunterShots[0].deadline = Date.now() + room.timers.nightAction * 1000;
  }
  room.afterReactive = 'to_discussion';
  trySettleReactive(room);
}

// ---------------------------------------------------------------------------
// Revealing the night + entering discussion
// ---------------------------------------------------------------------------
function revealNightAndEnterAnnounce(room) {
  room.phase = 'day_announce';
  for (const d of room.lastNightDeaths) {
    const p = getPlayer(room, d.id);
    if (p) p.publicAlive = false;
  }
  // Cause is deliberately never mentioned — only who died, never how.
  if (room.lastNightDeaths.length === 0) {
    room.lastAnnouncement = ['No one died during the night.'];
    log(room, 'No one died during the night.');
  } else {
    const names = room.lastNightDeaths.map((d) => getPlayer(room, d.id)?.name).filter(Boolean);
    room.lastAnnouncement = names.map((n) => `${n} died during the night.`);
    for (const n of names) log(room, `${n} died during the night.`);
  }

  // If the sitting sheriff was secretly killed last night (elected during
  // the campaign without anyone knowing yet), queue their handoff now —
  // the one case applyDeaths can't catch, since the death was applied
  // before they were even elected.
  const sheriff = room.sheriffId ? getPlayer(room, room.sheriffId) : null;
  if (sheriff && !sheriff.alive && !room.pendingSheriffHandoff) {
    room.pendingSheriffHandoff = { sheriffId: sheriff.id, deadline: Date.now() + room.timers.nightAction * 1000 };
  }

  if (!reactiveClear(room)) {
    room.afterReactive = 'to_discussion_from_announce';
    return; // stay in day_announce until hunter shot / handoff resolve
  }
  finalizeAnnounceIntoDiscussion(room);
}

function finalizeAnnounceIntoDiscussion(room) {
  room.phase = 'day_announce';
  const deaths = room.lastNightDeaths.map((d) => d.id).filter((id) => getPlayer(room, id) && !getPlayer(room, id).alive);
  const sheriff = room.sheriffId ? getPlayer(room, room.sheriffId) : null;

  if (deaths.length === 1) {
    const deceasedId = deaths[0];
    if (sheriff && sheriff.alive) {
      const leftId = neighborInDirection(room, deceasedId, 'left', (p) => p);
      const rightId = neighborInDirection(room, deceasedId, 'right', (p) => p);
      room.pendingSheriffDirection = {
        kind: 'death', deceasedId, leftId, rightId,
        deadline: Date.now() + room.timers.nightAction * 1000,
      };
      return; // wait for the sheriff (or the timer) to pick a side
    }
    const direction = Math.random() < 0.5 ? 'left' : 'right';
    const startId = neighborInDirection(room, deceasedId, direction, (p) => p && p.alive);
    startDiscussion(room, startId ? buildRotation(room, startId, direction) : [], direction);
    return;
  }

  // zero, or 2+, deaths
  if (sheriff && sheriff.alive) {
    const leftId = neighborInDirection(room, sheriff.id, 'left', (p) => p && p.alive);
    const rightId = neighborInDirection(room, sheriff.id, 'right', (p) => p && p.alive);
    room.pendingSheriffDirection = {
      kind: 'last', leftId, rightId,
      deadline: Date.now() + room.timers.nightAction * 1000,
    };
    return;
  }
  const alive = alivePlayers(room);
  if (alive.length === 0) { startDiscussion(room, []); return; }
  const startId = pickRandom(alive.map((p) => p.id));
  const direction = Math.random() < 0.5 ? 'left' : 'right';
  startDiscussion(room, buildRotation(room, startId, direction), direction);
}

function resolveSheriffDirection(room, side) {
  const d = room.pendingSheriffDirection;
  room.pendingSheriffDirection = null;
  const chosenId = side === 'left' ? d.leftId : d.rightId;
  if (d.kind === 'death') {
    if (!chosenId) { startDiscussion(room, []); return; }
    startDiscussion(room, buildRotation(room, chosenId, side), side);
  } else {
    const sheriff = room.sheriffId;
    if (!chosenId) { startDiscussion(room, sheriff && getPlayer(room, sheriff)?.alive ? [sheriff] : []); return; }
    const rest = buildRotation(room, chosenId, side, (p) => p && p.alive && p.id !== sheriff);
    startDiscussion(room, [...rest, sheriff], side);
  }
}

function startDiscussion(room, queue, direction = null) {
  room.phase = 'day_discussion';
  room.discussion = {
    queue,
    pointer: 0,
    deadline: queue.length > 0 ? Date.now() + room.timers.speech * 1000 : null,
    // 'left' | 'right' | null — which way the speech order is walking the
    // (fixed, never-reordered) seat list, so the UI can show an explicit
    // arrow instead of making players infer it from watching the highlight
    // jump around (including wrapping bottom-to-top or top-to-bottom).
    direction,
  };
  if (queue.length === 0) startVoteCountdown(room);
}

function discussionAdvance(room) {
  const d = room.discussion;
  if (!d) return;
  d.pointer += 1;
  if (d.pointer >= d.queue.length) {
    startVoteCountdown(room);
  } else {
    d.deadline = Date.now() + room.timers.speech * 1000;
  }
}

// Removes any player who has died from the remaining discussion queue
// (used after a Knight/Werewolf King interrupt). Advances past the current
// speaker if they were the one removed.
function pruneDiscussionQueue(room) {
  const d = room.discussion;
  if (!d) return;
  const remaining = d.queue.slice(d.pointer).filter((id) => getPlayer(room, id)?.alive);
  const already = d.queue.slice(0, d.pointer);
  d.queue = [...already, ...remaining];
  if (d.pointer >= d.queue.length) {
    startVoteCountdown(room);
  } else {
    d.deadline = Date.now() + room.timers.speech * 1000;
  }
}

function startVoteCountdown(room) {
  room.phase = 'day_vote_countdown';
  room.voteCountdownDeadline = Date.now() + VOTE_COUNTDOWN_SECONDS * 1000;
}

function openVoting(room) {
  room.phase = 'day_vote';
  room.dayVotes = new Map();
  room.voteDeadline = Date.now() + room.timers.dayVote * 1000;
}

// ---------------------------------------------------------------------------
// Win condition
// ---------------------------------------------------------------------------
function checkWinCondition(room) {
  const wolvesAlive = aliveWolfTeam(room).length;
  if (wolvesAlive === 0) {
    room.phase = 'game_over';
    room.winner = 'village';
    log(room, 'All werewolves have been eliminated. The village wins!');
    return true;
  }

  if (room.winConditionMode === 'extinction') {
    const godRoles = ROLE_NAMES.filter((r) => ROLE_DEFS[r].category === 'god');
    const godsConfigured = godRoles.reduce((s, r) => s + (room.roleConfig[r] || 0), 0);
    const villagersConfigured = room.roleConfig.Villager || 0;
    const godsAlive = alivePlayers(room).filter((p) => ROLE_DEFS[p.role].category === 'god').length;
    const villagersAlive = alivePlayers(room).filter((p) => ROLE_DEFS[p.role].category === 'villager').length;
    const godsWiped = godsConfigured > 0 && godsAlive === 0;
    const villagersWiped = villagersConfigured > 0 && villagersAlive === 0;
    if (godsWiped || villagersWiped) {
      room.phase = 'game_over';
      room.winner = 'wolves';
      const which = godsWiped && villagersWiped ? 'both the Gods and the Villagers' : godsWiped ? 'all the Gods' : 'all the Villagers';
      log(room, `The werewolves have wiped out ${which}. The werewolves win!`);
      return true;
    }
    return false;
  }

  const villageAlive = alivePlayers(room).filter((p) => ROLE_DEFS[p.role].team === 'village').length;
  if (wolvesAlive >= villageAlive) {
    room.phase = 'game_over';
    room.winner = 'wolves';
    log(room, 'The werewolves equal or outnumber the village. The werewolves win!');
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Day vote
// ---------------------------------------------------------------------------
function tallyDayVotes(room) {
  const weight = (voterId) => (room.sheriffId === voterId ? 1.5 : 1);
  const counts = new Map();
  for (const [voterId, targetId] of room.dayVotes.entries()) {
    counts.set(targetId, (counts.get(targetId) || 0) + weight(voterId));
  }
  return counts;
}

function resolveDayVote(room) {
  // Clear this immediately (before any reactive gate — hunter shot / sheriff
  // handoff — might stall the actual phase transition below). Otherwise the
  // tick loop's "day_vote deadline has passed" check keeps matching room.phase
  // (still 'day_vote') and re-invokes resolveDayVote a second time in the same
  // tick, replaying the whole vote resolution — e.g. re-killing a Fool who
  // had just survived on the first pass. Same pattern as concludeCampaign
  // clearing room.campaign before its own reactive gate.
  room.voteDeadline = null;
  const counts = tallyDayVotes(room);
  if (counts.size === 0) {
    log(room, 'No votes were cast. No one is eliminated today.');
    room.lastAnnouncement = ['No votes were cast — no one is eliminated.'];
    startNextNight(room);
    return;
  }
  let max = -1;
  for (const c of counts.values()) max = Math.max(max, c);
  const top = [...counts.entries()].filter(([, c]) => c === max).map(([id]) => id);
  const eliminatedId = pickRandom(top);
  const p = getPlayer(room, eliminatedId);

  if (p.role === 'Fool' && !p.foolRevealed) {
    p.foolRevealed = true;
    p.publiclyRevealed = true;
    p.canVote = false;
    const msg = `${p.name} was voted out — but revealed themselves as the Fool! They survive, but lose their vote for the rest of the game.`;
    log(room, msg);
    room.lastAnnouncement = [msg];
    // The Fool survives, but has just permanently lost their vote — if they
    // were holding the sheriff badge, it should hand off just like it would
    // on a death, rather than staying with someone who can no longer vote.
    if (room.sheriffId === p.id) {
      room.pendingSheriffHandoff = { sheriffId: p.id, deadline: Date.now() + room.timers.nightAction * 1000 };
    }
    room.afterReactive = 'to_next_night_after_vote';
    trySettleReactive(room);
    return;
  }

  applyDeaths(room, [{ id: eliminatedId, cause: 'day_vote' }], { announceImmediately: true });
  const roleNote = room.revealRoleOnDeath ? ` They were the ${ROLE_DEFS[p.role].label}.` : '';
  const msg = `The village voted to eliminate ${p.name}.${roleNote}`;
  log(room, msg);
  room.lastAnnouncement = [msg];

  room.afterReactive = 'to_next_night_after_vote';
  trySettleReactive(room);
}

function startNextNight(room) {
  room.dayNumber += 1;
  log(room, `Night ${room.dayNumber} falls.`);
  beginNight(room);
}

function resolveHunterShot(room, hunterId, targetId) {
  room.pendingHunterShots = room.pendingHunterShots.filter((h) => h.hunterId !== hunterId);
  if (targetId) {
    const target = getPlayer(room, targetId);
    if (target && target.alive) {
      applyDeaths(room, [{ id: targetId, cause: 'hunter' }], { announceImmediately: true });
      const roleNote = room.revealRoleOnDeath ? ` They were the ${ROLE_DEFS[target.role].label}.` : '';
      const msg = `The Hunter's last shot kills ${target.name}.${roleNote}`;
      log(room, msg);
      room.lastAnnouncement = [...room.lastAnnouncement, msg];
    }
  }
  trySettleReactive(room);
}

function resolveSheriffHandoff(room, successorId) {
  const outgoing = room.pendingSheriffHandoff.sheriffId;
  room.pendingSheriffHandoff = null;
  if (successorId) {
    const successor = getPlayer(room, successorId);
    if (successor && successor.alive) {
      room.sheriffId = successorId;
      log(room, `${getPlayer(room, outgoing)?.name} passed the Sheriff badge to ${successor.name}.`);
    } else {
      room.sheriffId = null;
    }
  } else {
    room.sheriffId = null;
    log(room, 'The Sheriff badge was discarded.');
  }
  trySettleReactive(room);
}

// ---------------------------------------------------------------------------
// Timer engine — lazily resolves any expired deadline. Called at the top of
// every request that touches a room.
// ---------------------------------------------------------------------------
function tickRoom(room) {
  for (let guard = 0; guard < 50; guard++) {
    if (!tickOnce(room)) return;
  }
}

function tickOnce(room) {
  const now = Date.now();

  if (room.pendingSheriffDirection && now > room.pendingSheriffDirection.deadline) {
    resolveSheriffDirection(room, Math.random() < 0.5 ? 'left' : 'right');
    return true;
  }
  if (room.pendingSheriffHandoff && now > room.pendingSheriffHandoff.deadline) {
    resolveSheriffHandoff(room, null);
    return true;
  }
  // Deferred while the Day-1 campaign is still running (room.campaign is
  // only non-null during that window) — see resolveNight/concludeCampaign.
  if (!room.campaign && room.pendingHunterShots.length > 0 && now > room.pendingHunterShots[0].deadline) {
    resolveHunterShot(room, room.pendingHunterShots[0].hunterId, null);
    return true;
  }
  if (room.afterReactive && reactiveClear(room)) {
    trySettleReactive(room);
    return true;
  }

  if (room.phase === 'night' && room.nightDeadline && now > room.nightDeadline) {
    const step = room.nightSubPhase;
    if (step === 'guard' && !room.guardActedThisNight) {
      room.guardProtectedId = null;
      room.guardActedThisNight = true;
    } else if (step === 'seer' && !room.seerActedThisNight) {
      room.seerActedThisNight = true;
    } else if (step === 'witch' && !room.witchActedThisNight) {
      room.witchActedThisNight = true;
    }
    advanceNightSubPhase(room);
    return true;
  }

  if (room.phase === 'campaign' && room.campaign) {
    const c = room.campaign;
    if (c.subPhase === 'nominate' && now > c.deadline) { campaignCloseNominations(room); return true; }
    if (c.subPhase === 'speeches' && now > c.speechDeadline) { campaignAdvanceSpeech(room); return true; }
    if (c.subPhase === 'vote' && now > c.voteDeadline) { concludeCampaign(room); return true; }
  }

  if (room.phase === 'day_discussion' && room.discussion && room.discussion.deadline && now > room.discussion.deadline) {
    discussionAdvance(room);
    return true;
  }

  if (room.phase === 'day_vote_countdown' && room.voteCountdownDeadline && now > room.voteCountdownDeadline) {
    openVoting(room);
    return true;
  }

  if (room.phase === 'day_vote' && room.voteDeadline && now > room.voteDeadline) {
    resolveDayVote(room);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// View builder (single view for everyone — no omniscient role)
// ---------------------------------------------------------------------------
function publicPlayerList(room, viewer) {
  // `viewer` is who's asking, not who's listed — every viewer gets a list of
  // every player, this just decides what extra per-row info that viewer is
  // allowed to see about players who aren't them. Right now that's just
  // teammate identity for the wolf team: real Werewolf lets wolves recognize
  // each other for the whole game, not only during the night's kill vote, so
  // that has to be figured out relative to who's looking, same as role
  // visibility already is.
  const viewerIsWolf = !!(viewer && viewer.role && isWolfRole(viewer.role));
  // The Hidden Wolf's concealment is mutual: they don't recognize the other
  // wolves, and the other wolves don't recognize them either — so neither
  // direction gets the 🐺 teammate marker for the other.
  const viewerIsHiddenWolf = !!(viewer && viewer.role === 'HiddenWolf');
  const viewerId = viewer ? viewer.id : null;
  const gameOver = room.phase === 'game_over';
  return room.seatOrder.length ? room.seatOrder.map((id) => playerListEntry(room, getPlayer(room, id), gameOver, viewerIsWolf, viewerId, viewerIsHiddenWolf))
    : [...room.players.values()].map((p) => playerListEntry(room, p, gameOver, viewerIsWolf, viewerId, viewerIsHiddenWolf));
}
function playerListEntry(room, p, gameOver, viewerIsWolf, viewerId, viewerIsHiddenWolf) {
  const alive = gameOver ? p.alive : p.publicAlive;
  const showRole = gameOver || p.publiclyRevealed || (!alive && room.revealRoleOnDeath);
  const showTeammate = viewerIsWolf && !showRole && p.id !== viewerId && isWolfRole(p.role)
    && !viewerIsHiddenWolf && p.role !== 'HiddenWolf';
  return {
    id: p.id,
    name: p.name,
    alive,
    connected: p.connected,
    isSheriff: room.sheriffId === p.id,
    canVote: p.canVote !== false,
    isLobbyLeader: room.lobbyLeaderId === p.id,
    role: showRole ? p.role : undefined,
    isWolfTeammate: showTeammate ? true : undefined,
  };
}

function secondsLeft(deadline) {
  if (!deadline) return null;
  return Math.max(0, Math.round((deadline - Date.now()) / 1000));
}

function buildPlayerView(room, player) {
  const youAlive = room.phase === 'game_over' ? player.alive : player.publicAlive;
  const view = {
    roomCode: room.code,
    phase: room.phase,
    dayNumber: room.dayNumber,
    nightSubPhase: room.phase === 'night' ? room.nightSubPhase : null,
    nightSecondsLeft: room.phase === 'night' ? secondsLeft(room.nightDeadline) : null,
    winConditionMode: room.winConditionMode,
    revealRoleOnDeath: room.revealRoleOnDeath,
    timers: room.timers,
    you: {
      id: player.id,
      name: player.name,
      role: player.role,
      roleLabel: player.role ? ROLE_DEFS[player.role].label : null,
      roleBlurb: player.role ? ROLE_DEFS[player.role].blurb : null,
      team: player.role ? ROLE_DEFS[player.role].team : null,
      alive: youAlive,
      isSheriff: room.sheriffId === player.id,
      viewedRole: player.viewedRole,
      canVote: player.canVote !== false,
      isLobbyLeader: room.lobbyLeaderId === player.id,
    },
    players: publicPlayerList(room, player),
    sheriffId: room.sheriffId,
    log: publicLog(room, 40),
    winner: room.winner,
  };

  if (room.phase === 'lobby') {
    view.lobby = {
      roleConfig: room.roleConfig,
      roleNames: ROLE_NAMES,
      roleMeta: Object.fromEntries(ROLE_NAMES.map((r) => [r, { label: ROLE_DEFS[r].label, icon: ROLE_DEFS[r].icon, team: ROLE_DEFS[r].team, category: ROLE_DEFS[r].category, maxCount: ROLE_DEFS[r].maxCount ?? null }])),
      playerCount: room.players.size,
      totalRoleCount: Object.values(room.roleConfig).reduce((a, b) => a + b, 0),
    };
  }

  if (player.role === 'Hunter' && room.hunterNightStatus.has(player.id)) {
    view.hunterNightStatus = { known: true, canFire: room.hunterNightStatus.get(player.id) };
  }

  // Deliberately NOT gated on room.phase === 'night' or on nightSubPhase — a
  // minimal game (e.g. just a Seer + wolves, no Guard/Witch) can finish
  // resolving the whole night synchronously within the Seer's own check
  // request, moving straight to the day before the client's next poll. This
  // keeps the result visible for the rest of that night AND the following
  // day, only clearing when the next night's beginNight() resets it.
  if (player.role === 'Seer' && room.seerResult) {
    view.seerLastResult = room.seerResult;
  }

  if (room.phase === 'night' && player.alive) {
    if (room.nightSubPhase === 'guard' && player.role === 'Guard') {
      view.guardPhase = {
        active: true, acted: room.guardActedThisNight, secondsLeft: secondsLeft(room.nightDeadline),
        candidates: alivePlayers(room).map((p) => ({ id: p.id, name: p.name, disabled: p.id === room.guardLastProtectedId })),
      };
    }
    // A dormant Hidden Wolf (other wolves still alive) gets no wolfPhase at
    // all — they don't wake up with the pack and don't even see that a
    // wolves' phase is happening, per activeWolfTeam().
    if (room.nightSubPhase === 'wolves' && isWolfRole(player.role) && activeWolfTeam(room).some((w) => w.id === player.id)) {
      const wolves = activeWolfTeam(room);
      // Wolves see each other's current picks live, so they can shift to
      // converge on one target mid-phase — mirrors real wolves pointing/
      // gesturing at each other during the night round. Only shown among
      // the active pack itself (a dormant Hidden Wolf never sees this at
      // all, since they have no wolfPhase view to begin with).
      view.wolfPhase = {
        active: true, secondsLeft: secondsLeft(room.nightDeadline),
        // Wolves CAN target each other — a wolf-on-wolf kill is a real,
        // occasionally used strategy (e.g. to cast suspicion elsewhere, or
        // to get rid of a teammate whose play is putting the pack at risk).
        // Only self-targeting is excluded. Note this also means a dormant
        // Hidden Wolf can be targeted (and killed) by the other wolves —
        // they have no way to recognize them as a teammate either.
        candidates: alivePlayers(room).filter((p) => p.id !== player.id).map((p) => ({
          id: p.id, name: p.name,
          votedBy: wolves.filter((w) => room.wolfVotes.get(w.id) === p.id).map((w) => w.name),
        })),
        yourVote: room.wolfVotes.get(player.id) || null,
        votedCount: room.wolfVotes.size,
        totalWolves: wolves.length,
        wolfPack: wolves.map((w) => ({ id: w.id, name: w.name })),
        // Per-teammate status, in pack (seating) order — who's picked whom
        // so far, and who's still deciding.
        packStatus: wolves.map((w) => {
          const targetId = room.wolfVotes.get(w.id) || null;
          const target = targetId ? getPlayer(room, targetId) : null;
          return { id: w.id, name: w.name, isYou: w.id === player.id, targetId, targetName: target ? target.name : null };
        }),
      };
    }
    if (room.nightSubPhase === 'seer' && player.role === 'Seer') {
      view.seerPhase = {
        active: true, acted: room.seerActedThisNight, secondsLeft: secondsLeft(room.nightDeadline),
        candidates: alivePlayers(room).filter((p) => p.id !== player.id).map((p) => ({ id: p.id, name: p.name })),
      };
    }
    if (room.nightSubPhase === 'witch' && player.role === 'Witch') {
      const victim = room.pendingNightVictim ? getPlayer(room, room.pendingNightVictim) : null;
      const canReveal = !room.witch.healUsed;
      view.witchPhase = {
        active: true, acted: room.witchActedThisNight, secondsLeft: secondsLeft(room.nightDeadline),
        canHeal: !room.witch.healUsed && !!room.pendingNightVictim,
        canPoison: !room.witch.poisonUsed,
        revealedVictim: canReveal && victim ? { id: victim.id, name: victim.name } : null,
        noOneDiedTonight: canReveal && !victim,
        candidates: alivePlayers(room).map((p) => ({ id: p.id, name: p.name })),
      };
    }
  }

  if (room.phase === 'campaign' && room.campaign) {
    const c = room.campaign;
    const iAmCandidate = c.candidateIds.includes(player.id);
    view.campaign = {
      subPhase: c.subPhase,
      candidateIds: c.candidateIds,
      candidateNames: c.candidateIds.map((id) => getPlayer(room, id)?.name),
      youAreCandidate: iAmCandidate,
      secondsLeft: c.subPhase === 'nominate' ? secondsLeft(c.deadline) : c.subPhase === 'speeches' ? secondsLeft(c.speechDeadline) : secondsLeft(c.voteDeadline),
    };
    if (c.subPhase === 'nominate') {
      view.campaign.canToggle = player.publicAlive;
    }
    if (c.subPhase === 'speeches') {
      view.campaign.currentSpeakerId = c.speechQueue[c.speechPointer] || null;
      view.campaign.queue = c.speechQueue;
      view.campaign.pointer = c.speechPointer;
      view.campaign.isYourTurn = c.speechQueue[c.speechPointer] === player.id;
    }
    if (c.subPhase === 'vote') {
      view.campaign.candidates = c.candidateIds.map((id) => ({ id, name: getPlayer(room, id)?.name }));
      view.campaign.yourVote = c.votes.get(player.id) || null;
      // Candidates don't get a vote in their own election.
      view.campaign.canVote = player.publicAlive && !iAmCandidate;
    }
  }

  if (room.phase === 'day_announce' || room.phase === 'day_discussion' || room.phase === 'day_vote_countdown' || room.phase === 'day_vote') {
    view.announcement = room.lastAnnouncement;
  }

  // Held back while room.campaign is still active — the Day-1 campaign must
  // run undisturbed before a Hunter's own death/revenge shot is ever exposed.
  if (!room.campaign && room.pendingHunterShots[0]?.hunterId === player.id) {
    view.hunterShot = {
      active: true, secondsLeft: secondsLeft(room.pendingHunterShots[0].deadline),
      candidates: alivePlayers(room).filter((p) => p.id !== player.id).map((p) => ({ id: p.id, name: p.name })),
    };
  }
  if (room.pendingSheriffHandoff && room.pendingSheriffHandoff.sheriffId === player.id) {
    view.sheriffHandoff = {
      active: true, secondsLeft: secondsLeft(room.pendingSheriffHandoff.deadline),
      candidates: alivePlayers(room).filter((p) => p.id !== player.id).map((p) => ({ id: p.id, name: p.name })),
    };
  }
  if (room.pendingSheriffDirection && room.sheriffId === player.id) {
    const d = room.pendingSheriffDirection;
    view.sheriffDirection = {
      active: true, kind: d.kind, secondsLeft: secondsLeft(d.deadline),
      deceasedName: d.kind === 'death' && d.deceasedId ? getPlayer(room, d.deceasedId)?.name : null,
      leftId: d.leftId || null,
      leftName: d.leftId ? getPlayer(room, d.leftId)?.name : null,
      rightId: d.rightId || null,
      rightName: d.rightId ? getPlayer(room, d.rightId)?.name : null,
    };
  }

  if (room.phase === 'day_discussion' && room.discussion) {
    const dsc = room.discussion;
    view.discussion = {
      queue: dsc.queue,
      pointer: dsc.pointer,
      currentSpeakerId: dsc.queue[dsc.pointer] || null,
      isYourTurn: dsc.queue[dsc.pointer] === player.id,
      secondsLeft: secondsLeft(dsc.deadline),
      // 'right' walks the fixed roster downward (wrapping to the top);
      // 'left' walks it upward (wrapping to the bottom). Sent so the UI can
      // show an explicit arrow instead of making players infer direction.
      direction: dsc.direction || null,
    };
    const reactivePending = !reactiveClear(room);
    if (player.alive && !reactivePending) {
      if (player.role === 'Knight' && !player.knightUsed) {
        view.knightDuel = { active: true, candidates: alivePlayers(room).filter((p) => p.id !== player.id).map((p) => ({ id: p.id, name: p.name })) };
      }
      if (player.role === 'WerewolfKing' && !player.wolfKingUsed) {
        view.wolfKingReveal = { active: true, candidates: alivePlayers(room).filter((p) => p.id !== player.id).map((p) => ({ id: p.id, name: p.name })) };
      }
    }
  }

  if (room.phase === 'day_vote_countdown') {
    view.voteCountdown = { secondsLeft: secondsLeft(room.voteCountdownDeadline) };
  }

  if (room.phase === 'day_vote' && player.alive) {
    if (player.canVote === false) {
      view.dayVoteBlocked = true;
    } else {
      // No live tally here on purpose — showing a running "who's leading"
      // count while voting is still open lets people bandwagon onto whoever
      // is already ahead, or read off who voted for whom from the shifting
      // numbers. Only the vote-count-so-far (not the breakdown) is shown.
      view.dayVote = {
        candidates: alivePlayers(room).filter((p) => p.id !== player.id).map((p) => ({ id: p.id, name: p.name })),
        yourVote: room.dayVotes.get(player.id) || null,
        youWeight: room.sheriffId === player.id ? 1.5 : 1,
        votedCount: room.dayVotes.size,
        totalVoters: votingEligible(room).length,
        secondsLeft: secondsLeft(room.voteDeadline),
      };
    }
  }

  if (room.phase === 'game_over') {
    view.reveal = [...room.players.values()].map((p) => ({ id: p.id, name: p.name, role: p.role, roleLabel: ROLE_DEFS[p.role]?.label, alive: p.alive }));
    // The recap replays the same curated "what happened" story everyone saw
    // live — it does not additionally unlock the secret, per-night action
    // log (who the Guard protected, who the Seer looked at, who the Witch
    // targeted). That's a deliberate extension of "night deaths are never
    // explained": the recap confirms outcomes, not every private mechanic
    // that led there.
    view.fullLog = room.log.filter((e) => !e.secret).map((e) => ({ t: e.t, text: e.text }));
  }

  return view;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) { reject(new Error('Body too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function requireRoom(code) {
  const room = rooms.get((code || '').toUpperCase().trim());
  if (room) tickRoom(room);
  return room;
}

function requirePlayer(body) {
  const room = requireRoom(body.roomCode);
  if (!room) return null;
  const player = getPlayer(room, body.playerId);
  if (!player || player.token !== body.token) return null;
  player.lastSeen = Date.now();
  player.connected = true;
  touch(room);
  return { room, player };
}
function requireLeader(body) {
  const ctx = requirePlayer(body);
  if (!ctx || ctx.room.lobbyLeaderId !== ctx.player.id) return null;
  return ctx;
}

// action handlers: (body) => result object (must include `ok`)
const actions = {
  'player/createRoom': (body) => {
    const code = genRoomCode();
    const room = newRoom(code);
    rooms.set(code, room);
    const cleanName = (body.name || '').trim().slice(0, 24) || 'Player';
    const player = newPlayer(cleanName);
    room.players.set(player.id, player);
    room.lobbyLeaderId = player.id;
    touch(room);
    return { ok: true, roomCode: code, playerId: player.id, token: player.token };
  },
  'player/join': (body) => {
    const room = requireRoom(body.roomCode);
    if (!room) return { ok: false, error: 'Room not found. Check the code.' };
    if (room.phase !== 'lobby') return { ok: false, error: 'This game has already started.' };
    const cleanName = (body.name || '').trim().slice(0, 24) || 'Player';
    const existing = [...room.players.values()].find((p) => p.name.toLowerCase() === cleanName.toLowerCase());
    if (existing) return { ok: false, error: 'That name is taken in this room.' };
    const player = newPlayer(cleanName);
    room.players.set(player.id, player);
    touch(room);
    return { ok: true, roomCode: room.code, playerId: player.id, token: player.token };
  },
  'player/rejoin': (body) => {
    const room = requireRoom(body.roomCode);
    if (!room) return { ok: false, error: 'Room not found.' };
    const player = getPlayer(room, body.playerId);
    if (!player || player.token !== body.token) return { ok: false, error: 'Could not rejoin.' };
    player.connected = true;
    player.lastSeen = Date.now();
    return { ok: true };
  },
  'player/viewedRole': (body) => {
    const ctx = requirePlayer(body);
    if (!ctx) return { ok: false, error: 'Not found.' };
    ctx.player.viewedRole = true;
    return { ok: true };
  },

  // --- lobby-leader settings (pre-game) ---
  'player/setRoleConfig': (body) => {
    const ctx = requireLeader(body);
    if (!ctx) return { ok: false, error: 'Only the lobby leader can do that.' };
    const { room } = ctx;
    if (room.phase !== 'lobby') return { ok: false, error: 'Game already started.' };
    for (const role of ROLE_NAMES) {
      const n = Number(body.roleConfig?.[role]);
      let v = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
      const cap = ROLE_DEFS[role].maxCount;
      if (cap !== undefined && v > cap) v = cap;
      room.roleConfig[role] = v;
    }
    return { ok: true };
  },
  'player/setRevealRoleOnDeath': (body) => {
    const ctx = requireLeader(body);
    if (!ctx) return { ok: false, error: 'Only the lobby leader can do that.' };
    ctx.room.revealRoleOnDeath = !!body.value;
    return { ok: true };
  },
  'player/setWinCondition': (body) => {
    const ctx = requireLeader(body);
    if (!ctx) return { ok: false, error: 'Only the lobby leader can do that.' };
    const { room } = ctx;
    if (room.phase !== 'lobby') return { ok: false, error: 'Cannot change this after the game has started.' };
    if (body.mode !== 'majority' && body.mode !== 'extinction') return { ok: false, error: 'Unknown win condition.' };
    room.winConditionMode = body.mode;
    return { ok: true };
  },
  'player/setTimers': (body) => {
    const ctx = requireLeader(body);
    if (!ctx) return { ok: false, error: 'Only the lobby leader can do that.' };
    const { room } = ctx;
    if (room.phase !== 'lobby') return { ok: false, error: 'Cannot change this after the game has started.' };
    for (const key of TIMER_KEYS) {
      if (body.timers && body.timers[key] !== undefined) {
        const v = clampTimer(body.timers[key]);
        if (v !== null) room.timers[key] = v;
      }
    }
    return { ok: true };
  },
  'player/startGame': (body) => {
    const ctx = requireLeader(body);
    if (!ctx) return { ok: false, error: 'Only the lobby leader can do that.' };
    const { room } = ctx;
    if (room.phase !== 'lobby') return { ok: false, error: 'Game already started.' };
    const total = Object.values(room.roleConfig).reduce((a, b) => a + b, 0);
    if (total !== room.players.size) return { ok: false, error: `Role count (${total}) must equal player count (${room.players.size}).` };
    if (room.players.size < 3) return { ok: false, error: 'Need at least 3 players.' };
    for (const role of ROLE_NAMES) {
      const cap = ROLE_DEFS[role].maxCount;
      if (cap !== undefined && (room.roleConfig[role] || 0) > cap) {
        return { ok: false, error: `Only ${cap} ${ROLE_DEFS[role].label} allowed.` };
      }
    }
    const wolfCount = ROLE_NAMES.filter((r) => ROLE_DEFS[r].team === 'wolf').reduce((s, r) => s + (room.roleConfig[r] || 0), 0);
    if (wolfCount < 1) return { ok: false, error: 'Need at least 1 Werewolf (or Werewolf King / Hidden Wolf).' };
    startGame(room);
    return { ok: true };
  },
  'player/resetGame': (body) => {
    const ctx = requireLeader(body);
    if (!ctx) return { ok: false, error: 'Only the lobby leader can do that.' };
    resetGame(ctx.room);
    return { ok: true };
  },
  'player/removePlayer': (body) => {
    const ctx = requireLeader(body);
    if (!ctx) return { ok: false, error: 'Only the lobby leader can do that.' };
    const { room } = ctx;
    if (room.phase !== 'lobby') return { ok: false, error: 'Cannot remove players mid-game.' };
    if (body.playerId === room.lobbyLeaderId) return { ok: false, error: 'The lobby leader can\'t remove themselves.' };
    room.players.delete(body.playerId);
    return { ok: true };
  },

  // --- night actions ---
  'player/guardProtect': (body) => {
    const ctx = requirePlayer(body);
    if (!ctx) return { ok: false, error: 'Not found.' };
    const { room, player } = ctx;
    if (room.phase !== 'night' || room.nightSubPhase !== 'guard' || player.role !== 'Guard' || !player.alive) return { ok: false, error: 'It’s not your turn.' };
    if (room.guardActedThisNight) return { ok: false, error: 'You already acted tonight.' };
    if (body.action === 'skip') {
      room.guardProtectedId = null;
      room.guardLastProtectedId = null;
    } else {
      const target = getPlayer(room, body.targetId);
      if (!target || !target.alive) return { ok: false, error: 'Invalid target.' };
      if (target.id === room.guardLastProtectedId) return { ok: false, error: 'You cannot protect the same player two nights in a row.' };
      room.guardProtectedId = target.id;
      room.guardLastProtectedId = target.id;
      log(room, `${player.name} (Guard) protected ${target.name}.`, { secret: true });
    }
    room.guardActedThisNight = true;
    advanceNightSubPhase(room);
    return { ok: true };
  },
  'player/wolfVote': (body) => {
    const ctx = requirePlayer(body);
    if (!ctx) return { ok: false, error: 'Not found.' };
    const { room, player } = ctx;
    if (room.phase !== 'night' || room.nightSubPhase !== 'wolves' || !isWolfRole(player.role) || !player.alive) return { ok: false, error: 'It’s not the wolves’ turn.' };
    // A dormant Hidden Wolf (other wolves still alive) has no kill ability yet.
    if (!activeWolfTeam(room).some((w) => w.id === player.id)) return { ok: false, error: 'It’s not the wolves’ turn.' };
    const target = getPlayer(room, body.targetId);
    // Wolves may target a fellow wolf — only self-targeting is blocked.
    if (!target || !target.alive || target.id === player.id) return { ok: false, error: 'Invalid target.' };
    room.wolfVotes.set(player.id, body.targetId);
    // Only fast-forward past the wolves' phase once the whole active pack has
    // voted AND currently agrees on the same target. This is what makes the
    // live pack-status display meaningful: wolves can watch each other's picks
    // and switch to converge, the same way real wolves gesture at the table.
    // If they haven't converged, the phase simply runs out the clock (a tie
    // among differing votes is broken randomly at resolution, same as always) —
    // it never locks in early on a disagreement.
    const wolves = activeWolfTeam(room);
    if (room.wolfVotes.size >= wolves.length) {
      const targets = wolves.map((w) => room.wolfVotes.get(w.id));
      if (targets.every((t) => t === targets[0])) advanceNightSubPhase(room);
    }
    return { ok: true };
  },
  'player/seerView': (body) => {
    const ctx = requirePlayer(body);
    if (!ctx) return { ok: false, error: 'Not found.' };
    const { room, player } = ctx;
    if (room.phase !== 'night' || room.nightSubPhase !== 'seer' || player.role !== 'Seer' || !player.alive) return { ok: false, error: 'It’s not your turn.' };
    if (room.seerActedThisNight) return { ok: false, error: 'You already looked at someone tonight.' };
    const target = getPlayer(room, body.targetId);
    if (!target || !target.alive || target.id === player.id) return { ok: false, error: 'Invalid target.' };
    room.seerActedThisNight = true;
    // The Hidden Wolf's whole gimmick is fooling the Seer specifically —
    // every other form of detection (e.g. a Knight's duel) still correctly
    // identifies them as a wolf via isWolfRole/ROLE_DEFS.team as normal.
    const apparentTeam = target.role === 'HiddenWolf' ? 'village' : ROLE_DEFS[target.role].team;
    const result = { name: target.name, team: apparentTeam };
    room.seerResult = result; // persisted so a page reload doesn't lose it
    log(room, `${player.name} (Seer) looked at ${target.name}.`, { secret: true });
    advanceNightSubPhase(room);
    return { ok: true, result };
  },
  'player/witchAction': (body) => {
    const ctx = requirePlayer(body);
    if (!ctx) return { ok: false, error: 'Not found.' };
    const { room, player } = ctx;
    if (room.phase !== 'night' || room.nightSubPhase !== 'witch' || player.role !== 'Witch' || !player.alive) return { ok: false, error: 'It’s not your turn.' };
    if (room.witchActedThisNight) return { ok: false, error: 'You already acted tonight.' };
    if (body.action === 'heal') {
      if (room.witch.healUsed || !room.pendingNightVictim) return { ok: false, error: 'You cannot heal right now.' };
      room.witch.healUsed = true;
      room.healedTargetId = room.pendingNightVictim;
      log(room, `${player.name} (Witch) used the healing potion.`, { secret: true });
    } else if (body.action === 'poison') {
      if (room.witch.poisonUsed) return { ok: false, error: 'You already used your poison.' };
      const target = getPlayer(room, body.targetId);
      if (!target || !target.alive) return { ok: false, error: 'Invalid target.' };
      room.witch.poisonUsed = true;
      room.poisonTargetId = body.targetId;
      log(room, `${player.name} (Witch) used the poison potion.`, { secret: true });
    } else if (body.action !== 'skip') {
      return { ok: false, error: 'Unknown action.' };
    }
    room.witchActedThisNight = true;
    advanceNightSubPhase(room);
    return { ok: true };
  },

  // --- day-1 campaign ---
  'player/runForSheriff': (body) => {
    const ctx = requirePlayer(body);
    if (!ctx) return { ok: false, error: 'Not found.' };
    const { room, player } = ctx;
    if (room.phase !== 'campaign' || room.campaign.subPhase !== 'nominate' || !player.publicAlive) return { ok: false, error: 'Nominations are not open.' };
    const c = room.campaign;
    const i = c.candidateIds.indexOf(player.id);
    if (body.action === 'withdraw') {
      if (i >= 0) c.candidateIds.splice(i, 1);
    } else {
      if (i === -1) c.candidateIds.push(player.id);
    }
    return { ok: true };
  },
  'player/campaignSpeechDone': (body) => {
    const ctx = requirePlayer(body);
    if (!ctx) return { ok: false, error: 'Not found.' };
    const { room, player } = ctx;
    if (room.phase !== 'campaign' || room.campaign.subPhase !== 'speeches') return { ok: false, error: 'Not your turn.' };
    const c = room.campaign;
    if (c.speechQueue[c.speechPointer] !== player.id) return { ok: false, error: 'Not your turn.' };
    campaignAdvanceSpeech(room);
    return { ok: true };
  },
  'player/electionVote': (body) => {
    const ctx = requirePlayer(body);
    if (!ctx) return { ok: false, error: 'Not found.' };
    const { room, player } = ctx;
    if (room.phase !== 'campaign' || room.campaign.subPhase !== 'vote' || !player.publicAlive) return { ok: false, error: 'Voting is not open.' };
    const c = room.campaign;
    // Candidates don't get a vote in their own election.
    if (c.candidateIds.includes(player.id)) return { ok: false, error: 'Candidates cannot vote in their own election.' };
    if (!c.candidateIds.includes(body.targetId)) return { ok: false, error: 'Invalid candidate.' };
    c.votes.set(player.id, body.targetId);
    const eligibleVoters = publicAlivePlayers(room).filter((p) => !c.candidateIds.includes(p.id));
    if (c.votes.size >= eligibleVoters.length) concludeCampaign(room);
    return { ok: true };
  },

  // --- reactive prompts ---
  'player/hunterShoot': (body) => {
    const ctx = requirePlayer(body);
    if (!ctx) return { ok: false, error: 'Not found.' };
    const { room, player } = ctx;
    if (room.campaign) return { ok: false, error: 'The Sheriff campaign must finish first.' };
    if (room.pendingHunterShots[0]?.hunterId !== player.id) return { ok: false, error: 'You cannot fire right now.' };
    const target = getPlayer(room, body.targetId);
    if (!target || !target.alive) return { ok: false, error: 'Invalid target.' };
    resolveHunterShot(room, player.id, body.targetId);
    return { ok: true };
  },
  'player/sheriffHandoff': (body) => {
    const ctx = requirePlayer(body);
    if (!ctx) return { ok: false, error: 'Not found.' };
    const { room, player } = ctx;
    if (!room.pendingSheriffHandoff || room.pendingSheriffHandoff.sheriffId !== player.id) return { ok: false, error: 'Not your call right now.' };
    if (body.action === 'discard') {
      resolveSheriffHandoff(room, null);
    } else {
      const target = getPlayer(room, body.targetId);
      if (!target || !target.alive) return { ok: false, error: 'Invalid target.' };
      resolveSheriffHandoff(room, body.targetId);
    }
    return { ok: true };
  },
  'player/sheriffDirection': (body) => {
    const ctx = requirePlayer(body);
    if (!ctx) return { ok: false, error: 'Not found.' };
    const { room, player } = ctx;
    if (!room.pendingSheriffDirection || room.sheriffId !== player.id) return { ok: false, error: 'Not your call right now.' };
    if (body.side !== 'left' && body.side !== 'right') return { ok: false, error: 'Pick left or right.' };
    resolveSheriffDirection(room, body.side);
    return { ok: true };
  },

  // --- day discussion ---
  'player/finishSpeech': (body) => {
    const ctx = requirePlayer(body);
    if (!ctx) return { ok: false, error: 'Not found.' };
    const { room, player } = ctx;
    if (room.phase !== 'day_discussion' || !room.discussion) return { ok: false, error: 'No discussion right now.' };
    if (room.discussion.queue[room.discussion.pointer] !== player.id) return { ok: false, error: 'Not your turn.' };
    discussionAdvance(room);
    return { ok: true };
  },
  'player/knightDuel': (body) => {
    const ctx = requirePlayer(body);
    if (!ctx) return { ok: false, error: 'Not found.' };
    const { room, player } = ctx;
    if (room.phase !== 'day_discussion' || player.role !== 'Knight' || !player.alive) return { ok: false, error: 'You cannot duel right now.' };
    if (player.knightUsed) return { ok: false, error: 'You already used your duel this game.' };
    if (!reactiveClear(room)) return { ok: false, error: 'Wait for the current event to resolve.' };
    const target = getPlayer(room, body.targetId);
    if (!target || !target.alive || target.id === player.id) return { ok: false, error: 'Invalid target.' };

    player.knightUsed = true;
    player.publiclyRevealed = true;
    target.publiclyRevealed = true;

    if (isWolfRole(target.role)) {
      applyDeaths(room, [{ id: target.id, cause: 'knight_duel' }], { announceImmediately: true });
      const msg = `${player.name} revealed themselves as the Knight and challenged ${target.name} to a duel — they were a Werewolf and have been slain! Night falls immediately.`;
      log(room, msg);
      room.lastAnnouncement = [...room.lastAnnouncement, msg];
      // A wolf's death jumps straight to night — the rest of the discussion
      // queue and the vote are skipped entirely, so we deliberately do NOT
      // touch room.discussion here.
      if (!reactiveClear(room)) { room.afterReactive = 'to_night_knight'; return { ok: true }; }
      if (checkWinCondition(room)) return { ok: true };
      startNextNight(room);
    } else {
      applyDeaths(room, [{ id: player.id, cause: 'knight_duel_shame' }], { announceImmediately: true });
      const msg = `${player.name} revealed themselves as the Knight and challenged ${target.name} to a duel — but ${target.name} was innocent, and the Knight dies of shame.`;
      log(room, msg);
      room.lastAnnouncement = [...room.lastAnnouncement, msg];
      if (!reactiveClear(room)) { room.afterReactive = 'resume_discussion'; return { ok: true }; }
      if (checkWinCondition(room)) return { ok: true };
      pruneDiscussionQueue(room);
    }
    return { ok: true };
  },
  'player/wolfKingReveal': (body) => {
    const ctx = requirePlayer(body);
    if (!ctx) return { ok: false, error: 'Not found.' };
    const { room, player } = ctx;
    if (room.phase !== 'day_discussion' || player.role !== 'WerewolfKing' || !player.alive) return { ok: false, error: 'You cannot do that right now.' };
    if (player.wolfKingUsed) return { ok: false, error: 'You already revealed yourself this game.' };
    if (!reactiveClear(room)) return { ok: false, error: 'Wait for the current event to resolve.' };
    const target = getPlayer(room, body.targetId);
    if (!target || !target.alive || target.id === player.id) return { ok: false, error: 'Invalid target.' };

    player.wolfKingUsed = true;
    player.publiclyRevealed = true;
    target.publiclyRevealed = true;
    applyDeaths(room, [{ id: player.id, cause: 'wolfking_reveal' }, { id: target.id, cause: 'wolfking_reveal' }], { announceImmediately: true });
    const msg = `${player.name} revealed themselves as the Werewolf King and took ${target.name} down with them!`;
    log(room, msg);
    room.lastAnnouncement = [...room.lastAnnouncement, msg];

    if (!reactiveClear(room)) { room.afterReactive = 'resume_discussion'; return { ok: true }; }
    if (checkWinCondition(room)) return { ok: true };
    pruneDiscussionQueue(room);
    return { ok: true };
  },

  // --- day vote ---
  'player/dayVote': (body) => {
    const ctx = requirePlayer(body);
    if (!ctx) return { ok: false, error: 'Not found.' };
    const { room, player } = ctx;
    // room.voteDeadline is cleared the instant resolveDayVote starts (even if
    // the actual phase change is delayed behind a hunter-shot/sheriff-handoff
    // reactive gate) — checking it here, not just room.phase, stops a
    // straggling vote from landing after the round has already resolved and
    // re-triggering resolution a second time via the "everyone voted" path.
    if (room.phase !== 'day_vote' || !room.voteDeadline || !player.alive) return { ok: false, error: 'Voting is not open.' };
    if (player.canVote === false) return { ok: false, error: 'You have lost your right to vote.' };
    const target = getPlayer(room, body.targetId);
    if (!target || !target.alive || target.id === player.id) return { ok: false, error: 'Invalid target.' };
    room.dayVotes.set(player.id, body.targetId);
    if (room.dayVotes.size >= votingEligible(room).length) resolveDayVote(room);
    return { ok: true };
  },
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === '/healthz') { res.writeHead(200); res.end('ok'); return; }

  if (pathname === '/api/roles' && req.method === 'GET') {
    const roles = ROLE_NAMES.map((r) => ({ name: r, label: ROLE_DEFS[r].label, icon: ROLE_DEFS[r].icon, team: ROLE_DEFS[r].team, category: ROLE_DEFS[r].category, blurb: ROLE_DEFS[r].blurb }));
    return sendJson(res, 200, { ok: true, roles, winConditions: WIN_CONDITION_DESCRIPTIONS, defaultTimers: DEFAULT_TIMERS, timerLimits: TIMER_LIMITS });
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    const roomCode = url.searchParams.get('room');
    const room = requireRoom(roomCode);
    if (!room) return sendJson(res, 200, { ok: false, error: 'Room not found.' });
    refreshConnectedFlags(room);
    const playerId = url.searchParams.get('playerId');
    const player = getPlayer(room, playerId);
    if (!player || player.token !== url.searchParams.get('token')) return sendJson(res, 200, { ok: false, error: 'Not authorized.' });
    player.lastSeen = Date.now();
    player.connected = true;
    return sendJson(res, 200, { ok: true, view: buildPlayerView(room, player) });
  }

  if (pathname.startsWith('/api/') && req.method === 'POST') {
    const key = pathname.slice('/api/'.length);
    const handler = actions[key];
    if (!handler) return sendJson(res, 404, { ok: false, error: 'Unknown action.' });
    try {
      const body = await readJsonBody(req);
      const result = handler(body) || { ok: false, error: 'No result.' };
      return sendJson(res, 200, result);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: 'Bad request.' });
    }
  }

  if (req.method === 'GET') return serveStatic(req, res, pathname);

  res.writeHead(404);
  res.end('Not found');
});

// Periodic cleanup of abandoned rooms (inactive > 8 hours)
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.lastActivity > 8 * 60 * 60 * 1000) rooms.delete(code);
  }
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Werewolf moderator listening on port ${PORT}`);
});
