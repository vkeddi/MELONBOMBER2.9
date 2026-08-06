'use strict';

const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server start timed out')), 4000);
    child.stdout.on('data', (data) => {
      if (String(data).includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (data) => process.stderr.write(data));
    child.on('exit', (code) => reject(new Error(`Server exited early with code ${code}`)));
  });
}

async function run() {
  const port = await getFreePort();
  const root = path.resolve(__dirname, '..');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(child);
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
    if (!health.ok || health.version !== '2.0.4' || health.tickRate !== 45 || health.snapshotRate !== 30
      || health.startingRange !== 1 || health.powerupDropChance !== 0.31 || health.kickSlideTiles !== 4
      || health.cornerAssist !== 0.26 || health.roundTimerMs !== 65000
      || health.mapVoteMs !== 7000 || health.mapCount !== 3) {
      throw new Error('Health check or gameplay configuration failed');
    }
    const [clientSource, htmlSource, versionSource] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/client.js`).then((response) => response.text()),
      fetch(`http://127.0.0.1:${port}/`).then((response) => response.text()),
      fetch(`http://127.0.0.1:${port}/version.js`).then((response) => response.text()),
    ]);
    if (!htmlSource.includes('versionNumber') || !htmlSource.includes('/version.js')
      || !versionSource.includes('2.0.4') || !clientSource.includes('FRUIT_FUSE_VERSION')
      || !clientSource.includes('playExplosionSound') || !clientSource.includes('playRoundEndSound')
      || !clientSource.includes('startWinnerConfetti') || !htmlSource.includes('confettiCanvas')
      || !clientSource.includes('activateCompatibilityRenderer') || !htmlSource.includes('fallbackCanvas')
      || !clientSource.includes("requestedRenderer !== 'stable'")) {
      throw new Error('Audio or winner-confetti client features were not packaged');
    }

    await new Promise((resolve, reject) => {
      const alpha = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const beta = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      let alphaId = null;
      let betaId = null;
      let code = null;
      let started = false;
      let alphaInitialVoteSent = false;
      let betaInitialVoteSent = false;
      let mapPreviewChecked = false;
      let rangeUpgradeRequested = false;
      let rangeUpgradeConfirmed = false;
      let rangeUpgradeConfirmedAt = 0;
      let waitingForSecondRound = false;
      let alphaSecondVoteSent = false;
      let betaSecondVoteSent = false;
      let controlsSentAt = 0;
      let turnSent = false;
      let stopSent = false;
      let bombSeen = false;
      let bombSpawnMetadataChecked = false;
      let bombExpired = false;
      let explosionEventSeen = false;
      let roundOverChecked = false;
      let maxBetaX = 0;
      let maxBetaY = 0;
      let kickPrepared = false;
      let kickStartedAt = 0;
      let kickBombStartX = null;
      let kickBombMaxX = 0;
      let kickSawFractionalX = false;
      let kickComplete = false;
      let cornerPrepared = false;
      let cornerStartedAt = 0;
      let cornerMaxX = 0;
      let cornerMinY = Infinity;
      let rapidTurnPrepared = false;
      let rapidTurnStartedAt = 0;
      let finished = false;
      const timeout = setTimeout(() => reject(new Error('Multiplayer flow timed out')), 16000);
      const send = (socket, event, data = {}) => socket.send(JSON.stringify({ event, data }));
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        alpha.close();
        beta.close();
        resolve();
      };
      const fail = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        alpha.close();
        beta.close();
        reject(error);
      };

      alpha.onmessage = ({ data }) => {
        const packet = JSON.parse(data);
        if (packet.event === 'latencyPing') {
          send(alpha, 'latencyPong', { nonce: packet.data.nonce });
          return;
        }
        if (packet.event === 'welcome') {
          alphaId = packet.data.id;
          send(alpha, 'createRoom', { name: 'Alpha' });
        }
        if (packet.event === 'lobby') {
          if (!code) code = packet.data.code;
          if (!mapPreviewChecked && Array.isArray(packet.data.maps) && packet.data.maps.length === 3) {
            const validPreviews = packet.data.maps.every((map) => map.preview?.cols === 15
              && map.preview?.rows === 13 && Array.isArray(map.preview?.walls)
              && map.preview.walls.length === 13 && Array.isArray(map.preview?.spawns));
            if (!validPreviews) {
              fail(new Error('Map vote previews did not contain the 15x13 wall layouts'));
              return;
            }
            mapPreviewChecked = true;
          }
          if (packet.data.phase === 'lobby' && packet.data.players.length === 2 && !alphaInitialVoteSent) {
            alphaInitialVoteSent = true;
            send(alpha, 'voteMap', { mapId: 'crossroads' });
          }
          if (packet.data.phase === 'lobby' && packet.data.players.length === 2
            && packet.data.players.every((player) => player.mapVote === 'crossroads') && !started) {
            started = true;
            send(alpha, 'startGame');
          }
          if (packet.data.phase === 'mapVote' && !alphaSecondVoteSent) {
            alphaSecondVoteSent = true;
            send(alpha, 'voteMap', { mapId: 'orchard' });
          }
        }
        if (packet.event === 'roundOver') {
          if (packet.data.winnerId !== alphaId || packet.data.winnerName !== 'Alpha') {
            fail(new Error('Round-end winner payload was incorrect'));
            return;
          }
          roundOverChecked = true;
          return;
        }
        if (packet.event !== 'state') return;

        const snapshot = packet.data;
        if (snapshot.players.length !== 2 || snapshot.grid.length !== 195
          || snapshot.cols !== 15 || snapshot.rows !== 13) {
          fail(new Error('Invalid restored authoritative state shape'));
          return;
        }
        if (snapshot.suddenDeathIn > 65050 || snapshot.suddenDeathIn < 0) {
          fail(new Error(`Round timer was not reduced to 65 seconds (${snapshot.suddenDeathIn})`));
          return;
        }
        const alphaPlayer = snapshot.players.find((player) => player.id === alphaId);
        const betaPlayer = snapshot.players.find((player) => player.id === betaId);
        if (!alphaPlayer || !betaPlayer) return;
        if (waitingForSecondRound) {
          if (snapshot.round >= 2) {
            if (snapshot.mapId !== 'orchard') {
              fail(new Error(`Between-round map vote selected ${snapshot.mapId} instead of orchard`));
              return;
            }
            if (!Number.isFinite(alphaPlayer.latencyMs) || !Number.isFinite(betaPlayer.latencyMs)) {
              fail(new Error('Per-player latency values were not measured'));
              return;
            }
            if (!mapPreviewChecked || !explosionEventSeen || !roundOverChecked) {
              fail(new Error('Map previews, explosion events, or round-end winner event were not observed'));
              return;
            }
            finish();
          }
          return;
        }

        if (!rangeUpgradeRequested) {
          if (snapshot.mapId !== 'crossroads') {
            fail(new Error(`Initial map vote selected ${snapshot.mapId} instead of crossroads`));
            return;
          }
          if (alphaPlayer.range !== 1 || betaPlayer.range !== 1) {
            fail(new Error('Players did not start with blast radius 1'));
            return;
          }
          rangeUpgradeRequested = true;
          send(alpha, 'action', { type: 'testGiveRangePowerup' });
          return;
        }

        if (!rangeUpgradeConfirmed) {
          if (alphaPlayer.range === 2 && betaPlayer.range === 1) {
            rangeUpgradeConfirmed = true;
            rangeUpgradeConfirmedAt = Date.now();
            return;
          } else if (alphaPlayer.range !== 1 || betaPlayer.range !== 1) {
            fail(new Error(`Range pickup was not +1 for only the collector (${alphaPlayer.range}, ${betaPlayer.range})`));
            return;
          } else {
            return;
          }
        }

        if (!controlsSentAt) {
          if (Date.now() - rangeUpgradeConfirmedAt < 130) return;
          // The upper-left spawn must have at least one guaranteed L-shaped
          // route out of a two-tile blast: right-right-down or down-down-right.
          const cell = (x, y) => snapshot.grid[y * snapshot.cols + x];
          const rightRouteOpen = cell(2, 1) === 0 && cell(3, 1) === 0 && cell(3, 2) === 0;
          const downRouteOpen = cell(1, 2) === 0 && cell(1, 3) === 0 && cell(2, 3) === 0;
          if (!rightRouteOpen || !downRouteOpen) {
            fail(new Error('Spawn escape lanes were not carved correctly'));
            return;
          }

          controlsSentAt = Date.now();
          send(alpha, 'action', { type: 'bomb' });
          send(alpha, 'input', { up: false, down: false, left: false, right: true });
          send(beta, 'input', { up: false, down: true, left: false, right: true });
          return;
        }

        const elapsed = Date.now() - controlsSentAt;
        if (!bombSpawnMetadataChecked && snapshot.bombs.length > 0) {
          const placedBomb = snapshot.bombs[0];
          if (!Number.isFinite(placedBomb.spawnX) || !Number.isFinite(placedBomb.spawnY)
            || !Number.isFinite(placedBomb.placedAt)) {
            fail(new Error('Bomb placement anchor metadata was missing'));
            return;
          }
          if (Math.hypot(placedBomb.spawnX - 1.5, placedBomb.spawnY - 1.5) > 0.12) {
            fail(new Error(`Bomb did not originate beneath the placing player (${placedBomb.spawnX}, ${placedBomb.spawnY})`));
            return;
          }
          bombSpawnMetadataChecked = true;
        }
        bombSeen ||= snapshot.bombs.length > 0;
        explosionEventSeen ||= (snapshot.events || []).some((event) => event.type === 'explosion'
          && Number.isFinite(event.x) && Number.isFinite(event.y) && event.bombId);
        if (bombSeen && snapshot.bombs.length === 0) bombExpired = true;
        maxBetaX = Math.max(maxBetaX, betaPlayer.x);
        maxBetaY = Math.max(maxBetaY, betaPlayer.y);

        // Beta begins at the bottom-right spawn. Its circle must never enter the
        // permanent border walls at x=14 or y=12.
        if (betaPlayer.x > 13.725 || betaPlayer.y > 11.725) {
          fail(new Error(`Wall collision failed at ${betaPlayer.x.toFixed(3)}, ${betaPlayer.y.toFixed(3)}`));
          return;
        }

        // Run two tiles right, then turn down into the guaranteed escape lane.
        if (elapsed >= 520 && !turnSent) {
          turnSent = true;
          send(alpha, 'input', { up: false, down: true, left: false, right: false });
        }
        if (elapsed >= 980 && !stopSent) {
          stopSent = true;
          send(alpha, 'input', { up: false, down: false, left: false, right: false });
          send(beta, 'input', { up: false, down: false, left: false, right: false });
        }

        // The fuse is 2.2 seconds. Alpha should still be alive after detonation
        // because the generated spawn now guarantees an actual escape route.
        if (elapsed >= 2850 && !kickPrepared) {
          if (!bombSeen || !bombExpired) {
            fail(new Error('Bomb did not complete its normal fuse cycle'));
            return;
          }
          if (!alphaPlayer.alive) {
            fail(new Error(`Player was eliminated despite using the spawn escape lane at ${alphaPlayer.x.toFixed(3)}, ${alphaPlayer.y.toFixed(3)}`));
            return;
          }
          kickPrepared = true;
          kickStartedAt = Date.now();
          send(alpha, 'action', { type: 'testPrepareKick' });
          setTimeout(() => send(alpha, 'input', { up: false, down: false, left: false, right: true }), 80);
          return;
        }

        if (rapidTurnPrepared) {
          if (Date.now() - rapidTurnStartedAt >= 450) {
            send(alpha, 'input', { up: false, down: false, left: false, right: false });
            if (alphaPlayer.y < 6.25 || Math.abs(alphaPlayer.x - 5.5) > 0.2) {
              fail(new Error(`Rapid input replacement failed at ${alphaPlayer.x.toFixed(3)}, ${alphaPlayer.y.toFixed(3)}`));
              return;
            }
            waitingForSecondRound = true;
            send(alpha, 'action', { type: 'testFinishRound' });
          }
          return;
        }

        if (cornerPrepared) {
          cornerMaxX = Math.max(cornerMaxX, alphaPlayer.x);
          cornerMinY = Math.min(cornerMinY, alphaPlayer.y);
          if (Date.now() - cornerStartedAt >= 900) {
            send(alpha, 'input', { up: false, down: false, left: false, right: false });
            if (cornerMaxX < 2.65) {
              fail(new Error(`Corner assist did not carry the player around the wall tip (max x ${cornerMaxX.toFixed(3)})`));
              return;
            }
            if (cornerMinY > 1.73) {
              fail(new Error(`Corner assist did not steer toward the corridor center (min y ${cornerMinY.toFixed(3)})`));
              return;
            }
            cornerPrepared = false;
            rapidTurnPrepared = true;
            rapidTurnStartedAt = Date.now();
            send(alpha, 'action', { type: 'testPrepareRapidTurn' });
            setTimeout(() => {
              send(alpha, 'input', { up: false, down: false, left: false, right: true });
              send(alpha, 'input', { up: false, down: true, left: false, right: false });
            }, 90);
          }
          return;
        }

        if (kickPrepared && !kickComplete) {
          const kickBomb = snapshot.bombs[0];
          if (kickBomb) {
            if (kickBombStartX === null) kickBombStartX = kickBomb.x;
            kickBombMaxX = Math.max(kickBombMaxX, kickBomb.x);
            if (Math.abs(kickBomb.x - Math.round(kickBomb.x)) > 0.04
              && Math.abs((kickBomb.x - 0.5) - Math.round(kickBomb.x - 0.5)) > 0.04) {
              kickSawFractionalX = true;
            }
          }
          if (Date.now() - kickStartedAt >= 1300) {
            send(alpha, 'input', { up: false, down: false, left: false, right: false });
            if (kickBombStartX === null || kickBombMaxX - kickBombStartX < 2.5) {
              fail(new Error(`Kicked bomb did not travel multiple tiles (${kickBombStartX} to ${kickBombMaxX})`));
              return;
            }
            if (!kickSawFractionalX) {
              fail(new Error('Kicked bomb did not expose smooth intermediate positions'));
              return;
            }
            kickComplete = true;
            cornerPrepared = true;
            cornerStartedAt = Date.now();
            send(alpha, 'action', { type: 'testPrepareCorner' });
            setTimeout(() => send(alpha, 'input', { up: false, down: false, left: false, right: true }), 90);
          }
        }
      };

      beta.onmessage = ({ data }) => {
        const packet = JSON.parse(data);
        if (packet.event === 'latencyPing') {
          send(beta, 'latencyPong', { nonce: packet.data.nonce });
          return;
        }
        if (packet.event === 'welcome') {
          betaId = packet.data.id;
          const joinWhenReady = () => {
            if (code) send(beta, 'joinRoom', { code, name: 'Beta' });
            else setTimeout(joinWhenReady, 20);
          };
          joinWhenReady();
          return;
        }
        if (packet.event === 'lobby' && packet.data.phase === 'lobby'
          && packet.data.players.length === 2 && !betaInitialVoteSent) {
          betaInitialVoteSent = true;
          send(beta, 'voteMap', { mapId: 'crossroads' });
        }
        if (packet.event === 'lobby' && packet.data.phase === 'mapVote' && !betaSecondVoteSent) {
          betaSecondVoteSent = true;
          send(beta, 'voteMap', { mapId: 'orchard' });
        }
      };
      alpha.onerror = fail;
      beta.onerror = fail;
    });

    console.log('Integration test passed: restored 15x13 voted maps with previews, personal +1 blast pickups, explosion events, round-end winner payload, 65-second rounds, latency, centered bombs, multiplayer sync, escape lanes, collisions, kicking, corner assistance, and rapid turns.');
  } finally {
    child.kill('SIGTERM');
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
