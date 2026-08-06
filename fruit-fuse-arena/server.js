'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { version: GAME_VERSION } = require('./package.json');

const PORT = Number(process.env.PORT || 3000);
const TICK_RATE = 45;
const SNAPSHOT_RATE = 30;
const COLS = 15;
const ROWS = 13;
const MAX_PLAYERS = 8;
const BOMB_FUSE_MS = 2200;
const FLAME_MS = 520;
const ROUND_RESET_MS = 1800;
const MAP_VOTE_MS = 7000;
const TRAINING_RESET_MS = 1200;
const SPAWN_CLEAR_RADIUS = 3;
const SUDDEN_DEATH_MS = 65000;
const PLAYER_RADIUS = 0.28;
const BOMB_RADIUS = 0.31;
const KICK_SLIDE_TILES = 4;
const KICK_SLIDE_SPEED = 7.4;
const POWERUP_DROP_CHANCE = 0.34;
const TEST_MODE = process.env.NODE_ENV === 'test' || process.env.FFA_TEST_MODE === '1';
const MAX_BOMB_MOVE_SUBSTEP = 0.065;
const MAX_MOVE_SUBSTEP = 0.065;
const MAX_TICK_MOVEMENT = 0.32;
const CORNER_ASSIST_MAX = 0.26;
const CORNER_ASSIST_STEP = 0.055;
const COLORS = ['#ff5d73', '#55d6be', '#ffd166', '#7aa2ff', '#c77dff', '#ff9f1c', '#80ed99', '#f15bb5'];
const BOT_NAMES = ['Pip', 'Mango', 'Sprout', 'Kiwi', 'Peach', 'Berry', 'Lime', 'Plum'];
const BOT_THINK_MIN_MS = 360;
const BOT_THINK_MAX_MS = 560;
const BOT_BOMB_COOLDOWN_MS = 1350;
const BOT_PATH_CENTER_TOLERANCE = 0.12;
const BOT_LANE_TOLERANCE = 0.055;
const BOT_STUCK_MS = 900;
const BOT_MAX_ESCAPE_STEPS = 6;
const MAPS = [
  { id: 'classic', name: 'Classic Grove', description: 'Balanced checkerboard pillars and familiar lanes.' },
  { id: 'crossroads', name: 'Crossroads', description: 'A broad central cross creates faster encounters.' },
  { id: 'orchard', name: 'Open Orchard', description: 'Staggered stone rows leave longer movement lanes.' },
];

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const rooms = new Map();
const clients = new Map();

const server = http.createServer((req, res) => {
  if (req.url === '/version.js') {
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(`window.FRUIT_FUSE_VERSION = ${JSON.stringify(GAME_VERSION)};`);
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      ok: true,
      version: GAME_VERSION,
      rooms: rooms.size,
      players: clients.size,
      tickRate: TICK_RATE,
      snapshotRate: SNAPSHOT_RATE,
      startingRange: 1,
      powerupDropChance: POWERUP_DROP_CHANCE,
      kickSlideTiles: KICK_SLIDE_TILES,
      cornerAssist: CORNER_ASSIST_MAX,
      roundTimerMs: SUDDEN_DEATH_MS,
      mapVoteMs: MAP_VOTE_MS,
      mapCount: MAPS.length,
      bots: true,
      lethalOvertimeContact: true,
    }));
    return;
  }

  const rawPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const requested = rawPath === '/' ? '/index.html' : rawPath;
  const normalized = path.normalize(requested).replace(/^([.][.][/\\])+/, '');
  let filePath = path.join(PUBLIC_DIR, normalized);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) filePath = path.join(PUBLIC_DIR, 'index.html');
    fs.readFile(filePath, (readError, data) => {
      if (readError) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(data);
    });
  });
});


function sanitizeName(value) {
  const clean = String(value || '').replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 16);
  return clean || `Player${Math.floor(Math.random() * 900 + 100)}`;
}

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function getRoomForSocket(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}

function mapPreview(mapId) {
  const walls = [];
  for (let y = 0; y < ROWS; y += 1) {
    let row = '';
    for (let x = 0; x < COLS; x += 1) row += isPermanentWall(mapId, x, y) ? '1' : '0';
    walls.push(row);
  }
  return {
    cols: COLS,
    rows: ROWS,
    walls,
    spawns: spawnPoints(MAX_PLAYERS),
  };
}

function mapVoteSummary(room) {
  return MAPS.map((map) => ({
    ...map,
    preview: mapPreview(map.id),
    votes: [...room.mapVotes.values()].filter((mapId) => mapId === map.id).length,
    voters: [...room.mapVotes.entries()]
      .filter(([, mapId]) => mapId === map.id)
      .map(([playerId]) => playerId),
  }));
}

function publicLobby(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    mapVoteEndsAt: room.mapVoteEndsAt,
    selectedMapId: room.selectedMapId,
    currentMapId: room.game?.mapId || null,
    maps: mapVoteSummary(room),
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      score: p.score,
      connected: p.connected,
      latencyMs: p.latencyMs,
      isBot: Boolean(p.isBot),
      mapVote: room.mapVotes.get(p.id) || null,
    })),
  };
}

function broadcastLobby(room) {
  broadcastRoom(room, 'lobby', publicLobby(room));
}

function leaveCurrentRoom(socket) {
  const room = getRoomForSocket(socket);
  if (!room) return;

  room.players.delete(socket.id);
  room.inputs.delete(socket.id);
  room.mapVotes.delete(socket.id);

  if (room.game?.players[socket.id]) {
    room.game.players[socket.id].alive = false;
    delete room.game.players[socket.id];
  }

  if (room.hostId === socket.id) {
    room.hostId = [...room.players.values()].find((player) => !player.isBot)?.id || null;
  }

  socket.data.roomCode = null;

  if (![...room.players.values()].some((player) => !player.isBot)) {
    rooms.delete(room.code);
  } else {
    broadcastLobby(room);
  }
}

function createRoom(socket, rawName) {
  leaveCurrentRoom(socket);
  const code = makeCode();
  const player = {
    id: socket.id,
    name: sanitizeName(rawName),
    color: COLORS[0],
    score: 0,
    connected: true,
    latencyMs: null,
    isBot: false,
  };
  const room = {
    code,
    hostId: socket.id,
    phase: 'lobby',
    players: new Map([[socket.id, player]]),
    inputs: new Map(),
    game: null,
    mapVotes: new Map(),
    mapVoteEndsAt: null,
    selectedMapId: 'classic',
    lastSnapshotAt: 0,
  };
  rooms.set(code, room);
  socket.data.roomCode = code;
  broadcastLobby(room);
}

function joinRoom(socket, rawCode, rawName) {
  const code = String(rawCode || '').trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) return sendEvent(socket, 'notice', { type: 'error', message: 'Room not found.' });
  if (room.players.size >= MAX_PLAYERS) return sendEvent(socket, 'notice', { type: 'error', message: 'Room is full.' });
  if (room.phase !== 'lobby') return sendEvent(socket, 'notice', { type: 'error', message: 'A round is already in progress.' });

  leaveCurrentRoom(socket);
  const player = {
    id: socket.id,
    name: sanitizeName(rawName),
    color: COLORS[room.players.size % COLORS.length],
    score: 0,
    connected: true,
    latencyMs: null,
    isBot: false,
  };
  room.players.set(socket.id, player);
  socket.data.roomCode = code;
  broadcastLobby(room);
}

function addBot(room) {
  if (!room || room.phase !== 'lobby' || room.players.size >= MAX_PLAYERS) return null;
  const usedNames = new Set([...room.players.values()].map((player) => player.name));
  const baseName = BOT_NAMES.find((name) => !usedNames.has(name)) || `Bot ${room.players.size + 1}`;
  const id = `bot:${crypto.randomUUID()}`;
  const player = {
    id,
    name: baseName,
    color: COLORS[room.players.size % COLORS.length],
    score: 0,
    connected: true,
    latencyMs: null,
    isBot: true,
  };
  room.players.set(id, player);
  room.inputs.set(id, { up: false, down: false, left: false, right: false });
  room.mapVotes.set(id, MAPS[Math.floor(Math.random() * MAPS.length)].id);
  broadcastLobby(room);
  return player;
}

function removeBot(room, botId = null) {
  if (!room || room.phase !== 'lobby') return false;
  const bot = botId
    ? room.players.get(botId)
    : [...room.players.values()].reverse().find((player) => player.isBot);
  if (!bot?.isBot) return false;
  room.players.delete(bot.id);
  room.inputs.delete(bot.id);
  room.mapVotes.delete(bot.id);
  broadcastLobby(room);
  return true;
}

function idx(x, y) {
  return y * COLS + x;
}

function inBounds(x, y) {
  return x >= 0 && y >= 0 && x < COLS && y < ROWS;
}

function getCell(game, x, y) {
  if (!inBounds(x, y)) return 1;
  return game.grid[idx(x, y)];
}

function setCell(game, x, y, value) {
  if (inBounds(x, y)) game.grid[idx(x, y)] = value;
}

function spawnPoints(count) {
  const all = [
    [1, 1], [COLS - 2, ROWS - 2], [COLS - 2, 1], [1, ROWS - 2],
    [Math.floor(COLS / 2), 1], [Math.floor(COLS / 2), ROWS - 2],
    [1, Math.floor(ROWS / 2)], [COLS - 2, Math.floor(ROWS / 2)],
  ];
  return all.slice(0, count);
}

function isPermanentWall(mapId, x, y) {
  if (x === 0 || y === 0 || x === COLS - 1 || y === ROWS - 1) return true;
  if (mapId === 'crossroads') {
    const centerX = Math.floor(COLS / 2);
    const centerY = Math.floor(ROWS / 2);
    if (Math.abs(x - centerX) <= 1 || Math.abs(y - centerY) <= 1) return false;
    return x % 2 === 0 && y % 2 === 0;
  }
  if (mapId === 'orchard') {
    return y % 3 === 0 && x % 2 === 0;
  }
  return x % 2 === 0 && y % 2 === 0;
}

function buildGrid(spawns, mapId) {
  const grid = new Array(COLS * ROWS).fill(0);
  const crateChance = mapId === 'crossroads' ? 0.68 : mapId === 'orchard' ? 0.66 : 0.72;
  for (let y = 0; y < ROWS; y += 1) {
    for (let x = 0; x < COLS; x += 1) {
      if (isPermanentWall(mapId, x, y)) {
        grid[idx(x, y)] = 1;
      } else if (Math.random() < crateChance) {
        grid[idx(x, y)] = 2;
      }
    }
  }

  for (const [sx, sy] of spawns) {
    // Each spawn gets two clear L-shaped exits even on the larger maps.
    for (let dy = -SPAWN_CLEAR_RADIUS; dy <= SPAWN_CLEAR_RADIUS; dy += 1) {
      for (let dx = -SPAWN_CLEAR_RADIUS; dx <= SPAWN_CLEAR_RADIUS; dx += 1) {
        if (Math.abs(dx) + Math.abs(dy) > SPAWN_CLEAR_RADIUS) continue;
        const x = sx + dx;
        const y = sy + dy;
        if (inBounds(x, y) && grid[idx(x, y)] !== 1) grid[idx(x, y)] = 0;
      }
    }
  }
  return grid;
}

function makeSuddenDeathQueue() {
  const queue = [];
  let left = 1;
  let right = COLS - 2;
  let top = 1;
  let bottom = ROWS - 2;
  while (left <= right && top <= bottom) {
    for (let x = left; x <= right; x += 1) queue.push([x, top]);
    for (let y = top + 1; y <= bottom; y += 1) queue.push([right, y]);
    if (bottom > top) for (let x = right - 1; x >= left; x -= 1) queue.push([x, bottom]);
    if (right > left) for (let y = bottom - 1; y > top; y -= 1) queue.push([left, y]);
    left += 2;
    right -= 2;
    top += 2;
    bottom -= 2;
  }
  return queue.filter(([x, y]) => !(x % 2 === 0 && y % 2 === 0));
}

function createGame(room, mapId = room.selectedMapId || 'classic') {
  const entries = [...room.players.values()];
  const spawns = spawnPoints(entries.length);
  const now = Date.now();
  const players = {};

  entries.forEach((p, i) => {
    const [x, y] = spawns[i];
    players[p.id] = {
      id: p.id,
      name: p.name,
      color: p.color,
      x: x + 0.5,
      y: y + 0.5,
      alive: true,
      isBot: Boolean(p.isBot),
      speed: 3.4,
      maxBombs: 1,
      range: 1,
      kick: false,
      remote: false,
      piercing: false,
      line: false,
      megaCharges: 0,
      bombsPlaced: 0,
      facingX: 0,
      facingY: 1,
      kickCooldownUntil: 0,
      moveX: 0,
      moveY: 0,
      kills: 0,
      botNextThinkAt: now + Math.random() * 300,
      botNextBombAt: now + 900 + Math.random() * 1300,
      botPath: [],
      botEscapeUntil: 0,
      botMode: 'seek',
      botWaitForOwnBomb: false,
      botLastTile: `${x},${y}`,
      botLastProgressX: x + 0.5,
      botLastProgressY: y + 0.5,
      botStuckSince: now,
    };
    room.inputs.set(p.id, { up: false, down: false, left: false, right: false });
  });

  return {
    phase: 'playing',
    round: (room.game?.round || 0) + 1,
    startedAt: now,
    suddenDeathAt: now + SUDDEN_DEATH_MS,
    nextDeathBlockAt: now + SUDDEN_DEATH_MS,
    roundEndsAt: null,
    winnerId: null,
    mapId,
    grid: buildGrid(spawns, mapId),
    players,
    bombs: {},
    flames: [],
    powerups: {},
    nextBombId: 1,
    suddenDeathQueue: makeSuddenDeathQueue(),
    events: [],
  };
}

function chooseVotedMap(room) {
  const counts = new Map(MAPS.map((map) => [map.id, 0]));
  for (const mapId of room.mapVotes.values()) {
    if (counts.has(mapId)) counts.set(mapId, counts.get(mapId) + 1);
  }
  const highest = Math.max(...counts.values());
  if (highest <= 0) return room.selectedMapId || MAPS[0].id;
  const finalists = MAPS.filter((map) => counts.get(map.id) === highest);
  return finalists[Math.floor(Math.random() * finalists.length)].id;
}

function startGame(room) {
  if (room.players.size < 1) return;
  room.selectedMapId = chooseVotedMap(room);
  room.phase = 'playing';
  room.mapVoteEndsAt = null;
  room.game = createGame(room, room.selectedMapId);
  room.mapVotes.clear();
  broadcastRoom(room, 'gameStarted', {
    round: room.game.round,
    mapId: room.game.mapId,
    mapName: MAPS.find((map) => map.id === room.game.mapId)?.name || 'Arena',
  });
  broadcastLobby(room);
}

function beginMapVote(room, now) {
  if (room.players.size === 0) return;
  room.phase = 'mapVote';
  room.mapVotes.clear();
  for (const player of room.players.values()) {
    if (player.isBot) room.mapVotes.set(player.id, MAPS[Math.floor(Math.random() * MAPS.length)].id);
  }
  room.mapVoteEndsAt = now + MAP_VOTE_MS;
  if (room.game) room.game.phase = 'mapVote';
  broadcastLobby(room);
  broadcastRoom(room, 'mapVoteStarted', { endsAt: room.mapVoteEndsAt, maps: mapVoteSummary(room) });
}

function circleRectOverlap(cx, cy, radius, rx, ry, rw = 1, rh = 1) {
  const nearestX = Math.max(rx, Math.min(cx, rx + rw));
  const nearestY = Math.max(ry, Math.min(cy, ry + rh));
  const dx = cx - nearestX;
  const dy = cy - nearestY;
  return dx * dx + dy * dy < radius * radius;
}

function bombAt(game, tx, ty, ignoreId = null) {
  return Object.values(game.bombs).find((b) => b.id !== ignoreId && b.tx === tx && b.ty === ty && !b.exploded);
}

function bombOverlapsPlayer(bomb, x, y) {
  const minDistance = PLAYER_RADIUS + BOMB_RADIUS;
  const dx = x - bomb.x;
  const dy = y - bomb.y;
  return dx * dx + dy * dy < minDistance * minDistance;
}

function powerupKey(x, y) {
  return `${x},${y}`;
}

function isTileBlocked(game, tx, ty) {
  const cell = getCell(game, tx, ty);
  return cell === 1 || cell === 2 || cell === 3;
}

function canOccupy(game, x, y, playerId) {
  const minX = Math.floor(x - PLAYER_RADIUS);
  const maxX = Math.floor(x + PLAYER_RADIUS);
  const minY = Math.floor(y - PLAYER_RADIUS);
  const maxY = Math.floor(y + PLAYER_RADIUS);
  for (let ty = minY; ty <= maxY; ty += 1) {
    for (let tx = minX; tx <= maxX; tx += 1) {
      if (isTileBlocked(game, tx, ty) && circleRectOverlap(x, y, PLAYER_RADIUS, tx, ty)) return false;
    }
  }

  // Bombs use their actual moving center instead of blocking an entire tile.
  // This keeps kicked bombs smooth while preserving authoritative collision.
  for (const bomb of Object.values(game.bombs)) {
    if (bomb.exploded || bomb.passableFor.includes(playerId)) continue;
    if (bombOverlapsPlayer(bomb, x, y)) return false;
  }
  return true;
}

function tryKickBomb(game, player, dx, dy, now) {
  if (!player.kick || now < player.kickCooldownUntil) return false;
  const dirX = dx === 0 ? 0 : Math.sign(dx);
  const dirY = dy === 0 ? 0 : Math.sign(dy);
  if ((dirX === 0 && dirY === 0) || (dirX !== 0 && dirY !== 0)) return false;

  const probeX = player.x + dirX * (PLAYER_RADIUS + BOMB_RADIUS + 0.12);
  const probeY = player.y + dirY * (PLAYER_RADIUS + BOMB_RADIUS + 0.12);
  const tx = Math.floor(probeX);
  const ty = Math.floor(probeY);
  const bomb = bombAt(game, tx, ty);
  if (!bomb || bomb.moving) return false;

  let targetTx = tx;
  let targetTy = ty;
  for (let step = 1; step <= KICK_SLIDE_TILES; step += 1) {
    const nx = tx + dirX * step;
    const ny = ty + dirY * step;
    if (getCell(game, nx, ny) !== 0 || bombAt(game, nx, ny, bomb.id)) break;
    targetTx = nx;
    targetTy = ny;
  }
  if (targetTx === tx && targetTy === ty) return false;

  bomb.passableFor = [];
  bomb.moving = true;
  bomb.moveX = dirX;
  bomb.moveY = dirY;
  bomb.targetX = targetTx + 0.5;
  bomb.targetY = targetTy + 0.5;

  // Give the bomb a tiny authoritative launch nudge so the kicker does not
  // wait a full network snapshot before being able to step forward.
  bomb.x += dirX * 0.12;
  bomb.y += dirY * 0.12;
  bomb.tx = Math.floor(bomb.x);
  bomb.ty = Math.floor(bomb.y);
  player.kickCooldownUntil = now + 260;
  return true;
}

function stopMovingBomb(bomb, tx = bomb.tx, ty = bomb.ty) {
  bomb.tx = tx;
  bomb.ty = ty;
  bomb.x = tx + 0.5;
  bomb.y = ty + 0.5;
  bomb.moving = false;
  bomb.moveX = 0;
  bomb.moveY = 0;
  bomb.targetX = bomb.x;
  bomb.targetY = bomb.y;
}

function moveKickedBombs(game, dt) {
  for (const bomb of Object.values(game.bombs)) {
    if (!bomb.moving || bomb.exploded) continue;
    const totalDistance = Math.min(
      KICK_SLIDE_SPEED * dt,
      Math.hypot(bomb.targetX - bomb.x, bomb.targetY - bomb.y),
    );
    const steps = Math.max(1, Math.ceil(totalDistance / MAX_BOMB_MOVE_SUBSTEP));
    const stepX = bomb.moveX * totalDistance / steps;
    const stepY = bomb.moveY * totalDistance / steps;

    for (let step = 0; step < steps; step += 1) {
      const nextX = bomb.x + stepX;
      const nextY = bomb.y + stepY;
      const nextTx = Math.floor(nextX);
      const nextTy = Math.floor(nextY);
      if (getCell(game, nextTx, nextTy) !== 0 || bombAt(game, nextTx, nextTy, bomb.id)) {
        stopMovingBomb(bomb);
        break;
      }
      bomb.x = nextX;
      bomb.y = nextY;
      bomb.tx = nextTx;
      bomb.ty = nextTy;
    }

    if (!bomb.moving) continue;
    if (Math.hypot(bomb.targetX - bomb.x, bomb.targetY - bomb.y) <= 0.01) {
      stopMovingBomb(bomb, Math.floor(bomb.targetX), Math.floor(bomb.targetY));
    }
  }
}

function tryCornerAssist(game, player, amount, axis) {
  const perpendicularAxis = axis === 'x' ? 'y' : 'x';
  const perpendicularValue = player[perpendicularAxis];
  const tileCenter = Math.floor(perpendicularValue) + 0.5;
  const centerDelta = tileCenter - perpendicularValue;
  if (Math.abs(centerDelta) < 0.001 || Math.abs(centerDelta) > CORNER_ASSIST_MAX) return false;

  // When the player's circle only clips the tip of a wall, steer toward the
  // center of the current corridor and retry the requested movement. The
  // correction is intentionally small and only commits when forward progress
  // is possible, so holding into a flat wall never drifts the player sideways.
  const nudge = Math.sign(centerDelta) * Math.min(
    Math.abs(centerDelta),
    Math.max(0.018, Math.min(CORNER_ASSIST_STEP, Math.abs(amount) * 1.2)),
  );
  const nudgedX = perpendicularAxis === 'x' ? player.x + nudge : player.x;
  const nudgedY = perpendicularAxis === 'y' ? player.y + nudge : player.y;
  const finalX = axis === 'x' ? nudgedX + amount : nudgedX;
  const finalY = axis === 'y' ? nudgedY + amount : nudgedY;
  if (!canOccupy(game, nudgedX, nudgedY, player.id)
    || !canOccupy(game, finalX, finalY, player.id)) return false;

  player.x = finalX;
  player.y = finalY;
  return true;
}

function touchesDeathBlock(game, x, y) {
  const minX = Math.floor(x - PLAYER_RADIUS);
  const maxX = Math.floor(x + PLAYER_RADIUS);
  const minY = Math.floor(y - PLAYER_RADIUS);
  const maxY = Math.floor(y + PLAYER_RADIUS);
  for (let ty = minY; ty <= maxY; ty += 1) {
    for (let tx = minX; tx <= maxX; tx += 1) {
      if (getCell(game, tx, ty) === 3 && circleRectOverlap(x, y, PLAYER_RADIUS, tx, ty)) return true;
    }
  }
  return false;
}

function eliminateByOvertime(game, player, now) {
  if (!player.alive) return;
  player.alive = false;
  player.moveX = 0;
  player.moveY = 0;
  game.events.push({ type: 'death', playerId: player.id, killerId: null, cause: 'overtime', at: now });
}

function tryMoveAxis(game, player, amount, axis, now) {
  if (amount === 0) return false;
  const nx = axis === 'x' ? player.x + amount : player.x;
  const ny = axis === 'y' ? player.y + amount : player.y;
  if (touchesDeathBlock(game, nx, ny)) {
    eliminateByOvertime(game, player, now);
    return false;
  }
  if (canOccupy(game, nx, ny, player.id)) {
    player.x = nx;
    player.y = ny;
    return true;
  }

  const kicked = tryKickBomb(
    game,
    player,
    axis === 'x' ? amount : 0,
    axis === 'y' ? amount : 0,
    now,
  );
  if (kicked && canOccupy(game, nx, ny, player.id)) {
    player.x = nx;
    player.y = ny;
    return true;
  }

  return tryCornerAssist(game, player, amount, axis);
}

function movePlayer(room, player, input, dt, now) {
  let dx = Number(input.right) - Number(input.left);
  let dy = Number(input.down) - Number(input.up);
  if (dx === 0 && dy === 0) {
    player.moveX = 0;
    player.moveY = 0;
    return;
  }
  const length = Math.hypot(dx, dy) || 1;
  dx /= length;
  dy /= length;
  player.moveX = dx;
  player.moveY = dy;
  if (Math.abs(dx) > Math.abs(dy)) {
    player.facingX = Math.sign(dx);
    player.facingY = 0;
  } else {
    player.facingX = 0;
    player.facingY = Math.sign(dy);
  }

  // Break movement into small swept steps. This prevents a delayed server tick
  // from placing a player partly through a wall or crate.
  const distance = Math.min(player.speed * dt, MAX_TICK_MOVEMENT);
  const steps = Math.max(1, Math.ceil(distance / MAX_MOVE_SUBSTEP));
  const stepX = (dx * distance) / steps;
  const stepY = (dy * distance) / steps;
  for (let step = 0; step < steps; step += 1) {
    tryMoveAxis(room.game, player, stepX, 'x', now);
    tryMoveAxis(room.game, player, stepY, 'y', now);
  }
}

function botTileOpen(game, x, y, playerId, allowStartBomb = false) {
  if (!inBounds(x, y) || getCell(game, x, y) !== 0) return false;
  const bomb = bombAt(game, x, y);
  return !bomb || (allowStartBomb && bomb.passableFor.includes(playerId));
}

function addBombDanger(game, danger, bomb) {
  danger.add(powerupKey(bomb.tx, bomb.ty));
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (let step = 1; step <= bomb.range; step += 1) {
      const x = bomb.tx + dx * step;
      const y = bomb.ty + dy * step;
      const cell = getCell(game, x, y);
      if (cell === 1 || cell === 3) break;
      danger.add(powerupKey(x, y));
      if (cell === 2 && !bomb.piercing) break;
    }
  }
}

function botDangerTiles(game, now) {
  const danger = new Set();
  for (const flame of game.flames) {
    if (flame.until > now) danger.add(powerupKey(flame.x, flame.y));
  }
  // Bots plan around every active bomb, not only the ones about to explode.
  // This gives them enough time to turn a corner before the fuse finishes.
  for (const bomb of Object.values(game.bombs)) addBombDanger(game, danger, bomb);
  return danger;
}

function reconstructBotPath(parent, targetKey) {
  const path = [];
  let cursor = targetKey;
  while (cursor) {
    const [x, y] = cursor.split(',').map(Number);
    path.push([x, y]);
    cursor = parent.get(cursor) || null;
  }
  return path.reverse();
}

function searchBotPath(game, player, goal, danger, options = {}) {
  const startX = Math.floor(player.x);
  const startY = Math.floor(player.y);
  const startKey = powerupKey(startX, startY);
  const queue = [[startX, startY]];
  const parent = new Map([[startKey, null]]);
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let cursor = 0;
  while (cursor < queue.length && cursor < 220) {
    const [x, y] = queue[cursor++];
    const tileKey = powerupKey(x, y);
    if ((x !== startX || y !== startY) && goal(x, y)) return reconstructBotPath(parent, tileKey);
    for (const [dx, dy] of directions) {
      const nx = x + dx;
      const ny = y + dy;
      const nextKey = powerupKey(nx, ny);
      if (parent.has(nextKey)) continue;
      if (!botTileOpen(game, nx, ny, player.id, options.allowStartBomb && x === startX && y === startY)) continue;
      if (!options.allowDanger && danger.has(nextKey)) continue;
      parent.set(nextKey, tileKey);
      queue.push([nx, ny]);
    }
  }
  return [];
}

function botThreatensTarget(game, player) {
  const tx = Math.floor(player.x);
  const ty = Math.floor(player.y);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (getCell(game, tx + dx, ty + dy) === 2) return true;
  }
  for (const other of Object.values(game.players)) {
    if (!other.alive || other.id === player.id) continue;
    const ox = Math.floor(other.x);
    const oy = Math.floor(other.y);
    if (ox === tx && Math.abs(oy - ty) <= player.range) return true;
    if (oy === ty && Math.abs(ox - tx) <= player.range) return true;
  }
  return false;
}

function botEscapePathForNewBomb(game, player, danger) {
  const tx = Math.floor(player.x);
  const ty = Math.floor(player.y);
  const ownBlast = new Set();
  addBombDanger(game, ownBlast, {
    tx,
    ty,
    range: player.range,
    piercing: player.piercing,
  });
  const unsafeDestination = new Set([...danger, ...ownBlast]);
  const path = searchBotPath(
    game,
    player,
    (x, y) => !unsafeDestination.has(powerupKey(x, y)),
    danger,
    { allowStartBomb: true },
  );
  if (path.length <= 1 || path.length - 1 > BOT_MAX_ESCAPE_STEPS) return [];
  return path;
}

function chooseBotPath(game, player, danger) {
  const currentKey = powerupKey(Math.floor(player.x), Math.floor(player.y));
  if (danger.has(currentKey)) {
    return searchBotPath(
      game,
      player,
      (x, y) => !danger.has(powerupKey(x, y)),
      danger,
      { allowStartBomb: true, allowDanger: true },
    );
  }

  const powerupTiles = new Set(Object.values(game.powerups).map((item) => powerupKey(item.x, item.y)));
  if (powerupTiles.size) {
    const path = searchBotPath(game, player, (x, y) => powerupTiles.has(powerupKey(x, y)), danger);
    if (path.length) return path;
  }

  const enemies = Object.values(game.players).filter((other) => other.alive && other.id !== player.id);
  const tacticalPath = searchBotPath(game, player, (x, y) => {
    const besideCrate = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => getCell(game, x + dx, y + dy) === 2);
    const nearEnemy = enemies.some((enemy) => Math.abs(Math.floor(enemy.x) - x) + Math.abs(Math.floor(enemy.y) - y) <= 2);
    return besideCrate || nearEnemy;
  }, danger);
  if (tacticalPath.length) return tacticalPath;

  const safeTiles = [];
  for (let y = 1; y < ROWS - 1; y += 1) {
    for (let x = 1; x < COLS - 1; x += 1) {
      if (botTileOpen(game, x, y, player.id) && !danger.has(powerupKey(x, y))) safeTiles.push(powerupKey(x, y));
    }
  }
  if (!safeTiles.length) return [];
  const target = safeTiles[Math.floor(Math.random() * safeTiles.length)];
  return searchBotPath(game, player, (x, y) => powerupKey(x, y) === target, danger);
}

function trimBotPath(player) {
  while (player.botPath.length > 1) {
    const [targetX, targetY] = player.botPath[1];
    const distance = Math.hypot(player.x - (targetX + 0.5), player.y - (targetY + 0.5));
    if (distance > BOT_PATH_CENTER_TOLERANCE) break;
    player.botPath.shift();
  }
}

function botPathBlocked(game, player, danger, allowDanger = false) {
  trimBotPath(player);
  const target = player.botPath[1];
  if (!target) return false;
  if (!botTileOpen(game, target[0], target[1], player.id)) return true;
  return !allowDanger && danger.has(powerupKey(target[0], target[1]));
}

function botInputTowardPath(player) {
  trimBotPath(player);
  const target = player.botPath[1];
  const source = player.botPath[0];
  if (!target || !source) return { up: false, down: false, left: false, right: false };

  const segmentX = Math.sign(target[0] - source[0]);
  const segmentY = Math.sign(target[1] - source[1]);
  if (segmentX !== 0) {
    const laneY = source[1] + 0.5;
    const laneOffset = laneY - player.y;
    if (Math.abs(laneOffset) > BOT_LANE_TOLERANCE) {
      return { up: laneOffset < 0, down: laneOffset > 0, left: false, right: false };
    }
    const remaining = target[0] + 0.5 - player.x;
    return { up: false, down: false, left: remaining < -0.025, right: remaining > 0.025 };
  }

  const laneX = source[0] + 0.5;
  const laneOffset = laneX - player.x;
  if (Math.abs(laneOffset) > BOT_LANE_TOLERANCE) {
    return { up: false, down: false, left: laneOffset < 0, right: laneOffset > 0 };
  }
  const remaining = target[1] + 0.5 - player.y;
  return { up: remaining < -0.025, down: remaining > 0.025, left: false, right: false };
}

function updateBotProgress(player, now) {
  const moved = Math.hypot(player.x - player.botLastProgressX, player.y - player.botLastProgressY);
  if (moved >= 0.055) {
    player.botLastProgressX = player.x;
    player.botLastProgressY = player.y;
    player.botStuckSince = now;
  }
}

function updateBotControllers(room, now) {
  const game = room.game;
  const danger = botDangerTiles(game, now);
  for (const player of Object.values(game.players)) {
    if (!player.isBot || !player.alive) continue;

    updateBotProgress(player, now);
    trimBotPath(player);
    const tileKey = powerupKey(Math.floor(player.x), Math.floor(player.y));
    const centered = Math.hypot(
      player.x - (Math.floor(player.x) + 0.5),
      player.y - (Math.floor(player.y) + 0.5),
    ) <= 0.18;
    const stuck = now - player.botStuckSince > BOT_STUCK_MS;

    if (player.botMode === 'escape') {
      const reachedSafety = !danger.has(tileKey) && player.botPath.length <= 1;
      const ownBombActive = player.botWaitForOwnBomb
        && Object.values(game.bombs).some((bomb) => bomb.ownerId === player.id && !bomb.exploded);
      if (reachedSafety && ownBombActive) {
        // Once safe, wait for the bomb to resolve instead of immediately choosing
        // a new target and running back into the same blast lane.
        player.botPath = [[Math.floor(player.x), Math.floor(player.y)]];
        player.botStuckSince = now;
        player.botLastProgressX = player.x;
        player.botLastProgressY = player.y;
      } else if (reachedSafety || (now >= player.botEscapeUntil && !danger.has(tileKey) && !ownBombActive)) {
        player.botMode = 'seek';
        player.botWaitForOwnBomb = false;
        player.botPath = [];
      } else if (!player.botPath.length || botPathBlocked(game, player, danger, true) || stuck) {
        player.botPath = searchBotPath(
          game,
          player,
          (x, y) => !danger.has(powerupKey(x, y)),
          danger,
          { allowStartBomb: true, allowDanger: true },
        );
        player.botStuckSince = now;
        player.botLastProgressX = player.x;
        player.botLastProgressY = player.y;
      }
    }

    if (player.botMode !== 'escape') {
      const currentDanger = danger.has(tileKey);
      const needsPath = player.botPath.length <= 1
        || botPathBlocked(game, player, danger)
        || stuck;

      if (currentDanger) {
        player.botMode = 'escape';
        player.botPath = searchBotPath(
          game,
          player,
          (x, y) => !danger.has(powerupKey(x, y)),
          danger,
          { allowStartBomb: true, allowDanger: true },
        );
        player.botEscapeUntil = now + BOMB_FUSE_MS;
      } else if (needsPath) {
        const tileHasBomb = Boolean(bombAt(game, Math.floor(player.x), Math.floor(player.y)));
        const tacticalHere = centered && botThreatensTarget(game, player);
        const hasBombSlot = player.bombsPlaced < player.maxBombs && !tileHasBomb;
        const waitingForCooldown = tacticalHere && hasBombSlot && now < player.botNextBombAt;
        const canBomb = tacticalHere && hasBombSlot && now >= player.botNextBombAt;
        if (waitingForCooldown) {
          // Hold a useful bombing position instead of selecting another target and
          // bouncing back and forth while the short cooldown finishes.
          player.botPath = [[Math.floor(player.x), Math.floor(player.y)]];
        } else if (canBomb) {
          const escapePath = botEscapePathForNewBomb(game, player, danger);
          if (escapePath.length > 1 && placeBomb(room, player.id, 'normal')) {
            player.botMode = 'escape';
            player.botWaitForOwnBomb = true;
            player.botPath = escapePath;
            player.botEscapeUntil = now + BOMB_FUSE_MS + 300;
            player.botNextBombAt = now + BOT_BOMB_COOLDOWN_MS + Math.random() * 850;
          } else {
            player.botPath = chooseBotPath(game, player, danger);
          }
        } else {
          player.botPath = chooseBotPath(game, player, danger);
        }
        player.botNextThinkAt = now + BOT_THINK_MIN_MS + Math.random() * (BOT_THINK_MAX_MS - BOT_THINK_MIN_MS);
        player.botStuckSince = now;
        player.botLastProgressX = player.x;
        player.botLastProgressY = player.y;
      } else if (now >= player.botNextThinkAt) {
        // Keep an active route instead of replacing it every few frames. Rapid
        // replanning was the source of bots vibrating between opposite inputs.
        player.botNextThinkAt = now + BOT_THINK_MIN_MS + Math.random() * (BOT_THINK_MAX_MS - BOT_THINK_MIN_MS);
      }
    }

    room.inputs.set(player.id, botInputTowardPath(player));
  }
}

function clearBombPassability(game) {
  for (const bomb of Object.values(game.bombs)) {
    bomb.passableFor = bomb.passableFor.filter((playerId) => {
      const p = game.players[playerId];
      // Keep a newly placed bomb passable until the player's full collision
      // circle clears the bomb's actual center.
      return p?.alive && bombOverlapsPlayer(bomb, p.x, p.y);
    });
  }
}

function placeSingleBomb(room, player, tx, ty, options = {}) {
  const game = room.game;
  if (!player.alive || getCell(game, tx, ty) !== 0 || bombAt(game, tx, ty)) return false;
  if (player.bombsPlaced >= player.maxBombs) return false;

  const useMega = Boolean(options.mega && player.megaCharges > 0);
  if (useMega) player.megaCharges -= 1;

  const id = String(game.nextBombId++);
  const placedAt = Date.now();
  game.bombs[id] = {
    id,
    ownerId: player.id,
    tx,
    ty,
    // Gameplay remains locked to the grid center, but retain the exact player
    // position so clients can animate the bomb out from under the character.
    x: tx + 0.5,
    y: ty + 0.5,
    spawnX: player.x,
    spawnY: player.y,
    placedAt,
    moving: false,
    moveX: 0,
    moveY: 0,
    targetX: tx + 0.5,
    targetY: ty + 0.5,
    range: useMega ? Math.max(6, player.range + 3) : player.range,
    mega: useMega,
    piercing: player.piercing,
    remote: player.remote && !player.isBot,
    explodeAt: player.remote && !player.isBot ? null : placedAt + BOMB_FUSE_MS,
    passableFor: Object.values(game.players)
      .filter((p) => p.alive && Math.floor(p.x) === tx && Math.floor(p.y) === ty)
      .map((p) => p.id),
    exploded: false,
  };
  player.bombsPlaced += 1;
  return true;
}

function placeBomb(room, playerId, mode = 'normal') {
  if (room.phase !== 'playing' || room.game?.phase !== 'playing') return false;
  const player = room.game.players[playerId];
  if (!player?.alive) return false;
  const tx = Math.floor(player.x);
  const ty = Math.floor(player.y);

  if (mode === 'mega' && player.megaCharges <= 0) return false;

  if (mode === 'line' && player.line) {
    let x = tx;
    let y = ty;
    let placed = false;
    const fx = player.facingX || 0;
    const fy = player.facingY || 1;
    while (player.bombsPlaced < player.maxBombs) {
      if (getCell(room.game, x, y) !== 0 || bombAt(room.game, x, y)) break;
      placed = placeSingleBomb(room, player, x, y, { mega: false }) || placed;
      x += fx;
      y += fy;
    }
    return placed;
  }
  return placeSingleBomb(room, player, tx, ty, { mega: mode === 'mega' });
}

function detonateRemote(room, playerId) {
  if (room.phase !== 'playing' || room.game?.phase !== 'playing') return;
  const player = room.game.players[playerId];
  if (!player?.alive || !player.remote) return;
  const bomb = Object.values(room.game.bombs)
    .filter((b) => b.ownerId === playerId && b.remote && !b.exploded)
    .sort((a, b) => Number(a.id) - Number(b.id))[0];
  if (bomb) explodeBomb(room, bomb.id, Date.now());
}

const POWERUPS = ['speed', 'bomb', 'range', 'kick', 'mega', 'remote', 'piercing', 'line'];

function maybeSpawnPowerup(game, x, y) {
  if (Math.random() > POWERUP_DROP_CHANCE) return;
  const weighted = ['speed', 'speed', 'bomb', 'bomb', 'range', 'range', 'kick', 'mega', 'remote', 'piercing', 'line'];
  const type = weighted[Math.floor(Math.random() * weighted.length)];
  game.powerups[powerupKey(x, y)] = { x, y, type };
}

function addFlame(game, x, y, ownerId, now, mega = false) {
  if (!inBounds(x, y)) return;
  const key = powerupKey(x, y);
  if (game.powerups[key]) delete game.powerups[key];
  const existing = game.flames.find((f) => f.x === x && f.y === y);
  if (existing) {
    existing.until = Math.max(existing.until, now + FLAME_MS);
    existing.ownerId = ownerId;
    existing.mega = existing.mega || mega;
  } else {
    game.flames.push({ x, y, ownerId, until: now + FLAME_MS, mega });
  }
}

function explodeBomb(room, bombId, now) {
  const game = room.game;
  const bomb = game.bombs[bombId];
  if (!bomb || bomb.exploded) return;
  bomb.exploded = true;
  game.events.push({
    type: 'explosion',
    bombId: bomb.id,
    x: bomb.tx,
    y: bomb.ty,
    mega: Boolean(bomb.mega),
    at: now,
  });
  const owner = game.players[bomb.ownerId];
  if (owner) owner.bombsPlaced = Math.max(0, owner.bombsPlaced - 1);

  addFlame(game, bomb.tx, bomb.ty, bomb.ownerId, now, bomb.mega);
  const chain = [];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dy] of dirs) {
    for (let step = 1; step <= bomb.range; step += 1) {
      const x = bomb.tx + dx * step;
      const y = bomb.ty + dy * step;
      const cell = getCell(game, x, y);
      if (cell === 1 || cell === 3) break;

      addFlame(game, x, y, bomb.ownerId, now, bomb.mega);
      const other = bombAt(game, x, y, bomb.id);
      if (other) chain.push(other.id);

      if (cell === 2) {
        setCell(game, x, y, 0);
        maybeSpawnPowerup(game, x, y);
        if (!bomb.piercing) break;
      }
    }
  }
  delete game.bombs[bombId];
  for (const id of chain) explodeBomb(room, id, now);
}

function applyPowerup(player, type) {
  switch (type) {
    case 'speed': player.speed = Math.min(6.2, player.speed + 0.38); break;
    case 'bomb': player.maxBombs = Math.min(9, player.maxBombs + 1); break;
    case 'range': player.range = Math.min(10, player.range + 1); break; // exactly one tile, collector only
    case 'kick': player.kick = true; break;
    case 'mega': player.megaCharges = Math.min(3, player.megaCharges + 1); break;
    case 'remote': player.remote = true; break;
    case 'piercing': player.piercing = true; break;
    case 'line': player.line = true; break;
    default: break;
  }
}

function collectPowerups(game) {
  for (const player of Object.values(game.players)) {
    if (!player.alive) continue;
    const tx = Math.floor(player.x);
    const ty = Math.floor(player.y);
    const key = powerupKey(tx, ty);
    const item = game.powerups[key];
    if (item) {
      applyPowerup(player, item.type);
      delete game.powerups[key];
      game.events.push({ type: 'pickup', playerId: player.id, powerup: item.type, at: Date.now() });
    }
  }
}

function killPlayersInFlames(room, now) {
  const game = room.game;
  for (const player of Object.values(game.players)) {
    if (!player.alive) continue;
    const hit = game.flames.find((f) => f.until > now && Math.floor(player.x) === f.x && Math.floor(player.y) === f.y);
    if (!hit) continue;
    player.alive = false;
    game.events.push({ type: 'death', playerId: player.id, killerId: hit.ownerId, at: now });
    if (hit.ownerId && hit.ownerId !== player.id && game.players[hit.ownerId]) {
      game.players[hit.ownerId].kills += 1;
    }
  }
}

function addDeathBlock(room, now) {
  const game = room.game;
  const next = game.suddenDeathQueue.shift();
  if (!next) return;
  const [x, y] = next;
  if (getCell(game, x, y) === 1) return;
  setCell(game, x, y, 3);
  const bomb = bombAt(game, x, y);
  if (bomb) explodeBomb(room, bomb.id, now);
  delete game.powerups[powerupKey(x, y)];
  for (const p of Object.values(game.players)) {
    if (!p.alive || !circleRectOverlap(p.x, p.y, PLAYER_RADIUS, x, y)) continue;
    eliminateByOvertime(game, p, now);
  }
}

function killPlayersTouchingDeathBlocks(room, now) {
  const game = room.game;
  for (const player of Object.values(game.players)) {
    if (!player.alive) continue;
    const minX = Math.floor(player.x - PLAYER_RADIUS);
    const maxX = Math.floor(player.x + PLAYER_RADIUS);
    const minY = Math.floor(player.y - PLAYER_RADIUS);
    const maxY = Math.floor(player.y + PLAYER_RADIUS);
    let touched = false;
    for (let y = minY; y <= maxY && !touched; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if (getCell(game, x, y) === 3 && circleRectOverlap(player.x, player.y, PLAYER_RADIUS, x, y)) {
          touched = true;
          break;
        }
      }
    }
    if (!touched) continue;
    eliminateByOvertime(game, player, now);
  }
}

function evaluateRound(room, now) {
  const game = room.game;
  if (game.phase !== 'playing') return;
  const alive = Object.values(game.players).filter((p) => p.alive);
  const total = Object.keys(game.players).length;

  const finished = total <= 1 ? alive.length === 0 : alive.length <= 1;
  if (!finished) return;

  const resetDelay = room.players.size <= 1 ? TRAINING_RESET_MS : ROUND_RESET_MS;
  game.phase = 'roundOver';
  game.roundEndsAt = now + resetDelay;
  game.winnerId = alive[0]?.id || null;
  if (game.winnerId && room.players.get(game.winnerId)) {
    room.players.get(game.winnerId).score += 1;
  }
  broadcastRoom(room, 'roundOver', {
    winnerId: game.winnerId,
    winnerName: game.winnerId ? room.players.get(game.winnerId)?.name : null,
    nextRoundIn: resetDelay,
  });
}

function resetRound(room) {
  if (room.players.size === 0) return;
  room.selectedMapId = chooseVotedMap(room);
  room.phase = 'playing';
  room.mapVoteEndsAt = null;
  room.game = createGame(room, room.selectedMapId);
  room.mapVotes.clear();
  broadcastRoom(room, 'gameStarted', {
    round: room.game.round,
    mapId: room.game.mapId,
    mapName: MAPS.find((map) => map.id === room.game.mapId)?.name || 'Arena',
  });
  broadcastLobby(room);
}

function tickRoom(room, dt, now) {
  const game = room.game;
  if (!game) return;

  if (room.phase === 'mapVote') {
    if (room.mapVoteEndsAt && now >= room.mapVoteEndsAt) resetRound(room);
    return;
  }
  if (room.phase !== 'playing') return;

  if (game.phase === 'roundOver') {
    if (now >= game.roundEndsAt) beginMapVote(room, now);
    return;
  }

  moveKickedBombs(game, dt);
  updateBotControllers(room, now);
  for (const [id, player] of Object.entries(game.players)) {
    if (!player.alive) continue;
    movePlayer(room, player, room.inputs.get(id) || {}, dt, now);
  }
  clearBombPassability(game);

  for (const bomb of Object.values(game.bombs)) {
    if (bomb.explodeAt && now >= bomb.explodeAt) explodeBomb(room, bomb.id, now);
  }

  game.flames = game.flames.filter((f) => f.until > now);
  collectPowerups(game);
  killPlayersInFlames(room, now);
  killPlayersTouchingDeathBlocks(room, now);

  if (now >= game.nextDeathBlockAt && game.suddenDeathQueue.length > 0) {
    addDeathBlock(room, now);
    game.nextDeathBlockAt = now + 360;
  }

  game.events = game.events.filter((e) => now - e.at < 1500);
  evaluateRound(room, now);
}

function snapshot(room, now) {
  const game = room.game;
  if (!game) return null;
  return {
    serverTime: now,
    phase: game.phase,
    round: game.round,
    roundEndsAt: game.roundEndsAt,
    winnerId: game.winnerId,
    mapId: game.mapId,
    mapName: MAPS.find((map) => map.id === game.mapId)?.name || 'Arena',
    grid: game.grid,
    cols: COLS,
    rows: ROWS,
    suddenDeathIn: Math.max(0, game.suddenDeathAt - now),
    players: Object.values(game.players).map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      x: p.x,
      y: p.y,
      alive: p.alive,
      maxBombs: p.maxBombs,
      bombsPlaced: p.bombsPlaced,
      range: p.range,
      speed: p.speed,
      moveX: p.moveX || 0,
      moveY: p.moveY || 0,
      facingX: p.facingX || 0,
      facingY: p.facingY || 1,
      isBot: Boolean(p.isBot),
      kick: p.kick,
      remote: p.remote,
      piercing: p.piercing,
      line: p.line,
      megaCharges: p.megaCharges,
      kills: p.kills,
      score: room.players.get(p.id)?.score || 0,
      latencyMs: room.players.get(p.id)?.latencyMs ?? null,
    })),
    bombs: Object.values(game.bombs).map((b) => ({
      id: b.id,
      ownerId: b.ownerId,
      x: b.x,
      y: b.y,
      spawnX: b.spawnX,
      spawnY: b.spawnY,
      placedAt: b.placedAt,
      vx: b.moving ? b.moveX * KICK_SLIDE_SPEED : 0,
      vy: b.moving ? b.moveY * KICK_SLIDE_SPEED : 0,
      moving: b.moving,
      mega: b.mega,
      remote: b.remote,
      explodeAt: b.explodeAt,
    })),
    flames: game.flames,
    powerups: Object.values(game.powerups),
    events: game.events,
  };
}


function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  let header;
  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[1] = data.length;
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

function sendEvent(client, event, data = {}) {
  if (!client || client.closed || !client.raw.writable) return;
  const payload = JSON.stringify({ event, data });
  if (Buffer.byteLength(payload) > 100000) return;
  client.raw.write(encodeFrame(payload));
}

function broadcastRoom(room, event, data) {
  for (const playerId of room.players.keys()) {
    sendEvent(clients.get(playerId), event, data);
  }
}

function closeClient(client) {
  if (!client || client.closed) return;
  client.closed = true;
  leaveCurrentRoom(client);
  clients.delete(client.id);
  try { client.raw.destroy(); } catch {}
}

function parseFrames(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    const fin = Boolean(first & 0x80);
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (client.buffer.length < 4) return;
      length = client.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (client.buffer.length < 10) return;
      const bigLength = client.buffer.readBigUInt64BE(2);
      if (bigLength > 100000n) return closeClient(client);
      length = Number(bigLength);
      offset = 10;
    }

    if (!masked) return closeClient(client);
    if (client.buffer.length < offset + 4 + length) return;

    const mask = client.buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.alloc(length);
    for (let i = 0; i < length; i += 1) payload[i] = client.buffer[offset + i] ^ mask[i % 4];
    client.buffer = client.buffer.subarray(offset + length);

    if (!fin) return closeClient(client);
    if (opcode === 0x8) return closeClient(client);
    if (opcode === 0x9) {
      if (client.raw.writable) client.raw.write(encodeFrame(payload, 0xA));
      continue;
    }
    if (opcode !== 0x1) continue;

    let message;
    try {
      message = JSON.parse(payload.toString('utf8'));
    } catch {
      continue;
    }
    if (!message || typeof message.event !== 'string') continue;
    handleClientEvent(client, message.event, message.data || {});
  }
}

function handleClientEvent(socket, event, data) {
  if (event === 'createRoom') {
    createRoom(socket, data.name);
    return;
  }
  if (event === 'joinRoom') {
    joinRoom(socket, data.code, data.name);
    return;
  }
  if (event === 'leaveRoom') {
    leaveCurrentRoom(socket);
    return;
  }
  if (event === 'addBot') {
    const room = getRoomForSocket(socket);
    if (room && room.hostId === socket.id) addBot(room);
    return;
  }
  if (event === 'removeBot') {
    const room = getRoomForSocket(socket);
    if (room && room.hostId === socket.id) removeBot(room, String(data.botId || ''));
    return;
  }
  if (event === 'latencyPong') {
    if (data.nonce && data.nonce === socket.data.pingNonce && socket.data.pingSentAt) {
      const sample = Math.max(0, Math.min(999, Date.now() - socket.data.pingSentAt));
      socket.data.latencyMs = socket.data.latencyMs == null
        ? sample
        : Math.round(socket.data.latencyMs * 0.7 + sample * 0.3);
      socket.data.pingNonce = null;
      const room = getRoomForSocket(socket);
      const player = room?.players.get(socket.id);
      if (player) player.latencyMs = socket.data.latencyMs;
      if (room && room.phase !== 'playing') broadcastLobby(room);
    }
    return;
  }
  if (event === 'voteMap') {
    const room = getRoomForSocket(socket);
    const mapId = String(data.mapId || '');
    if (!room || !MAPS.some((map) => map.id === mapId)) return;
    if (room.phase !== 'lobby' && room.phase !== 'mapVote') return;
    room.mapVotes.set(socket.id, mapId);
    if (room.phase === 'mapVote' && room.mapVotes.size >= room.players.size) {
      room.mapVoteEndsAt = Math.min(room.mapVoteEndsAt || Infinity, Date.now() + 1200);
    }
    broadcastLobby(room);
    return;
  }
  if (event === 'startGame') {
    const room = getRoomForSocket(socket);
    if (room && room.hostId === socket.id && room.phase === 'lobby') startGame(room);
    return;
  }
  if (event === 'input') {
    // Input packets are tiny state replacements. Never discard a rapid key-up /
    // key-down pair: dropping the second packet makes turns feel delayed until
    // the client's periodic resend arrives.
    socket.data.lastInputAt = Date.now();
    const room = getRoomForSocket(socket);
    if (!room) return;
    room.inputs.set(socket.id, {
      up: Boolean(data.up),
      down: Boolean(data.down),
      left: Boolean(data.left),
      right: Boolean(data.right),
    });
    return;
  }
  if (event === 'action') {
    const now = Date.now();
    if (now - socket.data.lastActionAt < 90) return;
    socket.data.lastActionAt = now;
    const room = getRoomForSocket(socket);
    if (!room) return;
    if (TEST_MODE && data.type === 'testGiveRangePowerup') {
      const player = room.game?.players[socket.id];
      if (!player?.alive) return;
      const tx = Math.floor(player.x);
      const ty = Math.floor(player.y);
      room.game.powerups[powerupKey(tx, ty)] = { x: tx, y: ty, type: 'range' };
      return;
    }
    if (TEST_MODE && data.type === 'testFinishRound') {
      if (!room.game) return;
      for (const player of Object.values(room.game.players)) {
        player.alive = player.id === socket.id;
      }
      return;
    }
    if (TEST_MODE && data.type === 'testPrepareKick') {
      const player = room.game?.players[socket.id];
      if (!player?.alive) return;
      player.kick = true;
      player.x = 1.5;
      player.y = 5.5;
      player.facingX = 1;
      player.facingY = 0;
      for (let x = 1; x <= 7; x += 1) {
        if (getCell(room.game, x, 5) !== 1) setCell(room.game, x, 5, 0);
      }
      placeSingleBomb(room, player, 2, 5, { mega: false });
      return;
    }
    if (TEST_MODE && data.type === 'testPrepareCorner') {
      const player = room.game?.players[socket.id];
      if (!player?.alive) return;
      room.game.bombs = {};
      room.game.flames = [];
      player.bombsPlaced = 0;
      player.kick = false;
      player.x = 1.5;
      player.y = 1.75;
      player.moveX = 0;
      player.moveY = 0;
      player.facingX = 1;
      player.facingY = 0;
      for (let x = 1; x <= 4; x += 1) setCell(room.game, x, 1, 0);
      setCell(room.game, 2, 2, 1);
      return;
    }
    if (TEST_MODE && data.type === 'testPrepareRapidTurn') {
      const player = room.game?.players[socket.id];
      if (!player?.alive) return;
      room.game.bombs = {};
      room.game.flames = [];
      player.x = 5.5;
      player.y = 5.5;
      player.moveX = 0;
      player.moveY = 0;
      for (let x = 4; x <= 8; x += 1) setCell(room.game, x, 5, 0);
      for (let y = 4; y <= 8; y += 1) setCell(room.game, 5, y, 0);
      return;
    }
    if (TEST_MODE && data.type === 'testPrepareBotBomb') {
      const human = room.game?.players[socket.id];
      const bot = Object.values(room.game?.players || {}).find((candidate) => candidate.isBot && candidate.alive);
      if (!human?.alive || !bot) return;
      room.game.bombs = {};
      room.game.flames = [];
      room.game.powerups = {};
      human.x = 10.5;
      human.y = 9.5;
      human.moveX = 0;
      human.moveY = 0;
      bot.x = 5.5;
      bot.y = 5.5;
      bot.moveX = 0;
      bot.moveY = 0;
      bot.facingX = -1;
      bot.facingY = 0;
      bot.maxBombs = 1;
      bot.bombsPlaced = 0;
      bot.range = 1;
      bot.botMode = 'seek';
      bot.botWaitForOwnBomb = false;
      bot.botPath = [];
      bot.botNextBombAt = 0;
      bot.botNextThinkAt = 0;
      bot.botEscapeUntil = 0;
      bot.botLastProgressX = bot.x;
      bot.botLastProgressY = bot.y;
      bot.botStuckSince = now;
      for (let y = 3; y <= 7; y += 1) {
        for (let x = 3; x <= 7; x += 1) setCell(room.game, x, y, 0);
      }
      setCell(room.game, 6, 5, 2);
      return;
    }
    if (TEST_MODE && data.type === 'testPrepareOvertimeTouch') {
      const player = room.game?.players[socket.id];
      if (!player?.alive) return;
      room.game.bombs = {};
      room.game.flames = [];
      player.x = 5.5;
      player.y = 5.5;
      player.moveX = 0;
      player.moveY = 0;
      for (let x = 4; x <= 7; x += 1) setCell(room.game, x, 5, 0);
      setCell(room.game, 6, 5, 3);
      return;
    }
    if (data.type === 'bomb') placeBomb(room, socket.id, 'normal');
    else if (data.type === 'mega') placeBomb(room, socket.id, 'mega');
    else if (data.type === 'line') placeBomb(room, socket.id, 'line');
    else if (data.type === 'remote') detonateRemote(room, socket.id);
  }
}

server.on('upgrade', (req, rawSocket) => {
  if (req.url !== '/ws' || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    rawSocket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    rawSocket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  rawSocket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n'));

  const client = {
    id: crypto.randomUUID(),
    raw: rawSocket,
    buffer: Buffer.alloc(0),
    closed: false,
    data: {
      roomCode: null,
      lastActionAt: 0,
      lastInputAt: 0,
      latencyMs: null,
      lastPingAt: 0,
      pingNonce: null,
      pingSentAt: 0,
    },
  };
  clients.set(client.id, client);
  sendEvent(client, 'welcome', { id: client.id });

  rawSocket.on('data', (chunk) => parseFrames(client, chunk));
  rawSocket.on('close', () => closeClient(client));
  rawSocket.on('end', () => closeClient(client));
  rawSocket.on('error', () => closeClient(client));
});

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 0.05);
  lastTick = now;
  for (const client of clients.values()) {
    if (now - client.data.lastPingAt >= 2000) {
      client.data.lastPingAt = now;
      client.data.pingNonce = crypto.randomBytes(6).toString('hex');
      client.data.pingSentAt = now;
      sendEvent(client, 'latencyPing', { nonce: client.data.pingNonce });
    }
  }
  for (const room of rooms.values()) {
    tickRoom(room, dt, now);
    if (room.phase === 'playing' && now - room.lastSnapshotAt >= 1000 / SNAPSHOT_RATE) {
      room.lastSnapshotAt = now;
      broadcastRoom(room, 'state', snapshot(room, now));
    }
  }
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Fruit Fuse Arena v${GAME_VERSION} listening on http://localhost:${PORT}`);
});
