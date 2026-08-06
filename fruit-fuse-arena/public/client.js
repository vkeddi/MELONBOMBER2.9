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
const botControls = document.getElementById('botControls');
const addBotButton = document.getElementById('addBotButton');
const playerList = document.getElementById('playerList');
const playerCount = document.getElementById('playerCount');
const mapVoteOptions = document.getElementById('mapVoteOptions');
const mapVoteOverlay = document.getElementById('mapVoteOverlay');
const gameMapVoteOptions = document.getElementById('gameMapVoteOptions');
const mapVoteCountdown = document.getElementById('mapVoteCountdown');
const leaveGame = document.getElementById('leaveGame');
const scoreboard = document.getElementById('scoreboard');
const powerHud = document.getElementById('powerHud');
const graphicsMode = document.getElementById('graphicsMode');
const requestedRenderer = new URLSearchParams(location.search).get('renderer');
const useExperimentalWebGL = requestedRenderer !== 'stable';
const hudRoom = document.getElementById('hudRoom');
const hudRound = document.getElementById('hudRound');
const hudTimer = document.getElementById('hudTimer');
const toastStack = document.getElementById('toastStack');
const roundBanner = document.getElementById('roundBanner');
const canvas = document.getElementById('gameCanvas');
const fallbackCanvas = document.getElementById('fallbackCanvas');
const ctx = fallbackCanvas?.getContext('2d', { alpha: false }) || null;
const worldLabels = document.getElementById('worldLabels');
const renderNotice = document.getElementById('renderNotice');
const confettiCanvas = document.getElementById('confettiCanvas');
const confettiCtx = confettiCanvas.getContext('2d');
const versionNumber = document.getElementById('versionNumber');
if (versionNumber) versionNumber.textContent = window.FRUIT_FUSE_VERSION || 'dev';
if (graphicsMode) graphicsMode.textContent = useExperimentalWebGL ? '3D' : 'STABLE';

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
let rendererRuntimeFailed = false;
let compatibilityRendererActive = false;
let compatibilityNoticeShown = false;
const DISPLAY_RADIUS = 0.275;
const DISPLAY_CORNER_ASSIST_MAX = 0.26;
const DISPLAY_MOVE_SUBSTEP = 0.045;
const LOCAL_PREDICTION_LEAD = 0.22;
const BOMB_SPAWN_SETTLE_MS = 180;
const backgroundLayer = { canvas: document.createElement('canvas'), key: '' };
const boardLayer = { canvas: document.createElement('canvas'), key: '', margin: 56 };
let audioContext = null;
let confettiParticles = [];
let confettiAnimation = 0;

function unlockAudio() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) audioContext = new AudioContextClass();
  }
  if (audioContext?.state === 'suspended') audioContext.resume().catch(() => {});
}

window.addEventListener('pointerdown', unlockAudio, { capture: true });
window.addEventListener('keydown', unlockAudio, { capture: true });

function playExplosionSound(mega = false) {
  unlockAudio();
  if (!audioContext || audioContext.state !== 'running') return;
  const now = audioContext.currentTime;
  const duration = mega ? 0.16 : 0.11;

  const oscillator = audioContext.createOscillator();
  const oscillatorGain = audioContext.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(mega ? 105 : 125, now);
  oscillator.frequency.exponentialRampToValueAtTime(mega ? 42 : 58, now + duration);
  oscillatorGain.gain.setValueAtTime(mega ? 0.035 : 0.022, now);
  oscillatorGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  oscillator.connect(oscillatorGain).connect(audioContext.destination);
  oscillator.start(now);
  oscillator.stop(now + duration);

  const noiseLength = Math.max(1, Math.floor(audioContext.sampleRate * duration));
  const noiseBuffer = audioContext.createBuffer(1, noiseLength, audioContext.sampleRate);
  const noiseData = noiseBuffer.getChannelData(0);
  for (let i = 0; i < noiseLength; i += 1) noiseData[i] = (Math.random() * 2 - 1) * (1 - i / noiseLength);
  const noise = audioContext.createBufferSource();
  const filter = audioContext.createBiquadFilter();
  const noiseGain = audioContext.createGain();
  noise.buffer = noiseBuffer;
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(mega ? 720 : 560, now);
  noiseGain.gain.setValueAtTime(mega ? 0.025 : 0.014, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  noise.connect(filter).connect(noiseGain).connect(audioContext.destination);
  noise.start(now);
}

function playRoundEndSound(won) {
  unlockAudio();
  if (!audioContext || audioContext.state !== 'running') return;
  const now = audioContext.currentTime;
  const notes = won ? [523.25, 659.25, 783.99] : [392, 329.63, 261.63];
  notes.forEach((frequency, index) => {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const startsAt = now + index * 0.085;
    oscillator.type = won ? 'triangle' : 'sine';
    oscillator.frequency.setValueAtTime(frequency, startsAt);
    gain.gain.setValueAtTime(0.0001, startsAt);
    gain.gain.exponentialRampToValueAtTime(won ? 0.045 : 0.03, startsAt + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + 0.19);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(startsAt);
    oscillator.stop(startsAt + 0.2);
  });
}

function resizeConfettiCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const width = window.innerWidth;
  const height = window.innerHeight;
  confettiCanvas.width = Math.floor(width * dpr);
  confettiCanvas.height = Math.floor(height * dpr);
  confettiCanvas.style.width = `${width}px`;
  confettiCanvas.style.height = `${height}px`;
  confettiCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function startWinnerConfetti() {
  resizeConfettiCanvas();
  const width = window.innerWidth;
  const height = window.innerHeight;
  const me = state?.players?.find((player) => player.id === socket.id);
  const colors = [me?.color || '#b7ef4a', '#ffd166', '#ff5d73', '#55d6be', '#7aa2ff', '#f6f7fb'];
  confettiParticles = Array.from({ length: 150 }, (_, index) => ({
    x: Math.random() * width,
    y: -20 - Math.random() * height * 0.45,
    vx: (Math.random() - 0.5) * 150,
    vy: 150 + Math.random() * 220,
    gravity: 180 + Math.random() * 120,
    rotation: Math.random() * Math.PI * 2,
    rotationSpeed: (Math.random() - 0.5) * 10,
    width: 5 + Math.random() * 7,
    height: 3 + Math.random() * 5,
    color: colors[index % colors.length],
    life: 2.5 + Math.random() * 1.2,
  }));
  if (!confettiAnimation) {
    let previous = performance.now();
    const animate = (now) => {
      const dt = Math.min(0.035, (now - previous) / 1000);
      previous = now;
      confettiCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      confettiParticles = confettiParticles.filter((particle) => {
        particle.life -= dt;
        if (particle.life <= 0 || particle.y > window.innerHeight + 30) return false;
        particle.vy += particle.gravity * dt;
        particle.x += particle.vx * dt;
        particle.y += particle.vy * dt;
        particle.rotation += particle.rotationSpeed * dt;
        confettiCtx.save();
        confettiCtx.translate(particle.x, particle.y);
        confettiCtx.rotate(particle.rotation);
        confettiCtx.globalAlpha = Math.min(1, particle.life * 1.5);
        confettiCtx.fillStyle = particle.color;
        confettiCtx.fillRect(-particle.width / 2, -particle.height / 2, particle.width, particle.height);
        confettiCtx.restore();
        return true;
      });
      if (confettiParticles.length) confettiAnimation = requestAnimationFrame(animate);
      else {
        confettiAnimation = 0;
        confettiCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      }
    };
    confettiAnimation = requestAnimationFrame(animate);
  }
}

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

function activateCompatibilityRenderer(reason = '', announce = true) {
  compatibilityRendererActive = true;
  rendererRuntimeFailed = true;
  if (graphicsMode) graphicsMode.textContent = 'STABLE';
  canvas?.classList.add('hidden');
  fallbackCanvas?.classList.remove('hidden');
  worldLabels?.classList.add('hidden');
  screens.game?.classList.add('compatibility-mode');
  if (renderNotice) renderNotice.classList.add('hidden');
  if (announce && !compatibilityNoticeShown) {
    compatibilityNoticeShown = true;
    showToast('Stable graphics mode enabled', '#b7ef4a');
  }
  if (reason) console.warn('Using stable software renderer:', reason);
}

// The 3D renderer is the default. Add ?renderer=stable to force the software
// renderer on older or restricted graphics hardware.
if (!useExperimentalWebGL) activateCompatibilityRenderer('', false);

function renderCompatibilityFrame(width, height) {
  if (!ctx || !state) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, fallbackCanvas.width, fallbackCanvas.height);
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBackground(width, height);
  const layout = boardLayout(width, height);
  drawBoard(layout);
  drawPowerups(layout);
  drawBombs(layout);
  drawFlames(layout);
  drawPlayers(layout);
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
  window.FFA3D?.reset();
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
  if (useExperimentalWebGL) {
    compatibilityRendererActive = false;
    rendererRuntimeFailed = false;
    if (graphicsMode) graphicsMode.textContent = '3D';
    canvas?.classList.remove('hidden');
    fallbackCanvas?.classList.add('hidden');
    worldLabels?.classList.remove('hidden');
    screens.game?.classList.remove('compatibility-mode');
    if (renderNotice && window.FFA3D?.available) renderNotice.classList.add('hidden');
    window.FFA3D?.resetRound();
  } else {
    activateCompatibilityRenderer('', false);
  }
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

socket.on('roundOver', ({ winnerId, winnerName }) => {
  const title = winnerName ? `${winnerName} wins!` : 'Nobody survived';
  const won = Boolean(winnerId && winnerId === socket.id);
  playRoundEndSound(won);
  if (won) startWinnerConfetti();
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

function mapPreviewMarkup(map) {
  const preview = map.preview;
  if (!preview || !Array.isArray(preview.walls)) {
    return '<span class="map-preview-fallback" aria-hidden="true"></span>';
  }
  const cols = Math.max(1, Number(preview.cols) || 15);
  const rows = Math.max(1, Number(preview.rows) || 13);
  const wallRects = [];
  preview.walls.forEach((row, y) => {
    String(row).slice(0, cols).split('').forEach((cell, x) => {
      if (cell === '1') wallRects.push(`<rect class="preview-wall" x="${x}" y="${y}" width="1" height="1" rx=".12"/>`);
    });
  });
  const spawnDots = (Array.isArray(preview.spawns) ? preview.spawns : []).map(([x, y]) =>
    `<circle class="preview-spawn" cx="${Number(x) + 0.5}" cy="${Number(y) + 0.5}" r=".22"/>`).join('');
  return `<svg class="map-preview-svg" viewBox="0 0 ${cols} ${rows}" role="img" aria-label="${escapeHtml(map.name)} permanent wall layout">
    <rect class="preview-floor" width="${cols}" height="${rows}" rx=".55"/>
    ${wallRects.join('')}
    ${spawnDots}
  </svg>`;
}

function mapOptionMarkup(map, selected) {
  return `<button type="button" class="map-option ${selected ? 'selected' : ''}" data-map-id="${escapeHtml(map.id)}">
    <span class="map-preview">${mapPreviewMarkup(map)}</span>
    <span class="map-copy">
      <strong>${escapeHtml(map.name)}</strong>
      <small>${escapeHtml(map.description)}</small>
      <em>Walls shown · crates are randomized</em>
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
      ${player.isBot ? '<span class="bot-badge">BOT</span>' : `<span class="latency-badge">${latencyLabel(player.latencyMs)}</span>`}
      ${player.id === lobby.hostId ? '<span class="host-badge">HOST</span>' : ''}
      ${player.isBot && lobby.hostId === socket.id ? `<button type="button" class="remove-bot" data-remove-bot="${escapeHtml(player.id)}" title="Remove ${escapeHtml(player.name)}">×</button>` : ''}
    </div>
  `).join('');
  renderMapVotes();
  const isHost = lobby.hostId === socket.id;
  startButton.classList.toggle('hidden', !isHost);
  waitingText.classList.toggle('hidden', isHost);
  botControls?.classList.toggle('hidden', !isHost || lobby.players.length >= 8);
  startButton.textContent = lobby.players.length === 1 ? 'Start training round' : 'Start voted map';
}

addBotButton?.addEventListener('click', () => socket.emit('addBot'));
playerList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-bot]');
  if (button) socket.emit('removeBot', { botId: button.dataset.removeBot });
});

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
      <span class="${p.alive ? '' : 'dead-name'}">${escapeHtml(p.name)}${p.isBot ? ' · BOT' : ''}</span>
      <span class="score-latency">${p.isBot ? 'AI' : latencyLabel(p.latencyMs)}</span>
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
    const key = `${event.type}:${event.playerId || ''}:${event.killerId || ''}:${event.powerup || ''}:${event.bombId || ''}:${event.at}`;
    activeKeys.add(key);
    if (latestEventKeys.has(key)) continue;
    if (event.type === 'pickup' && event.playerId === socket.id) {
      const info = POWER_INFO[event.powerup];
      showToast(`${info?.icon || ''} ${info?.label || event.powerup} acquired`, info?.color || '#b7ef4a');
    }
    if (event.type === 'explosion') {
      playExplosionSound(Boolean(event.mega));
      window.FFA3D?.triggerExplosion(event);
    }
    if (event.type === 'death') {
      shake = Math.max(shake, 6);
      window.FFA3D?.triggerDeath(event);
      if (event.playerId === socket.id) {
        showToast(event.cause === 'overtime'
          ? 'The overtime wall touched you'
          : 'You were blasted — movement resumes next round', '#ff8da0');
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
  // The WebGL renderer caps resolution internally to keep the 3D view smooth on
  // high-DPI displays while retaining crisp geometry and HUD elements.
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const width = window.innerWidth;
  const height = window.innerHeight;
  window.FFA3D?.resize(width, height, dpr);
  if (fallbackCanvas && ctx) {
    const pixelWidth = Math.max(1, Math.floor(width * dpr));
    const pixelHeight = Math.max(1, Math.floor(height * dpr));
    if (fallbackCanvas.width !== pixelWidth || fallbackCanvas.height !== pixelHeight) {
      fallbackCanvas.width = pixelWidth;
      fallbackCanvas.height = pixelHeight;
      fallbackCanvas.style.width = `${width}px`;
      fallbackCanvas.style.height = `${height}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  return { width, height, dpr };
}
window.addEventListener('resize', () => {
  resizeCanvas();
  resizeConfettiCanvas();
});

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
  const cols = state?.cols || 15;
  const rows = state?.rows || 13;
  const tile = Math.floor(Math.min((viewWidth - 70) / cols, (viewHeight - 105) / rows, 64));
  const boardWidth = tile * cols;
  const boardHeight = tile * rows;
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
    ctx.shadowColor = 'rgba(0,0,0,.48)';
    ctx.shadowBlur = tile * .16;
    ctx.beginPath();
    ctx.arc(cx, cy, tile * .27, 0, Math.PI * 2);
    const metal = ctx.createRadialGradient(cx - tile * .08, cy - tile * .10, tile * .02, cx, cy, tile * .27);
    metal.addColorStop(0, '#68717a');
    metal.addColorStop(.22, '#30363d');
    metal.addColorStop(1, '#111419');
    ctx.fillStyle = metal;
    ctx.fill();
    ctx.strokeStyle = info.color;
    ctx.lineWidth = Math.max(2, tile * .045);
    ctx.stroke();
    ctx.fillStyle = '#f3f7fb';
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
    const gradient = ctx.createLinearGradient(cx, cy - radius, cx, cy + radius);
    gradient.addColorStop(0, bomb.mega ? '#202228' : '#171a1e');
    gradient.addColorStop(.48, bomb.mega ? '#111318' : '#0c0f12');
    gradient.addColorStop(1, '#050607');
    ctx.fillStyle = gradient;
    ctx.fill();
    if (bomb.mega) {
      ctx.strokeStyle = 'rgba(222,55,82,.78)';
      ctx.lineWidth = tile * .06;
      ctx.beginPath();
      ctx.ellipse(cx, cy, radius * .98, radius * .34, 0, 0, Math.PI * 2);
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

    const movingX = player.moveX || 0;
    const movingY = player.moveY || 0;
    const facingX = Math.abs(movingX) + Math.abs(movingY) > .01 ? movingX : (player.facingX || 0);
    const facingY = Math.abs(movingX) + Math.abs(movingY) > .01 ? movingY : (player.facingY || 1);
    const turn = Math.atan2(facingX, facingY);
    ctx.translate(cx, cy + bob);
    ctx.rotate(-turn);
    ctx.fillStyle = '#192036';
    const eyeY = radius * .1;
    ctx.beginPath();
    ctx.arc(-radius * .31, eyeY, radius * .1, 0, Math.PI * 2);
    ctx.arc(radius * .31, eyeY, radius * .1, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#192036';
    ctx.lineWidth = Math.max(1.5, tile * .025);
    ctx.beginPath();
    ctx.arc(0, radius * .29, radius * .22, .2, Math.PI - .2);
    ctx.stroke();
    ctx.rotate(turn);
    ctx.translate(-cx, -(cy + bob));

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
  const viewport = resizeCanvas();
  updateDisplayPlayers(dt);
  updateDisplayBombs(dt);
  window.__ffaSocketId = socket.id;

  if (state && screens.game.classList.contains('active') && now - lastHudRender >= 100) {
    renderHud();
    hudDirty = false;
    lastHudRender = now;
  }

  if (screens.game.classList.contains('active')) {
    if (!compatibilityRendererActive) {
      if (!window.FFA3D?.available) {
        activateCompatibilityRenderer(window.FFA3D?.getStatus?.().message || 'WebGL is unavailable.');
      } else if (!rendererRuntimeFailed) {
        try {
          const rendered = window.FFA3D.render({
            state,
            displayPlayers,
            displayBombs,
            serverNow: estimatedServerNow(),
            animationTime: now,
            shake,
          });
          const rendererStatus = window.FFA3D.getStatus?.();
          if (rendered === false || rendererStatus?.healthy === false) {
            activateCompatibilityRenderer(rendererStatus?.message || 'The browser did not present the 3D frame.');
          }
        } catch (error) {
          console.error('3D renderer stopped during a frame:', error);
          activateCompatibilityRenderer(error?.message || 'Unexpected 3D rendering error.');
        }
      }
    }
    if (compatibilityRendererActive) renderCompatibilityFrame(viewport.width, viewport.height);
    if (shake > .05) shake *= .86;
    else shake = 0;
  }
  requestAnimationFrame(drawFrame);
}
requestAnimationFrame(drawFrame);
