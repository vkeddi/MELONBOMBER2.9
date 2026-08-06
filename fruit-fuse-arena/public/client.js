'use strict';

class EventSocket {
  constructor() {
    this.id = null;
    this.handlers = new Map();
    this.queue = [];
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${scheme}://${location.host}/ws`);
    this.ws.addEventListener('open', () => {
      for (const message of this.queue) this.ws.send(message);
      this.queue.length = 0;
    });
    this.ws.addEventListener('message', (event) => {
      let packet;
      try { packet = JSON.parse(event.data); } catch { return; }
      if (!packet || typeof packet.event !== 'string') return;
      if (packet.event === 'welcome') this.id = packet.data?.id || null;
      for (const handler of this.handlers.get(packet.event) || []) handler(packet.data || {});
    });
    this.ws.addEventListener('close', () => this.dispatch('disconnect', {}));
    this.ws.addEventListener('error', () => {
      if (this.ws.readyState !== WebSocket.OPEN) this.dispatch('disconnect', {});
    });
  }

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(handler);
  }

  emit(event, data = {}) {
    const message = JSON.stringify({ event, data });
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(message);
    else if (this.ws.readyState === WebSocket.CONNECTING) this.queue.push(message);
  }

  dispatch(event, data) {
    for (const handler of this.handlers.get(event) || []) handler(data);
  }
}

const socket = new EventSocket();

const screens = {
  menu: document.getElementById('menuScreen'),
  lobby: document.getElementById('lobbyScreen'),
  game: document.getElementById('gameScreen'),
};
const nameInput = document.getElementById('nameInput');
const codeInput = document.getElementById('codeInput');
const menuNotice = document.getElementById('menuNotice');
const createButton = document.getElementById('createButton');
const joinButton = document.getElementById('joinButton');
const copyCode = document.getElementById('copyCode');
const copyInvite = document.getElementById('copyInvite');
const leaveLobby = document.getElementById('leaveLobby');
const startButton = document.getElementById('startButton');
const waitingText = document.getElementById('waitingText');
const playerList = document.getElementById('playerList');
const playerCount = document.getElementById('playerCount');
const mapVoteOptions = document.getElementById('mapVoteOptions');
const mapVoteOverlay = document.getElementById('mapVoteOverlay');
const gameMapVoteOptions = document.getElementById('gameMapVoteOptions');
const mapVoteCountdown = document.getElementById('mapVoteCountdown');
const leaveGame = document.getElementById('leaveGame');
const scoreboard = document.getElementById('scoreboard');
const powerHud = document.getElementById('powerHud');
const hudRoom = document.getElementById('hudRoom');
const hudRound = document.getElementById('hudRound');
const hudTimer = document.getElementById('hudTimer');
const toastStack = document.getElementById('toastStack');
const roundBanner = document.getElementById('roundBanner');
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

nameInput.value = localStorage.getItem('ffa-name') || '';
const inviteCode = (new URLSearchParams(location.search).get('room') || '')
  .replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 5);
if (inviteCode.length === 5) codeInput.value = inviteCode;

socket.on('latencyPing', ({ nonce }) => {
  if (nonce) socket.emit('latencyPong', { nonce });
});

socket.on('welcome', () => {
  if (inviteCode.length === 5 && nameInput.value.trim()) {
    socket.emit('joinRoom', { code: inviteCode, name: playerName() });
  }
});

let lobby = null;
let state = null;
let currentRoom = null;
let latestEventKeys = new Set();
let displayPlayers = new Map();
let displayBombs = new Map();
let pendingBombAnchors = [];
let animationTime = 0;
let shake = 0;
let lastFrame = performance.now();
let stateReceivedAt = performance.now();
let hudDirty = false;
let lastHudRender = 0;
const DISPLAY_RADIUS = 0.275;
const DISPLAY_CORNER_ASSIST_MAX = 0.26;
const DISPLAY_MOVE_SUBSTEP = 0.045;
const LOCAL_PREDICTION_LEAD = 0.22;
const BOMB_SPAWN_SETTLE_MS = 180;
const backgroundLayer = { canvas: document.createElement('canvas'), key: '' };
const boardLayer = { canvas: document.createElement('canvas'), key: '', margin: 56 };

const input = { up: false, down: false, left: false, right: false };
const keyMap = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
};

const POWER_INFO = {
  speed: { icon: '⚡', label: 'Speed', color: '#55d6be' },
  bomb: { icon: '●', label: 'Bomb+', color: '#f6f7fb' },
  range: { icon: '✦', label: 'Blast +1', color: '#ff9f1c' },
  kick: { icon: '➜', label: 'Kick', color: '#7aa2ff' },
  mega: { icon: '◆', label: 'Mega', color: '#ff5d73' },
  remote: { icon: '⌁', label: 'Remote', color: '#c77dff' },
  piercing: { icon: '⇥', label: 'Pierce', color: '#ffd166' },
  line: { icon: '•••', label: 'Line', color: '#80ed99' },
};

function showScreen(name) {
  Object.entries(screens).forEach(([key, element]) => element.classList.toggle('active', key === name));
}

function playerName() {
  const name = nameInput.value.trim().slice(0, 16);
  localStorage.setItem('ffa-name', name);
  return name;
}

function setNotice(message = '', isError = true) {
  menuNotice.textContent = message;
  menuNotice.style.color = isError ? '#ff9aaa' : '#b7ef4a';
}

createButton.addEventListener('click', () => {
  setNotice('');
  socket.emit('createRoom', { name: playerName() });
});

joinButton.addEventListener('click', () => {
  setNotice('');
  socket.emit('joinRoom', { code: codeInput.value, name: playerName() });
});

codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 5);
});
codeInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') joinButton.click();
});
nameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') createButton.click();
});

function inviteUrl(code) {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', code);
  return url.toString();
}

async function copyText(button, text, successLabel = 'COPIED') {
  try {
    await navigator.clipboard.writeText(text);
    const old = button.textContent;
    button.textContent = successLabel;
    setTimeout(() => { button.textContent = old; }, 900);
  } catch {
    showToast('Copy failed — select the address bar and copy the URL', '#ff8da0');
  }
}

copyCode.addEventListener('click', () => {
  if (currentRoom) copyText(copyCode, currentRoom);
});
copyInvite.addEventListener('click', () => {
  if (currentRoom) copyText(copyInvite, inviteUrl(currentRoom), 'LINK COPIED');
});

leaveLobby.addEventListener('click', leaveRoom);
leaveGame.addEventListener('click', leaveRoom);
startButton.addEventListener('click', () => socket.emit('startGame'));

function handleMapVoteClick(event) {
  const option = event.target.closest('[data-map-id]');
  if (!option) return;
  socket.emit('voteMap', { mapId: option.dataset.mapId });
}
mapVoteOptions.addEventListener('click', handleMapVoteClick);
gameMapVoteOptions.addEventListener('click', handleMapVoteClick);

function leaveRoom() {
  socket.emit('leaveRoom');
  currentRoom = null;
  lobby = null;
  state = null;
  displayPlayers.clear();
  displayBombs.clear();
  pendingBombAnchors = [];
  mapVoteOverlay.classList.add('hidden');
  releaseInputs();
  const cleanUrl = new URL(location.href);
  cleanUrl.searchParams.delete('room');
  history.replaceState(null, '', cleanUrl);
  showScreen('menu');
}

socket.on('notice', ({ type, message }) => {
  if (screens.menu.classList.contains('active')) setNotice(message, type === 'error');
  else showToast(message, type === 'error' ? '#ff8da0' : '#b7ef4a');
});

socket.on('lobby', (data) => {
  lobby = data;
  currentRoom = data.code;
  copyCode.textContent = data.code;
  hudRoom.textContent = data.code;
  const roomUrl = new URL(location.href);
  roomUrl.searchParams.set('room', data.code);
  history.replaceState(null, '', roomUrl);
  renderLobby();
  if (data.phase === 'lobby') {
    mapVoteOverlay.classList.add('hidden');
    showScreen('lobby');
  } else if (data.phase === 'mapVote') {
    roundBanner.classList.add('hidden');
    mapVoteOverlay.classList.remove('hidden');
    showScreen('game');
  } else {
    mapVoteOverlay.classList.add('hidden');
  }
});

socket.on('mapVoteStarted', () => {
  roundBanner.classList.add('hidden');
  mapVoteOverlay.classList.remove('hidden');
  showScreen('game');
});

socket.on('gameStarted', ({ round, mapName }) => {
  showScreen('game');
  mapVoteOverlay.classList.add('hidden');
  roundBanner.classList.add('hidden');
  hudRound.textContent = String(round);
  showToast(`Round ${round} · ${mapName || 'Arena'}`, '#b7ef4a');
});

socket.on('state', (nextState) => {
  nextState.gridKey = nextState.grid.join('');
  state = nextState;
  stateReceivedAt = performance.now();
  hudDirty = true;
  hudRound.textContent = String(nextState.round);
  processEvents(nextState.events || []);
  if (!screens.game.classList.contains('active')) showScreen('game');
});

socket.on('roundOver', ({ winnerName }) => {
  const title = winnerName ? `${winnerName} wins!` : 'Nobody survived';
  roundBanner.innerHTML = `<strong>${escapeHtml(title)}</strong><span>Map vote starting…</span>`;
  roundBanner.classList.remove('hidden');
});

socket.on('disconnect', () => {
  releaseInputs();
  setNotice('Connection lost. Refresh to reconnect.');
  if (!screens.menu.classList.contains('active')) showToast('Connection lost', '#ff8da0');
});

function latencyLabel(value) {
  return Number.isFinite(value) ? `${Math.round(value)}ms` : '—ms';
}

function mapOptionMarkup(map, selected) {
  return `<button type="button" class="map-option ${selected ? 'selected' : ''}" data-map-id="${escapeHtml(map.id)}">
    <span class="map-preview map-${escapeHtml(map.id)}" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
    <span class="map-copy">
      <strong>${escapeHtml(map.name)}</strong>
      <small>${escapeHtml(map.description)}</small>
    </span>
    <span class="map-votes">${map.votes} ${map.votes === 1 ? 'vote' : 'votes'}</span>
  </button>`;
}

function renderMapVotes() {
  if (!lobby?.maps) return;
  const myVote = lobby.players.find((player) => player.id === socket.id)?.mapVote || null;
  const markup = lobby.maps.map((map) => mapOptionMarkup(map, map.id === myVote)).join('');
  mapVoteOptions.innerHTML = markup;
  gameMapVoteOptions.innerHTML = markup;
}

function renderLobby() {
  if (!lobby) return;
  playerCount.textContent = `${lobby.players.length} / 8`;
  playerList.innerHTML = lobby.players.map((player) => `
    <div class="player-card">
      <span class="player-dot" style="background:${player.color}"></span>
      <strong>${escapeHtml(player.name)}${player.id === socket.id ? ' (you)' : ''}</strong>
      <span class="latency-badge">${latencyLabel(player.latencyMs)}</span>
      ${player.id === lobby.hostId ? '<span class="host-badge">HOST</span>' : ''}
    </div>
  `).join('');
  renderMapVotes();
  const isHost = lobby.hostId === socket.id;
  startButton.classList.toggle('hidden', !isHost);
  waitingText.classList.toggle('hidden', isHost);
  startButton.textContent = lobby.players.length === 1 ? 'Start training round' : 'Start voted map';
}

function queueLocalBombAnchor() {
  const local = displayPlayers.get(socket.id)
    || state?.players?.find((player) => player.id === socket.id);
  if (!local) return;
  const now = performance.now();
  pendingBombAnchors = pendingBombAnchors
    .filter((anchor) => now - anchor.createdAt < 800)
    .slice(-2);
  pendingBombAnchors.push({ x: local.x, y: local.y, createdAt: now });
}

function releaseInputs() {
  let changed = false;
  Object.keys(input).forEach((key) => {
    if (input[key]) changed = true;
    input[key] = false;
  });
  if (changed) socket.emit('input', input);
}

window.addEventListener('blur', releaseInputs);
window.addEventListener('keydown', (event) => {
  if (!screens.game.classList.contains('active')) return;
  const mapped = keyMap[event.code];
  if (mapped) {
    event.preventDefault();
    if (!input[mapped]) {
      input[mapped] = true;
      socket.emit('input', input);
    }
    return;
  }
  if (event.repeat) return;
  if (event.code === 'Space') {
    event.preventDefault();
    queueLocalBombAnchor();
    socket.emit('action', { type: 'bomb' });
  } else if (event.code === 'KeyF') {
    queueLocalBombAnchor();
    socket.emit('action', { type: 'mega' });
  } else if (event.code === 'KeyE') {
    socket.emit('action', { type: 'line' });
  } else if (event.code === 'KeyQ') {
    socket.emit('action', { type: 'remote' });
  }
});
window.addEventListener('keyup', (event) => {
  const mapped = keyMap[event.code];
  if (!mapped || !input[mapped]) return;
  event.preventDefault();
  input[mapped] = false;
  socket.emit('input', input);
});

setInterval(() => {
  if (screens.game.classList.contains('active')) socket.emit('input', input);
}, 140);

function estimatedServerNow() {
  if (!state) return 0;
  return state.serverTime + Math.max(0, performance.now() - stateReceivedAt);
}

function renderHud() {
  if (!state) return;
  const remaining = Math.max(0, state.suddenDeathIn - Math.max(0, performance.now() - stateReceivedAt));
  const seconds = Math.ceil(remaining / 1000);
  hudTimer.textContent = remaining > 0
    ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
    : 'CLOSING';

  const sorted = [...state.players].sort((a, b) => b.score - a.score || b.kills - a.kills);
  scoreboard.innerHTML = sorted.map((p) => `
    <div class="score-row ${p.id === socket.id ? 'me' : ''}">
      <span class="score-color" style="background:${p.color}"></span>
      <span class="${p.alive ? '' : 'dead-name'}">${escapeHtml(p.name)}</span>
      <span class="score-latency">${latencyLabel(p.latencyMs)}</span>
      <span class="score-kills">${p.kills}K</span>
      <span class="score-points">${p.score}</span>
    </div>
  `).join('');

  const me = state.players.find((p) => p.id === socket.id);
  if (!me) return;
  const chips = [
    { key: 'bomb', value: `${me.maxBombs - me.bombsPlaced}/${me.maxBombs}`, active: me.maxBombs > 1 },
    { key: 'range', value: me.range, active: me.range > 1 },
    { key: 'speed', value: me.speed.toFixed(1), active: me.speed > 3.5 },
    { key: 'kick', value: me.kick ? 'ON' : '—', active: me.kick },
    { key: 'mega', value: me.megaCharges, active: me.megaCharges > 0 },
    { key: 'remote', value: me.remote ? 'ON' : '—', active: me.remote },
    { key: 'piercing', value: me.piercing ? 'ON' : '—', active: me.piercing },
    { key: 'line', value: me.line ? 'ON' : '—', active: me.line },
  ];
  powerHud.innerHTML = chips.map(({ key, value, active }) => {
    const info = POWER_INFO[key];
    return `<div class="power-chip ${active ? 'active' : ''}" style="--power:${info.color}">
      <span class="icon" style="color:${info.color}">${info.icon} ${value}</span>
      <small>${info.label}</small>
    </div>`;
  }).join('');
}

function processEvents(events) {
  const activeKeys = new Set();
  for (const event of events) {
    const key = `${event.type}:${event.playerId || ''}:${event.killerId || ''}:${event.powerup || ''}:${event.at}`;
    activeKeys.add(key);
    if (latestEventKeys.has(key)) continue;
    if (event.type === 'pickup' && event.playerId === socket.id) {
      const info = POWER_INFO[event.powerup];
      showToast(`${info?.icon || ''} ${info?.label || event.powerup} acquired`, info?.color || '#b7ef4a');
    }
    if (event.type === 'death') {
      shake = Math.max(shake, 6);
      if (event.playerId === socket.id) {
        showToast('You were blasted — movement resumes next round', '#ff8da0');
        roundBanner.innerHTML = '<strong>ELIMINATED</strong><span>Spectating until the next round…</span>';
        roundBanner.classList.remove('hidden');
      }
    }
  }
  latestEventKeys = activeKeys;
}

function showToast(message, color) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  toast.style.background = color;
  toastStack.appendChild(toast);
  setTimeout(() => toast.remove(), 1600);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
}

function resizeCanvas() {
  // A modest DPR cap preserves sharpness while avoiding expensive 4K/retina
  // canvas fills that can cut the frame rate in half.
  const dpr = Math.min(window.devicePixelRatio || 1, 1.4);
  const width = window.innerWidth;
  const height = window.innerHeight;
  if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width, height, dpr };
}
window.addEventListener('resize', resizeCanvas);

function roundedRect(context, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + w, y, x + w, y + h, radius);
  context.arcTo(x + w, y + h, x, y + h, radius);
  context.arcTo(x, y + h, x, y, radius);
  context.arcTo(x, y, x + w, y, radius);
  context.closePath();
}

function boardLayout(viewWidth, viewHeight) {
  const tile = Math.floor(Math.min((viewWidth - 70) / 15, (viewHeight - 105) / 13, 64));
  const boardWidth = tile * 15;
  const boardHeight = tile * 13;
  return {
    tile,
    ox: Math.floor((viewWidth - boardWidth) / 2),
    oy: Math.floor((viewHeight - boardHeight) / 2 + 18),
    boardWidth,
    boardHeight,
  };
}

function displayCircleRectOverlap(cx, cy, radius, rx, ry) {
  const nearestX = Math.max(rx, Math.min(cx, rx + 1));
  const nearestY = Math.max(ry, Math.min(cy, ry + 1));
  const dx = cx - nearestX;
  const dy = cy - nearestY;
  return dx * dx + dy * dy < radius * radius;
}

function canDisplayOccupy(x, y) {
  if (!state) return true;
  const minX = Math.floor(x - DISPLAY_RADIUS);
  const maxX = Math.floor(x + DISPLAY_RADIUS);
  const minY = Math.floor(y - DISPLAY_RADIUS);
  const maxY = Math.floor(y + DISPLAY_RADIUS);
  for (let ty = minY; ty <= maxY; ty += 1) {
    for (let tx = minX; tx <= maxX; tx += 1) {
      if (tx < 0 || ty < 0 || tx >= state.cols || ty >= state.rows) return false;
      const cell = state.grid[ty * state.cols + tx];
      if ((cell === 1 || cell === 2 || cell === 3)
        && displayCircleRectOverlap(x, y, DISPLAY_RADIUS, tx, ty)) return false;
    }
  }
  return true;
}

function tryDisplayCornerAssist(position, amount, axis) {
  const perpendicularAxis = axis === 'x' ? 'y' : 'x';
  const perpendicularValue = position[perpendicularAxis];
  const tileCenter = Math.floor(perpendicularValue) + 0.5;
  const centerDelta = tileCenter - perpendicularValue;
  if (Math.abs(centerDelta) < 0.001 || Math.abs(centerDelta) > DISPLAY_CORNER_ASSIST_MAX) return false;

  const nudge = Math.sign(centerDelta) * Math.min(
    Math.abs(centerDelta),
    Math.max(0.018, Math.min(0.055, Math.abs(amount) * 1.2)),
  );
  const nudgedX = perpendicularAxis === 'x' ? position.x + nudge : position.x;
  const nudgedY = perpendicularAxis === 'y' ? position.y + nudge : position.y;
  const finalX = axis === 'x' ? nudgedX + amount : nudgedX;
  const finalY = axis === 'y' ? nudgedY + amount : nudgedY;
  if (!canDisplayOccupy(nudgedX, nudgedY) || !canDisplayOccupy(finalX, finalY)) return false;
  position.x = finalX;
  position.y = finalY;
  return true;
}

function tryDisplayMoveAxis(position, amount, axis) {
  if (amount === 0) return false;
  const nx = axis === 'x' ? position.x + amount : position.x;
  const ny = axis === 'y' ? position.y + amount : position.y;
  if (canDisplayOccupy(nx, ny)) {
    position.x = nx;
    position.y = ny;
    return true;
  }
  return tryDisplayCornerAssist(position, amount, axis);
}

function predictLocalMovement(position, player, dt) {
  let dx = Number(input.right) - Number(input.left);
  let dy = Number(input.down) - Number(input.up);
  if (dx === 0 && dy === 0) return false;
  const length = Math.hypot(dx, dy) || 1;
  dx /= length;
  dy /= length;

  const distance = Math.min(player.speed * dt, 0.16);
  const steps = Math.max(1, Math.ceil(distance / DISPLAY_MOVE_SUBSTEP));
  const stepX = dx * distance / steps;
  const stepY = dy * distance / steps;
  for (let step = 0; step < steps; step += 1) {
    tryDisplayMoveAxis(position, stepX, 'x');
    tryDisplayMoveAxis(position, stepY, 'y');
  }
  return true;
}

function reconcileDisplayPosition(existing, target, dt, movingLocally) {
  const delta = Math.hypot(target.x - existing.x, target.y - existing.y);
  if (delta > 0.75 || !canDisplayOccupy(existing.x, existing.y)) {
    existing.x = target.x;
    existing.y = target.y;
    return;
  }

  // Keep a small prediction dead zone while a key is held. This removes the
  // soft snapshot-following delay without allowing the rendered player to run
  // far ahead of the authoritative server position.
  const deadZone = movingLocally ? 0.085 : 0.025;
  if (delta > deadZone) {
    const rate = movingLocally ? 9 : 32;
    const factor = 1 - Math.exp(-rate * dt);
    const nextX = existing.x + (target.x - existing.x) * factor;
    const nextY = existing.y + (target.y - existing.y) * factor;
    if (canDisplayOccupy(nextX, existing.y)) existing.x = nextX;
    if (canDisplayOccupy(existing.x, nextY)) existing.y = nextY;
  }

  const leadX = existing.x - target.x;
  const leadY = existing.y - target.y;
  const lead = Math.hypot(leadX, leadY);
  if (lead > LOCAL_PREDICTION_LEAD) {
    const scale = LOCAL_PREDICTION_LEAD / lead;
    const clampedX = target.x + leadX * scale;
    const clampedY = target.y + leadY * scale;
    if (canDisplayOccupy(clampedX, existing.y)) existing.x = clampedX;
    if (canDisplayOccupy(existing.x, clampedY)) existing.y = clampedY;
  }

  if (!movingLocally && Math.abs(target.x - existing.x) < 0.002) existing.x = target.x;
  if (!movingLocally && Math.abs(target.y - existing.y) < 0.002) existing.y = target.y;
}

function updateDisplayPlayers(dt) {
  if (!state) return;
  const seen = new Set();
  for (const p of state.players) {
    seen.add(p.id);
    const existing = displayPlayers.get(p.id);
    if (!existing) {
      displayPlayers.set(p.id, { x: p.x, y: p.y, bob: Math.random() * Math.PI * 2 });
      continue;
    }

    if (!p.alive) {
      existing.x = p.x;
      existing.y = p.y;
      continue;
    }

    if (p.id === socket.id) {
      const movingLocally = predictLocalMovement(existing, p, dt);
      reconcileDisplayPosition(existing, p, dt, movingLocally);
      continue;
    }

    const delta = Math.hypot(p.x - existing.x, p.y - existing.y);
    if (delta > 0.9 || !canDisplayOccupy(existing.x, existing.y)) {
      existing.x = p.x;
      existing.y = p.y;
      continue;
    }

    const factor = 1 - Math.exp(-24 * dt);
    const nextX = existing.x + (p.x - existing.x) * factor;
    const nextY = existing.y + (p.y - existing.y) * factor;
    if (canDisplayOccupy(nextX, existing.y)) existing.x = nextX;
    if (canDisplayOccupy(existing.x, nextY)) existing.y = nextY;
    if (Math.abs(p.x - existing.x) < 0.001) existing.x = p.x;
    if (Math.abs(p.y - existing.y) < 0.001) existing.y = p.y;
  }
  for (const id of displayPlayers.keys()) if (!seen.has(id)) displayPlayers.delete(id);
}

function updateDisplayBombs(dt) {
  if (!state) return;
  const seen = new Set();
  const now = performance.now();
  const age = Math.min(Math.max(0, now - stateReceivedAt) / 1000, 0.055);
  pendingBombAnchors = pendingBombAnchors.filter((anchor) => now - anchor.createdAt < 800);

  for (const bomb of state.bombs) {
    seen.add(bomb.id);
    const targetX = bomb.x + (bomb.vx || 0) * age;
    const targetY = bomb.y + (bomb.vy || 0) * age;
    const existing = displayBombs.get(bomb.id);

    if (!existing) {
      let spawnX = Number.isFinite(bomb.spawnX) ? bomb.spawnX : targetX;
      let spawnY = Number.isFinite(bomb.spawnY) ? bomb.spawnY : targetY;

      // For the local player, use the exact rendered position captured when the
      // key was pressed. This removes the small network/interpolation offset
      // that made newly placed bombs appear above-left while moving.
      if (bomb.ownerId === socket.id && pendingBombAnchors.length) {
        const anchor = pendingBombAnchors.shift();
        spawnX = anchor.x;
        spawnY = anchor.y;
      }

      const serverAge = Number.isFinite(bomb.placedAt)
        ? Math.max(0, estimatedServerNow() - bomb.placedAt)
        : BOMB_SPAWN_SETTLE_MS;
      const progress = Math.min(1, serverAge / BOMB_SPAWN_SETTLE_MS);
      const eased = 1 - Math.pow(1 - progress, 3);
      displayBombs.set(bomb.id, {
        x: spawnX + (targetX - spawnX) * eased,
        y: spawnY + (targetY - spawnY) * eased,
        spawnX,
        spawnY,
        settleStartedAt: now - serverAge,
      });
      continue;
    }

    const settleProgress = Math.min(1, Math.max(0, now - existing.settleStartedAt) / BOMB_SPAWN_SETTLE_MS);
    if (settleProgress < 1 && !bomb.moving) {
      const eased = 1 - Math.pow(1 - settleProgress, 3);
      existing.x = existing.spawnX + (targetX - existing.spawnX) * eased;
      existing.y = existing.spawnY + (targetY - existing.spawnY) * eased;
      continue;
    }

    const delta = Math.hypot(targetX - existing.x, targetY - existing.y);
    if (delta > 1.25) {
      existing.x = targetX;
      existing.y = targetY;
      continue;
    }
    const factor = 1 - Math.exp(-34 * dt);
    existing.x += (targetX - existing.x) * factor;
    existing.y += (targetY - existing.y) * factor;
  }
  for (const id of displayBombs.keys()) if (!seen.has(id)) displayBombs.delete(id);
}

function drawBackground(width, height) {
  const cacheWidth = Math.max(1, Math.ceil(width));
  const cacheHeight = Math.max(1, Math.ceil(height));
  const key = `${cacheWidth}x${cacheHeight}`;
  if (backgroundLayer.key !== key) {
    backgroundLayer.key = key;
    backgroundLayer.canvas.width = cacheWidth;
    backgroundLayer.canvas.height = cacheHeight;
    const layer = backgroundLayer.canvas.getContext('2d');
    const gradient = layer.createRadialGradient(
      width * .5,
      height * .45,
      30,
      width * .5,
      height * .5,
      Math.max(width, height) * .75,
    );
    gradient.addColorStop(0, '#1b2240');
    gradient.addColorStop(.55, '#0d1120');
    gradient.addColorStop(1, '#070912');
    layer.fillStyle = gradient;
    layer.fillRect(0, 0, width, height);

    layer.globalAlpha = .06;
    layer.strokeStyle = '#ffffff';
    layer.lineWidth = 1;
    const spacing = 44;
    for (let x = -height; x < width + height; x += spacing) {
      layer.beginPath();
      layer.moveTo(x, 0);
      layer.lineTo(x - height, height);
      layer.stroke();
    }
    layer.globalAlpha = 1;
  }
  ctx.drawImage(backgroundLayer.canvas, 0, 0, width, height);
}

function drawBoard(layout) {
  if (!state) return;
  const { tile, ox, oy, boardWidth, boardHeight } = layout;
  const margin = boardLayer.margin;
  const key = `${tile}:${state.gridKey || state.grid.join('')}`;

  if (boardLayer.key !== key) {
    boardLayer.key = key;
    boardLayer.canvas.width = boardWidth + margin * 2;
    boardLayer.canvas.height = boardHeight + margin * 2;
    const layer = boardLayer.canvas.getContext('2d');
    layer.clearRect(0, 0, boardLayer.canvas.width, boardLayer.canvas.height);

    layer.save();
    layer.shadowColor = 'rgba(0,0,0,.55)';
    layer.shadowBlur = 35;
    layer.shadowOffsetY = 18;
    roundedRect(layer, margin - 11, margin - 11, boardWidth + 22, boardHeight + 22, 20);
    layer.fillStyle = '#161c31';
    layer.fill();
    layer.restore();

    for (let y = 0; y < state.rows; y += 1) {
      for (let x = 0; x < state.cols; x += 1) {
        const px = margin + x * tile;
        const py = margin + y * tile;
        layer.fillStyle = (x + y) % 2 === 0 ? '#252d47' : '#222a42';
        layer.fillRect(px, py, tile, tile);
        layer.fillStyle = 'rgba(255,255,255,.018)';
        layer.fillRect(px + 1, py + 1, tile - 2, 2);
      }
    }

    for (let y = 0; y < state.rows; y += 1) {
      for (let x = 0; x < state.cols; x += 1) {
        const cell = state.grid[y * state.cols + x];
        if (cell === 1) drawWall(margin + x * tile, margin + y * tile, tile, layer);
        else if (cell === 2) drawCrate(margin + x * tile, margin + y * tile, tile, layer);
      }
    }
  }

  ctx.drawImage(boardLayer.canvas, ox - margin, oy - margin);

  // Sudden-death blocks pulse, so keep only these dynamic instead of redrawing
  // every permanent wall and crate on every frame.
  for (let y = 0; y < state.rows; y += 1) {
    for (let x = 0; x < state.cols; x += 1) {
      if (state.grid[y * state.cols + x] === 3) {
        drawDeathBlock(ox + x * tile, oy + y * tile, tile);
      }
    }
  }
}

function drawWall(x, y, tile, context = ctx) {
  const pad = tile * .08;
  context.save();
  context.shadowColor = 'rgba(0,0,0,.32)';
  context.shadowBlur = tile * .12;
  context.shadowOffsetY = tile * .08;
  roundedRect(context, x + pad, y + pad, tile - pad * 2, tile - pad * 2, tile * .13);
  const gradient = context.createLinearGradient(x, y, x + tile, y + tile);
  gradient.addColorStop(0, '#626b87');
  gradient.addColorStop(.5, '#444c68');
  gradient.addColorStop(1, '#343a52');
  context.fillStyle = gradient;
  context.fill();
  context.shadowColor = 'transparent';
  context.strokeStyle = 'rgba(255,255,255,.13)';
  context.lineWidth = 2;
  context.stroke();
  context.restore();
}

function drawCrate(x, y, tile, context = ctx) {
  const pad = tile * .10;
  context.save();
  context.shadowColor = 'rgba(0,0,0,.35)';
  context.shadowBlur = tile * .13;
  context.shadowOffsetY = tile * .09;
  roundedRect(context, x + pad, y + pad, tile - pad * 2, tile - pad * 2, tile * .09);
  const gradient = context.createLinearGradient(x, y, x, y + tile);
  gradient.addColorStop(0, '#d99b53');
  gradient.addColorStop(1, '#9b5b2f');
  context.fillStyle = gradient;
  context.fill();
  context.shadowColor = 'transparent';
  context.strokeStyle = '#6f3b22';
  context.lineWidth = Math.max(2, tile * .055);
  context.stroke();
  context.beginPath();
  context.moveTo(x + tile * .22, y + tile * .22);
  context.lineTo(x + tile * .78, y + tile * .78);
  context.moveTo(x + tile * .78, y + tile * .22);
  context.lineTo(x + tile * .22, y + tile * .78);
  context.stroke();
  context.restore();
}

function drawDeathBlock(x, y, tile) {
  const pulse = .5 + Math.sin(animationTime * .008 + x + y) * .25;
  ctx.save();
  ctx.fillStyle = '#17131f';
  ctx.fillRect(x, y, tile, tile);
  ctx.shadowColor = '#ff365f';
  ctx.shadowBlur = tile * .35 * pulse;
  roundedRect(ctx, x + tile * .1, y + tile * .1, tile * .8, tile * .8, tile * .12);
  ctx.fillStyle = '#5b1730';
  ctx.fill();
  ctx.strokeStyle = '#ff5d73';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawPowerups(layout) {
  if (!state) return;
  const { tile, ox, oy } = layout;
  for (const item of state.powerups) {
    const info = POWER_INFO[item.type] || POWER_INFO.range;
    const cx = ox + (item.x + .5) * tile;
    const cy = oy + (item.y + .5) * tile + Math.sin(animationTime * .006 + item.x) * tile * .05;
    ctx.save();
    ctx.shadowColor = info.color;
    ctx.shadowBlur = tile * .28;
    ctx.beginPath();
    ctx.arc(cx, cy, tile * .27, 0, Math.PI * 2);
    ctx.fillStyle = '#101425';
    ctx.fill();
    ctx.strokeStyle = info.color;
    ctx.lineWidth = Math.max(2, tile * .045);
    ctx.stroke();
    ctx.fillStyle = info.color;
    ctx.font = `900 ${Math.floor(tile * .28)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(info.icon, cx, cy + 1);
    ctx.restore();
  }
}

function drawBombs(layout) {
  if (!state) return;
  const { tile, ox, oy } = layout;
  for (const bomb of state.bombs) {
    const display = displayBombs.get(bomb.id) || bomb;
    const cx = ox + display.x * tile;
    const cy = oy + (display.y + .02) * tile;
    const fuseProgress = bomb.explodeAt ? Math.max(0, Math.min(1, (bomb.explodeAt - estimatedServerNow()) / 2200)) : .5;
    const urgency = bomb.remote ? .06 : (1 - fuseProgress) * .13;
    const scale = 1 + Math.sin(animationTime * (.009 + urgency)) * (.025 + urgency * .12);
    const radius = tile * (bomb.mega ? .39 : .31) * scale;

    ctx.save();
    ctx.shadowColor = bomb.mega ? '#ff3b64' : 'rgba(0,0,0,.55)';
    ctx.shadowBlur = bomb.mega ? tile * .35 : tile * .17;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    const gradient = ctx.createRadialGradient(cx - radius * .32, cy - radius * .34, radius * .1, cx, cy, radius);
    gradient.addColorStop(0, bomb.mega ? '#ff7d93' : '#9bdd4b');
    gradient.addColorStop(.45, bomb.mega ? '#d92550' : '#4d9c32');
    gradient.addColorStop(1, bomb.mega ? '#6d102a' : '#1c522a');
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.clip();
    ctx.strokeStyle = bomb.mega ? 'rgba(255,220,225,.38)' : 'rgba(195,245,114,.35)';
    ctx.lineWidth = tile * .055;
    for (let stripe = -2; stripe <= 2; stripe += 1) {
      ctx.beginPath();
      ctx.arc(cx + stripe * radius * .34, cy, radius * .95, -1.4, 1.4);
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = '#5b3a24';
    ctx.lineWidth = Math.max(2, tile * .06);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, cy - radius * .9);
    ctx.quadraticCurveTo(cx + tile * .1, cy - radius * 1.28, cx + tile * .18, cy - radius * 1.18);
    ctx.stroke();
    ctx.fillStyle = bomb.remote ? '#c77dff' : '#ffd166';
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = tile * .2;
    ctx.beginPath();
    ctx.arc(cx + tile * .19, cy - radius * 1.18, tile * .055, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawFlames(layout) {
  if (!state) return;
  const { tile, ox, oy } = layout;
  for (const flame of state.flames) {
    const life = Math.max(0, Math.min(1, (flame.until - estimatedServerNow()) / 520));
    const cx = ox + (flame.x + .5) * tile;
    const cy = oy + (flame.y + .5) * tile;
    const radius = tile * (.45 + (1 - life) * .08);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.shadowColor = flame.mega ? '#ff295a' : '#ff9f1c';
    ctx.shadowBlur = tile * .48;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    gradient.addColorStop(0, '#fff6b8');
    gradient.addColorStop(.28, flame.mega ? '#ff5d73' : '#ffd166');
    gradient.addColorStop(.72, flame.mega ? '#f40046' : '#ff7b00');
    gradient.addColorStop(1, 'rgba(255,60,0,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }
}

function drawPlayers(layout) {
  if (!state) return;
  const { tile, ox, oy } = layout;
  const players = [...state.players].sort((a, b) => a.y - b.y);
  for (const player of players) {
    const display = displayPlayers.get(player.id) || player;
    const cx = ox + display.x * tile;
    const cy = oy + display.y * tile;
    const isMoving = Math.abs(player.moveX || 0) + Math.abs(player.moveY || 0) > 0.01;
    const bobAmount = isMoving ? tile * .003 : tile * .007;
    const bob = player.alive ? Math.sin(animationTime * .008 + (display.bob || 0)) * bobAmount : 0;
    const radius = tile * .28;

    if (!player.alive) {
      ctx.save();
      ctx.globalAlpha = .35;
      ctx.fillStyle = '#11131c';
      ctx.beginPath();
      ctx.ellipse(cx, cy + tile * .16, radius * 1.1, radius * .42, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = player.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx - radius * .55, cy - radius * .25);
      ctx.lineTo(cx + radius * .55, cy + radius * .25);
      ctx.moveTo(cx + radius * .55, cy - radius * .25);
      ctx.lineTo(cx - radius * .55, cy + radius * .25);
      ctx.stroke();
      ctx.restore();
      continue;
    }

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + radius * .8, radius * .9, radius * .32, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = player.id === socket.id ? player.color : 'rgba(0,0,0,.5)';
    ctx.shadowBlur = player.id === socket.id ? tile * .28 : tile * .12;
    ctx.beginPath();
    ctx.arc(cx, cy + bob, radius, 0, Math.PI * 2);
    const gradient = ctx.createRadialGradient(cx - radius * .35, cy - radius * .4 + bob, radius * .1, cx, cy + bob, radius);
    gradient.addColorStop(0, '#ffffff');
    gradient.addColorStop(.12, player.color);
    gradient.addColorStop(1, shadeColor(player.color, -45));
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.shadowColor = 'transparent';

    ctx.fillStyle = '#192036';
    const eyeY = cy + bob - radius * .1;
    ctx.beginPath();
    ctx.arc(cx - radius * .31, eyeY, radius * .1, 0, Math.PI * 2);
    ctx.arc(cx + radius * .31, eyeY, radius * .1, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#192036';
    ctx.lineWidth = Math.max(1.5, tile * .025);
    ctx.beginPath();
    ctx.arc(cx, cy + bob + radius * .12, radius * .22, .2, Math.PI - .2);
    ctx.stroke();

    ctx.font = `800 ${Math.max(10, tile * .18)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(7,9,18,.85)';
    ctx.strokeText(player.name, cx, cy - radius - tile * .1 + bob);
    ctx.fillStyle = '#f6f7fb';
    ctx.fillText(player.name, cx, cy - radius - tile * .1 + bob);
    ctx.restore();
  }
}

function shadeColor(hex, amount) {
  const value = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, Math.min(255, (value >> 16) + amount));
  const g = Math.max(0, Math.min(255, ((value >> 8) & 0xff) + amount));
  const b = Math.max(0, Math.min(255, (value & 0xff) + amount));
  return `rgb(${r},${g},${b})`;
}

function updateMapVoteCountdown() {
  if (!lobby || lobby.phase !== 'mapVote' || !lobby.mapVoteEndsAt) return;
  const remaining = Math.max(0, lobby.mapVoteEndsAt - (state ? estimatedServerNow() : Date.now()));
  const voted = lobby.players.filter((player) => player.mapVote).length;
  mapVoteCountdown.textContent = `${Math.ceil(remaining / 1000)}s · ${voted}/${lobby.players.length} voted`;
}

function drawFrame(now) {
  const dt = Math.min((now - lastFrame) / 1000, .05);
  lastFrame = now;
  animationTime = now;
  updateMapVoteCountdown();
  const view = resizeCanvas();
  updateDisplayPlayers(dt);
  updateDisplayBombs(dt);
  drawBackground(view.width, view.height);

  if (state && screens.game.classList.contains('active') && now - lastHudRender >= 100) {
    renderHud();
    hudDirty = false;
    lastHudRender = now;
  }

  if (state && screens.game.classList.contains('active')) {
    const layout = boardLayout(view.width, view.height);
    ctx.save();
    if (shake > .05) {
      ctx.translate((Math.random() - .5) * shake, (Math.random() - .5) * shake);
      shake *= .88;
    }
    drawBoard(layout);
    drawPowerups(layout);
    drawBombs(layout);
    drawFlames(layout);
    drawPlayers(layout);
    ctx.restore();
  }
  requestAnimationFrame(drawFrame);
}
requestAnimationFrame(drawFrame);
