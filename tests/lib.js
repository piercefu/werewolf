// Shared helpers for the HTTP integration test suite. Zero dependencies —
// just Node's built-in fetch (Node 18+, same requirement as the app itself).
'use strict';

const BASE = process.env.BASE_URL || 'http://localhost:3300';

// Fast, but not instant — 1 real second per phase is short enough that a
// dozen phases resolve in well under a minute, but long enough to leave room
// for a handful of polls per phase. Requires the server to be started with
// WW_FAST_TIMERS=1 (see run-all.js), otherwise the 5s production floor wins
// and these become 5s waits instead of 1s.
const FAST_TIMERS = { candidacy: 1, electionVote: 1, nightAction: 1, dayVote: 1, speech: 1 };

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function api(action, body) {
  const res = await fetch(`${BASE}/api/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  return res.json();
}

async function state(roomCode, playerId, token) {
  const res = await fetch(`${BASE}/api/state?room=${roomCode}&playerId=${playerId}&token=${token}`);
  const j = await res.json();
  return j.view;
}

// Polls `fn(view)` against `player`'s view until it returns truthy or the
// deadline passes. Returns the last view either way (check the return value
// of fn separately if you need to distinguish "found" from "timed out").
async function pollUntil(roomCode, player, predicate, { timeoutMs = 15000, intervalMs = 200 } = {}) {
  let v = null;
  for (let deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
    v = await state(roomCode, player.playerId, player.token);
    if (predicate(v)) return v;
    await sleep(intervalMs);
  }
  return v;
}

// Creates a room with `leaderName` plus one joiner per name in `otherNames`.
// Returns { roomCode, players } where players is a name -> {playerId, token} map.
async function setupRoom(leaderName, otherNames) {
  const leaderJoin = await api('player/createRoom', { name: leaderName });
  const roomCode = leaderJoin.roomCode;
  const players = { [leaderName]: { playerId: leaderJoin.playerId, token: leaderJoin.token } };
  for (const n of otherNames) {
    const j = await api('player/join', { roomCode, name: n });
    players[n] = { playerId: j.playerId, token: j.token };
  }
  return { roomCode, players };
}

// Configures roles + fast timers and starts the game. `roleConfig` counts
// must sum to the total player count (leader + otherNames.length).
async function configureAndStart(roomCode, players, leaderName, roleConfig, timerOverrides) {
  const leader = players[leaderName];
  await api('player/setRoleConfig', { roomCode, playerId: leader.playerId, token: leader.token, roleConfig });
  await api('player/setTimers', { roomCode, playerId: leader.playerId, token: leader.token, timers: { ...FAST_TIMERS, ...timerOverrides } });
  return api('player/startGame', { roomCode, playerId: leader.playerId, token: leader.token });
}

// Finds which player name currently holds each of the given roles. Returns
// a { RoleName: playerName } map; a role with no match is left undefined.
async function findRoles(roomCode, players, allNames, roleNames) {
  const found = {};
  for (const n of allNames) {
    const p = players[n];
    const v = await state(roomCode, p.playerId, p.token);
    if (roleNames.includes(v.you.role)) found[v.you.role] = n;
  }
  return found;
}

// A minimal, self-contained assertion counter — each test file creates its
// own via `const t = new Tally();` and calls t.ok(...), then prints/exits.
class Tally {
  constructor() { this.pass = 0; this.fail = 0; }
  ok(cond, label, extra) {
    if (cond) { this.pass++; console.log('ok  -', label); }
    else { this.fail++; console.log('FAIL -', label, extra !== undefined ? JSON.stringify(extra) : ''); }
  }
  finish() {
    console.log(`\n${this.pass}/${this.pass + this.fail} checks passed.`);
    if (this.fail > 0) { console.log('SOME FAILED'); process.exit(1); }
    console.log('ALL GOOD');
  }
}

module.exports = { BASE, FAST_TIMERS, sleep, api, state, pollUntil, setupRoom, configureAndStart, findRoles, Tally };
