// Hidden Wolf role: dormancy while other wolves live, mutual concealment,
// Seer deception, solo activation once the last regular wolf dies (both from
// game start and mid-game), and the maxCount:1 cap.
const { api, state, sleep, pollUntil, setupRoom, configureAndStart, findRoles, Tally, FAST_TIMERS } = require('./lib');

const t = new Tally();

(async () => {
  // --- role config caps Hidden Wolf at 1 ---
  {
    const leaderJoin = await api('player/createRoom', { name: 'Leader' });
    const roomCode = leaderJoin.roomCode;
    const auth = { roomCode, playerId: leaderJoin.playerId, token: leaderJoin.token };
    await api('player/setRoleConfig', { ...auth, roleConfig: { Werewolf: 1, HiddenWolf: 5, Villager: 2 } });
    const v = await state(roomCode, auth.playerId, auth.token);
    t.ok(v.lobby.roleConfig.HiddenWolf === 1, '[cap] HiddenWolf clamped to 1', v.lobby.roleConfig);
    t.ok(v.lobby.roleMeta.HiddenWolf.maxCount === 1, '[cap] roleMeta exposes maxCount=1 for HiddenWolf');
  }

  // --- Main scenario: 1 Werewolf + 1 Hidden Wolf + 6 Villagers (8 players, so
  // a single night-1 kill doesn't trip the wolf-win condition) ---
  const allNames = ['Leader', 'Bo', 'Cy', 'Dee', 'Eli', 'Fi', 'Gia', 'Han'];
  const { roomCode, players } = await setupRoom('Leader', allNames.slice(1));
  const leader = players.Leader;
  const startRes = await configureAndStart(roomCode, players, 'Leader', { Werewolf: 1, HiddenWolf: 1, Villager: 6 });
  t.ok(startRes.ok, '[hw] 1 Werewolf + 1 HiddenWolf + 6 Villager game started', startRes);

  const found = await findRoles(roomCode, players, allNames, ['Werewolf', 'HiddenWolf']);
  t.ok(!!found.Werewolf && !!found.HiddenWolf, '[hw] identified Werewolf and HiddenWolf', found);
  const wolf = players[found.Werewolf];
  const hidden = players[found.HiddenWolf];

  // --- dormant Hidden Wolf gets no wolfPhase, can't vote ---
  {
    let sawWolfPhase = false;
    for (let i = 0; i < 5; i++) {
      const v = await state(roomCode, hidden.playerId, hidden.token);
      if (v.phase !== 'night') break;
      if (v.wolfPhase) { sawWolfPhase = true; break; }
      await sleep(150);
    }
    t.ok(!sawWolfPhase, '[hw] dormant Hidden Wolf gets no wolfPhase view at all');

    const wolfV = await state(roomCode, wolf.playerId, wolf.token);
    t.ok(wolfV.wolfPhase && wolfV.wolfPhase.totalWolves === 1, '[hw] active Werewolf sees totalWolves=1 (Hidden Wolf excluded)', wolfV.wolfPhase);
    t.ok(wolfV.wolfPhase && !wolfV.wolfPhase.wolfPack.some((w) => w.id === hidden.playerId), '[hw] Hidden Wolf not listed in the active wolf\'s pack');

    const voteRes = await api('player/wolfVote', { roomCode, playerId: hidden.playerId, token: hidden.token, targetId: players.Bo.playerId });
    t.ok(voteRes.ok === false, '[hw] dormant Hidden Wolf cannot cast a wolf-kill vote', voteRes);
  }

  // --- mutual teammate invisibility ---
  {
    const wolfV = await state(roomCode, wolf.playerId, wolf.token);
    const hiddenRowForWolf = wolfV.players.find((p) => p.id === hidden.playerId);
    t.ok(hiddenRowForWolf && hiddenRowForWolf.isWolfTeammate !== true, '[hw] regular wolf does NOT see Hidden Wolf marked as teammate');

    const hiddenV = await state(roomCode, hidden.playerId, hidden.token);
    const wolfRowForHidden = hiddenV.players.find((p) => p.id === wolf.playerId);
    t.ok(wolfRowForHidden && wolfRowForHidden.isWolfTeammate !== true, '[hw] Hidden Wolf does NOT see the regular wolf marked as teammate');
  }

  // Active wolf votes to kill a villager, resolving night 1.
  await api('player/wolfVote', { roomCode, playerId: wolf.playerId, token: wolf.token, targetId: players.Bo.playerId });

  const dayView = await pollUntil(roomCode, leader, (v) => ['day_discussion', 'day_vote', 'day_vote_countdown'].includes(v.phase), { timeoutMs: 15000, intervalMs: 250 });
  t.ok(dayView && ['day_discussion', 'day_vote', 'day_vote_countdown'].includes(dayView.phase), '[hw] reached the day after night 1', dayView && dayView.phase);

  // --- Seer sees the Hidden Wolf as Village-aligned (separate focused room) ---
  {
    const { roomCode: rc2, players: p2 } = await setupRoom('L2', ['B2', 'C2']);
    const leader2 = p2.L2;
    const sg2 = await configureAndStart(rc2, p2, 'L2', { HiddenWolf: 1, Seer: 1, Villager: 1 });
    t.ok(sg2.ok, '[hw-seer] 1 HiddenWolf (solo, active from night 1) + 1 Seer + 1 Villager started', sg2);

    const found2 = await findRoles(rc2, p2, ['L2', 'B2', 'C2'], ['Seer', 'HiddenWolf']);
    t.ok(!!found2.Seer && !!found2.HiddenWolf, '[hw-seer] identified Seer and solo HiddenWolf', found2);
    const seer = p2[found2.Seer];
    const hidden2 = p2[found2.HiddenWolf];

    const soloView = await pollUntil(rc2, hidden2, (v) => !!v.wolfPhase, { timeoutMs: 4000, intervalMs: 150 });
    t.ok(soloView && !!soloView.wolfPhase, '[hw-seer] a solo Hidden Wolf (no other wolves) is active immediately, not dormant');

    let seerResult = null;
    for (let deadline = Date.now() + 8000; Date.now() < deadline; ) {
      const v = await state(rc2, seer.playerId, seer.token);
      if (v.seerPhase && v.seerPhase.active && !v.seerPhase.acted) {
        const r = await api('player/seerView', { roomCode: rc2, playerId: seer.playerId, token: seer.token, targetId: hidden2.playerId });
        if (r.ok) { seerResult = r.result; break; }
      }
      await sleep(200);
    }
    t.ok(!!seerResult, '[hw-seer] Seer got a result checking the Hidden Wolf', seerResult);
    t.ok(seerResult && seerResult.team === 'village', '[hw-seer] Seer sees the Hidden Wolf as Village-aligned', seerResult);
  }

  // --- Mid-game activation: once the last regular wolf dies, the Hidden Wolf
  // takes over solo starting the very next night (separate room) ---
  {
    const names3 = ['Leader3', 'Bo3', 'Cy3', 'Dee3', 'Eli3', 'Fi3', 'Gia3'];
    const { roomCode: rc3, players: p3 } = await setupRoom(names3[0], names3.slice(1));
    const leader3 = p3[names3[0]];
    const sg3 = await configureAndStart(rc3, p3, names3[0], { Werewolf: 1, HiddenWolf: 1, Villager: 5 });
    t.ok(sg3.ok, '[activation] 1 Werewolf + 1 HiddenWolf + 5 Villager game started', sg3);

    const found3 = await findRoles(rc3, p3, names3, ['Werewolf', 'HiddenWolf']);
    t.ok(!!found3.Werewolf && !!found3.HiddenWolf, '[activation] identified Werewolf and HiddenWolf', found3);
    const wolf3 = p3[found3.Werewolf];
    const hidden3 = p3[found3.HiddenWolf];
    const villagerNames3 = names3.filter((n) => n !== found3.Werewolf && n !== found3.HiddenWolf);

    await api('player/wolfVote', { roomCode: rc3, playerId: wolf3.playerId, token: wolf3.token, targetId: p3[villagerNames3[0]].playerId });

    const voteView = await pollUntil(rc3, leader3, (v) => v.phase === 'day_vote', { timeoutMs: 15000, intervalMs: 250 });
    t.ok(voteView && voteView.phase === 'day_vote', '[activation] reached day_vote after night 1', voteView && voteView.phase);

    const aliveNamesNow = names3.filter((n) => n !== villagerNames3[0]);
    for (const n of aliveNamesNow) {
      await api('player/dayVote', { roomCode: rc3, playerId: p3[n].playerId, token: p3[n].token, targetId: wolf3.playerId });
    }

    const activationView = await pollUntil(rc3, hidden3, (v) => (v.phase === 'night' && !!v.wolfPhase) || v.phase === 'game_over', { timeoutMs: 10000, intervalMs: 200 });
    t.ok(activationView && activationView.phase === 'night' && !!activationView.wolfPhase, '[activation] Hidden Wolf activates solo on the night after the last regular wolf dies', activationView && activationView.phase);

    if (activationView && activationView.wolfPhase) {
      t.ok(activationView.wolfPhase.totalWolves === 1, '[activation] wolfPhase.totalWolves === 1 for the now-solo Hidden Wolf', activationView.wolfPhase);
      const remaining = villagerNames3.slice(1);
      const voteRes = await api('player/wolfVote', { roomCode: rc3, playerId: hidden3.playerId, token: hidden3.token, targetId: p3[remaining[0]].playerId });
      t.ok(voteRes.ok === true, '[activation] the now-active Hidden Wolf can successfully cast a kill vote alone', voteRes);
    }
  }

  t.finish();
})().catch((e) => { console.error(e); process.exit(1); });
