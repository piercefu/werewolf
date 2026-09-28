// Checks two real bugs found by playing: (1) a Hunter who fires their
// revenge shot didn't reliably, obviously reveal themselves as the Hunter —
// their identity was only ever exposed as a side effect of the table's
// revealRoleOnDeath toggle, so with that setting off, firing a shot at
// someone by name revealed nothing at all about the shooter. (2) the Knight
// permanently revealed an innocent duel target's specific role even when the
// duel FAILED (wrong guess) — a real information leak, since "the Knight
// challenged them and was wrong" should only prove they're not a werewolf,
// not out their exact role.
//
// Fix: firing the shot / dueling is itself an unmistakable public act, so the
// HUNTER (always) and the KNIGHT (always) reveal THEMSELVES independent of
// revealRoleOnDeath — same as the Werewolf King already did. But the
// target's own role is only revealed when that's actually earned: the
// Hunter's shot never exposes the victim's role beyond what
// revealRoleOnDeath already governs, and the Knight's target is only
// revealed when the duel actually catches a werewolf.
const { api, state, sleep, setupRoom, configureAndStart, pollUntil, findRoles, Tally } = require('./lib');

const t = new Tally();

function roleOf(view, playerId) {
  const p = view.players.find((p) => p.id === playerId);
  return p ? p.role : undefined;
}

// ---------------------------------------------------------------------------
// Scenario A: Hunter fires their shot with revealRoleOnDeath OFF — the
// Hunter's own role must still show up in the roster (their identity is
// revealed by the act of shooting, not by that setting), while the person
// they shot stays hidden exactly as the (disabled) setting says they should.
// ---------------------------------------------------------------------------
async function scenarioA() {
  const allNames = ['Leader', 'Bo', 'Cy', 'Dee', 'Eli', 'Fi'];
  const { roomCode, players } = await setupRoom('Leader', allNames.slice(1));
  const leader = players.Leader;
  await configureAndStart(roomCode, players, 'Leader', { Werewolf: 1, Hunter: 1, Villager: 4 }, { nightAction: 5 });
  await api('player/setRevealRoleOnDeath', { roomCode, playerId: leader.playerId, token: leader.token, value: false });

  const found = await findRoles(roomCode, players, allNames, ['Werewolf', 'Hunter']);
  t.ok(!!found.Werewolf && !!found.Hunter, '[A setup] identified Werewolf and Hunter', found);
  const wolf = players[found.Werewolf];
  const hunter = players[found.Hunter];
  const villagerNames = allNames.filter((n) => n !== found.Werewolf && n !== found.Hunter);

  const wolfView = await state(roomCode, wolf.playerId, wolf.token);
  await api('player/wolfVote', { roomCode, playerId: wolf.playerId, token: wolf.token, targetId: wolfView.wolfPhase.candidates.find((c) => c.name === found.Hunter).id });

  // Day-1 ordering: campaign runs first, hunter shot is deferred until after.
  let v = await pollUntil(roomCode, leader, (v) => v.phase === 'campaign', { timeoutMs: 8000 });
  t.ok(v.phase === 'campaign', '[A] campaign reached after night 1', v.phase);
  v = await pollUntil(roomCode, hunter, (v) => v.hunterShot && v.hunterShot.active, { timeoutMs: 8000 });
  t.ok(v.hunterShot && v.hunterShot.active, '[A] hunter shot prompt active (after the campaign concluded)', v.hunterShot);

  t.ok(roleOf(v, wolf.playerId) === undefined, '[A] before firing, the Werewolf\'s role is NOT visible (revealRoleOnDeath is off)', roleOf(v, wolf.playerId));
  t.ok(roleOf(v, hunter.playerId) === undefined, '[A] before firing, even the Hunter\'s OWN role isn\'t shown to others yet', roleOf(v, hunter.playerId));

  const targetName = villagerNames[0];
  const shotRes = await api('player/hunterShoot', { roomCode, playerId: hunter.playerId, token: hunter.token, targetId: players[targetName].playerId });
  t.ok(shotRes.ok, '[A] hunter fired their shot', shotRes);

  const afterView = await state(roomCode, leader.playerId, leader.token);
  t.ok(roleOf(afterView, hunter.playerId) === 'Hunter', '[A] the Hunter\'s OWN role is now visible to everyone, even with revealRoleOnDeath off', roleOf(afterView, hunter.playerId));
  t.ok(roleOf(afterView, players[targetName].playerId) === undefined, '[A] the player they shot is still NOT revealed — revealRoleOnDeath (off) still governs the victim', roleOf(afterView, players[targetName].playerId));

  console.log('--- scenario A done ---');
}

// ---------------------------------------------------------------------------
// Scenario B: Knight wins a duel against the actual Werewolf — the wolf's
// role should be revealed (the duel earned it).
// ---------------------------------------------------------------------------
async function scenarioB() {
  const allNames = ['Gia', 'Hal', 'Ivy', 'Jax', 'Kya'];
  const { roomCode, players } = await setupRoom(allNames[0], allNames.slice(1));
  const leader = players[allNames[0]];
  await configureAndStart(roomCode, players, allNames[0], { Werewolf: 1, Knight: 1, Villager: 3 });
  await api('player/setRevealRoleOnDeath', { roomCode, playerId: leader.playerId, token: leader.token, value: false });

  const found = await findRoles(roomCode, players, allNames, ['Werewolf', 'Knight']);
  t.ok(!!found.Werewolf && !!found.Knight, '[B setup] identified Werewolf and Knight', found);
  const knight = players[found.Knight];
  const wolfId = players[found.Werewolf].playerId;

  // Let night 1 time out (no kill) so no one is dead when discussion starts.
  let v = await pollUntil(roomCode, leader, (v) => v.phase === 'day_discussion', { timeoutMs: 15000 });
  t.ok(v.phase === 'day_discussion', '[B] reached day_discussion', v.phase);

  const duelRes = await api('player/knightDuel', { roomCode, playerId: knight.playerId, token: knight.token, targetId: wolfId });
  t.ok(duelRes.ok, '[B] Knight duels the actual Werewolf', duelRes);

  const afterView = await state(roomCode, leader.playerId, leader.token);
  t.ok(roleOf(afterView, knight.playerId) === 'Knight', '[B] the Knight\'s own role is revealed (even with revealRoleOnDeath off)', roleOf(afterView, knight.playerId));
  t.ok(roleOf(afterView, wolfId) === 'Werewolf', '[B] the defeated Werewolf\'s role IS revealed — the duel earned it', roleOf(afterView, wolfId));

  console.log('--- scenario B done ---');
}

// ---------------------------------------------------------------------------
// Scenario C: Knight LOSES a duel against an innocent villager — the
// villager's specific role must stay hidden (only "innocent" was proven),
// even though the Knight (who dies of shame) still reveals themselves.
// ---------------------------------------------------------------------------
async function scenarioC() {
  const allNames = ['Lou', 'Mia', 'Ned', 'Ola', 'Pia'];
  const { roomCode, players } = await setupRoom(allNames[0], allNames.slice(1));
  const leader = players[allNames[0]];
  await configureAndStart(roomCode, players, allNames[0], { Werewolf: 1, Knight: 1, Villager: 3 });
  await api('player/setRevealRoleOnDeath', { roomCode, playerId: leader.playerId, token: leader.token, value: false });

  const found = await findRoles(roomCode, players, allNames, ['Werewolf', 'Knight']);
  const knight = players[found.Knight];
  const innocentName = allNames.find((n) => n !== found.Werewolf && n !== found.Knight);
  const innocentId = players[innocentName].playerId;

  let v = await pollUntil(roomCode, leader, (v) => v.phase === 'day_discussion', { timeoutMs: 15000 });
  t.ok(v.phase === 'day_discussion', '[C] reached day_discussion', v.phase);

  const duelRes = await api('player/knightDuel', { roomCode, playerId: knight.playerId, token: knight.token, targetId: innocentId });
  t.ok(duelRes.ok, '[C] Knight duels an innocent villager (guesses wrong)', duelRes);

  const afterView = await state(roomCode, leader.playerId, leader.token);
  t.ok(roleOf(afterView, knight.playerId) === 'Knight', '[C] the Knight still reveals themselves, even having lost (and died)', roleOf(afterView, knight.playerId));
  t.ok(roleOf(afterView, innocentId) === undefined, '[C] the wrongly-accused player\'s specific role stays hidden — only "innocent" was proven', roleOf(afterView, innocentId));

  console.log('--- scenario C done ---');
}

(async () => {
  await scenarioA();
  await scenarioB();
  await scenarioC();
  t.finish();
})().catch((e) => { console.error(e); process.exit(1); });
