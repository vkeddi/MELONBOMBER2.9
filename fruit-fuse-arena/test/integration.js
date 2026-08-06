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
    if (!health.ok || health.tickRate !== 45 || health.snapshotRate !== 30
      || health.startingRange !== 1 || health.powerupDropChance !== 0.28 || health.kickSlideTiles !== 4) {
      throw new Error('Health check or gameplay configuration failed');
    }

    await new Promise((resolve, reject) => {
      const alpha = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const beta = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      let alphaId = null;
      let betaId = null;
      let code = null;
      let started = false;
      let controlsSentAt = 0;
      let turnSent = false;
      let stopSent = false;
      let bombSeen = false;
      let bombExpired = false;
      let maxBetaX = 0;
      let maxBetaY = 0;
      let kickPrepared = false;
      let kickStartedAt = 0;
      let kickBombStartX = null;
      let kickBombMaxX = 0;
      let kickSawFractionalX = false;
      let finished = false;
      const timeout = setTimeout(() => reject(new Error('Multiplayer flow timed out')), 9000);
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
        if (packet.event === 'welcome') {
          alphaId = packet.data.id;
          send(alpha, 'createRoom', { name: 'Alpha' });
        }
        if (packet.event === 'lobby' && !code) code = packet.data.code;
        if (packet.event === 'lobby' && packet.data.players.length === 2 && !started) {
          started = true;
          send(alpha, 'startGame');
        }
        if (packet.event !== 'state') return;

        const snapshot = packet.data;
        if (snapshot.players.length !== 2 || snapshot.grid.length !== 195) {
          fail(new Error('Invalid authoritative state shape'));
          return;
        }
        const alphaPlayer = snapshot.players.find((player) => player.id === alphaId);
        const betaPlayer = snapshot.players.find((player) => player.id === betaId);
        if (!alphaPlayer || !betaPlayer) return;
        if (alphaPlayer.range !== 1 || betaPlayer.range !== 1) {
          fail(new Error('Players did not start with blast radius 1'));
          return;
        }

        if (!controlsSentAt) {
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
        bombSeen ||= snapshot.bombs.length > 0;
        if (bombSeen && snapshot.bombs.length === 0) bombExpired = true;
        maxBetaX = Math.max(maxBetaX, betaPlayer.x);
        maxBetaY = Math.max(maxBetaY, betaPlayer.y);

        // Beta begins at the bottom-right spawn. Its circle must never enter the
        // permanent border walls at x=14 or y=12.
        if (betaPlayer.x > 13.715 || betaPlayer.y > 11.715) {
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

        if (kickPrepared) {
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
            finish();
          }
        }
      };

      beta.onmessage = ({ data }) => {
        const packet = JSON.parse(data);
        if (packet.event !== 'welcome') return;
        betaId = packet.data.id;
        const joinWhenReady = () => {
          if (code) send(beta, 'joinRoom', { code, name: 'Beta' });
          else setTimeout(joinWhenReady, 20);
        };
        joinWhenReady();
      };
      alpha.onerror = fail;
      beta.onerror = fail;
    });

    console.log('Integration test passed: multiplayer sync, radius 1, spawn escape, border collision, and smooth multi-tile kicking.');
  } finally {
    child.kill('SIGTERM');
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
