// Pixel-art avatars: every player gets one when they join, can re-roll their
// OWN in the lobby only, keeps it for the whole game (including after
// dying), and the drawing itself is deterministic, varied, and never
// contains text or emoji that could be mistaken for a role.
const path = require('path');
const { api, state, setupRoom, configureAndStart, pollUntil, Tally } = require('./lib');
const { pixelAvatarSVG } = require(path.join(__dirname, '..', 'public', 'pixel-avatar.js'));

const t = new Tally();
const auth = (roomCode, p) => ({ roomCode, playerId: p.playerId, token: p.token });

function generatorChecks() {
  t.ok(pixelAvatarSVG('abc') === pixelAvatarSVG('abc'), '[draw] the same seed always draws the same avatar (same on every phone)');
  const svgs = new Set();
  for (let i = 0; i < 600; i++) svgs.add(pixelAvatarSVG('seed-' + i));
  t.ok(svgs.size >= 595, `[draw] 600 random seeds give ${svgs.size} distinct avatars`);
  const all = [...svgs].join('');
  t.ok(!/<text|[\u{1F300}-\u{1FAFF}]/u.test(all), '[draw] avatars are pure pixel shapes, with no text or emoji anywhere');
  t.ok([...svgs].every((s) => s.startsWith('<svg') && s.endsWith('</svg>')), '[draw] every avatar is a complete SVG');
}

async function lobbyAndGame() {
  const names = ['Av', 'Bex', 'Cato', 'Dru', 'Eko'];
  const { roomCode, players } = await setupRoom(names[0], names.slice(1));
  const leader = players[names[0]];
  let v = await state(roomCode, leader.playerId, leader.token);
  const seeds = v.players.map((p) => p.avatar);
  t.ok(seeds.every((s) => typeof s === 'string' && s.length >= 8), '[lobby] everyone gets an avatar automatically on joining', seeds);
  t.ok(new Set(seeds).size === seeds.length, '[lobby] no two players start with the same avatar', seeds);
  t.ok(v.you.avatar === v.players.find((p) => p.id === leader.playerId).avatar, '[lobby] your own avatar is in your view too');

  const bex = players.Bex;
  const before = (await state(roomCode, bex.playerId, bex.token)).you.avatar;
  const sh = await api('player/shuffleAvatar', auth(roomCode, bex));
  t.ok(sh.ok && sh.avatar && sh.avatar !== before, '[shuffle] shuffling gives Bex a new avatar', { before, after: sh.avatar });
  v = await state(roomCode, leader.playerId, leader.token);
  t.ok(v.players.find((p) => p.name === 'Bex').avatar === sh.avatar, '[shuffle] everyone else sees Bex\'s new look');
  t.ok(v.players.filter((p) => p.name !== 'Bex').every((p) => seeds.includes(p.avatar)), '[shuffle] nobody else\'s avatar changed');

  await configureAndStart(roomCode, players, names[0], { Werewolf: 1, Villager: 4 });
  const inGame = await api('player/shuffleAvatar', auth(roomCode, bex));
  t.ok(!inGame.ok, '[shuffle] avatars are locked once the game starts', inGame);

  const locked = (await state(roomCode, leader.playerId, leader.token)).players.map((p) => p.avatar);
  const roles = {};
  for (const n of names) roles[n] = (await state(roomCode, players[n].playerId, players[n].token)).you.role;
  const wolf = names.find((n) => roles[n] === 'Werewolf');
  await pollUntil(roomCode, leader, (v) => v.phase === 'day_vote', { timeoutMs: 20000 });
  for (const n of names) {
    if (n === wolf) await api('player/dayVoteAbstain', auth(roomCode, players[n]));
    else await api('player/dayVote', { ...auth(roomCode, players[n]), targetId: players[wolf].playerId });
  }
  await api('player/finishLastWords', auth(roomCode, players[wolf]));
  v = await pollUntil(roomCode, leader, (v) => v.phase === 'game_over', { timeoutMs: 6000 });
  t.ok(JSON.stringify(v.players.map((p) => p.avatar)) === JSON.stringify(locked), '[game] avatars never change during the game — not on death, not at game over');
  t.ok(v.reveal.every((r) => locked.includes(r.avatar)), '[game] the end-of-game reveal shows everyone\'s avatar next to their role');
}

(async () => {
  generatorChecks();
  await lobbyAndGame();
  t.finish();
})().catch((e) => { console.error(e); process.exit(1); });
