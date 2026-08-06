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
    const timeout = setTimeout(() => reject(new Error('Server start timed out')), 4000);
    child.stdout.on('data', (data) => {
      if (String(data).includes('listening')) {
        clearTimeout(timeout);
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
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      let playerId = null;
      let botId = null;
      let addedBot = false;
      let started = false;
      let initialBotPosition = null;
      let botMoved = false;
      let botScenarioPrepared = false;
      let botBombSeen = false;
      let escapeStarted = false;
      let wrongWayFrames = 0;
      let overtimePrepared = false;
      let finished = false;
      const timeout = setTimeout(() => reject(new Error('Bot/overtime flow timed out')), 9000);
      const send = (event, data = {}) => socket.send(JSON.stringify({ event, data }));
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        socket.close();
        resolve();
      };
      const fail = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        socket.close();
        reject(error);
      };

      socket.onmessage = ({ data }) => {
        const packet = JSON.parse(data);
        if (packet.event === 'latencyPing') {
          send('latencyPong', { nonce: packet.data.nonce });
          return;
        }
        if (packet.event === 'welcome') {
          playerId = packet.data.id;
          send('createRoom', { name: 'BotTester' });
          return;
        }
        if (packet.event === 'lobby') {
          const bots = packet.data.players.filter((player) => player.isBot);
          if (packet.data.players.length === 1 && !addedBot) {
            addedBot = true;
            send('addBot');
            return;
          }
          if (packet.data.players.length === 2 && bots.length === 1 && !started) {
            botId = bots[0].id;
            if (bots[0].latencyMs !== null) return fail(new Error('Bot should not report network latency'));
            started = true;
            send('startGame');
          }
          return;
        }
        if (packet.event !== 'state') return;
        const human = packet.data.players.find((player) => player.id === playerId);
        const bot = packet.data.players.find((player) => player.id === botId);
        if (!human || !bot) return;
        if (!bot.isBot || !Number.isFinite(bot.facingX) || !Number.isFinite(bot.facingY)) {
          fail(new Error('Bot or directional facing data was missing from the state snapshot'));
          return;
        }
        if (!botScenarioPrepared) {
          botScenarioPrepared = true;
          send('action', { type: 'testPrepareBotBomb' });
          return;
        }

        if (!initialBotPosition || Math.abs(initialBotPosition.x - 5.5) > 0.2) {
          initialBotPosition = { x: bot.x, y: bot.y };
        }
        if (packet.data.bombs.some((bomb) => bomb.ownerId === botId)) botBombSeen = true;
        if (botBombSeen && bot.moveX < -0.2) escapeStarted = true;
        if (escapeStarted && bot.moveX > 0.2) wrongWayFrames += 1;
        if (Math.hypot(bot.x - initialBotPosition.x, bot.y - initialBotPosition.y) > 0.55) botMoved = true;

        if (botBombSeen && botMoved && !overtimePrepared) {
          if (wrongWayFrames > 2) {
            fail(new Error('Bot oscillated back toward its bomb instead of committing to the escape path'));
            return;
          }
          overtimePrepared = true;
          send('action', { type: 'testPrepareOvertimeTouch' });
          setTimeout(() => send('input', { up: false, down: false, left: false, right: true }), 100);
          return;
        }
        if (overtimePrepared && !human.alive) {
          const death = packet.data.events.find((event) => event.type === 'death'
            && event.playerId === playerId && event.cause === 'overtime');
          if (!death) {
            fail(new Error('Touching an overtime wall did not emit an overtime death event'));
            return;
          }
          finish();
        }
      };
      socket.onerror = fail;
    });
    console.log('Bot/overtime test passed: bot placed a bomb, committed to a stable escape path, and overtime contact was lethal.');
  } finally {
    child.kill('SIGTERM');
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
