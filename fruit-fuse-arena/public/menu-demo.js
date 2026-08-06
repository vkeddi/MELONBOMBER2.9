'use strict';

(() => {
  const canvas = document.getElementById('menuDemoCanvas');
  const menu = document.getElementById('menuScreen');
  if (!canvas || !menu) return;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return;

  const COLS = 15;
  const ROWS = 13;
  const COLORS = ['#ff5d73', '#55d6be', '#ffd166', '#7aa2ff'];
  const grid = Array(COLS * ROWS).fill(0);
  const crates = new Set();
  const bombs = [];
  const flames = [];
  const pickups = [];
  let width = 1;
  let height = 1;
  let dpr = 1;
  let previous = performance.now();
  let accumulator = 0;

  const index = (x, y) => y * COLS + x;
  const wall = (x, y) => x === 0 || y === 0 || x === COLS - 1 || y === ROWS - 1 || (x % 2 === 0 && y % 2 === 0);
  const key = (x, y) => `${x},${y}`;
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  for (let y = 0; y < ROWS; y += 1) {
    for (let x = 0; x < COLS; x += 1) {
      if (wall(x, y)) grid[index(x, y)] = 1;
      else if (((x * 13 + y * 19 + x * y * 3) % 7) < 3) crates.add(key(x, y));
    }
  }
  const clearSpawn = (sx, sy) => {
    [[0, 0], [1, 0], [0, 1], [2, 0], [0, 2]].forEach(([dx, dy]) => crates.delete(key(sx + dx, sy + dy)));
  };
  clearSpawn(1, 1);
  clearSpawn(COLS - 2, 1);
  clearSpawn(1, ROWS - 2);
  clearSpawn(COLS - 2, ROWS - 2);

  const bots = [
    { x: 1.5, y: 1.5, color: COLORS[0], faceX: 0, faceY: 1, nextThink: 0, nextBomb: 900, target: null },
    { x: COLS - 1.5, y: 1.5, color: COLORS[1], faceX: 0, faceY: 1, nextThink: 0, nextBomb: 1500, target: null },
    { x: 1.5, y: ROWS - 1.5, color: COLORS[2], faceX: 0, faceY: -1, nextThink: 0, nextBomb: 2100, target: null },
    { x: COLS - 1.5, y: ROWS - 1.5, color: COLORS[3], faceX: 0, faceY: -1, nextThink: 0, nextBomb: 2700, target: null },
  ];

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 1.35);
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  function bombAt(x, y) {
    return bombs.some((bomb) => bomb.x === x && bomb.y === y && !bomb.exploded);
  }

  function open(x, y) {
    return x > 0 && y > 0 && x < COLS - 1 && y < ROWS - 1
      && !wall(x, y) && !crates.has(key(x, y)) && !bombAt(x, y);
  }

  function dangerTiles(now) {
    const danger = new Set(flames.filter((f) => f.until > now).map((f) => key(f.x, f.y)));
    for (const bomb of bombs) {
      if (bomb.exploded) continue;
      danger.add(key(bomb.x, bomb.y));
      for (const [dx, dy] of directions) {
        for (let step = 1; step <= bomb.range; step += 1) {
          const x = bomb.x + dx * step;
          const y = bomb.y + dy * step;
          if (wall(x, y)) break;
          danger.add(key(x, y));
          if (crates.has(key(x, y))) break;
        }
      }
    }
    return danger;
  }

  function chooseStep(bot, now) {
    const tx = Math.floor(bot.x);
    const ty = Math.floor(bot.y);
    const danger = dangerTiles(now);
    const choices = directions
      .map(([dx, dy]) => ({ x: tx + dx, y: ty + dy, dx, dy }))
      .filter((cell) => open(cell.x, cell.y));
    if (!choices.length) return null;
    const safe = choices.filter((cell) => !danger.has(key(cell.x, cell.y)));
    const pool = safe.length ? safe : choices;
    const pickup = pool.find((cell) => pickups.some((item) => item.x === cell.x && item.y === cell.y));
    if (pickup) return pickup;
    const forward = pool.find((cell) => cell.dx === bot.faceX && cell.dy === bot.faceY);
    if (forward && Math.random() < .52) return forward;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function placeDemoBomb(bot, now) {
    const x = Math.floor(bot.x);
    const y = Math.floor(bot.y);
    if (bombAt(x, y)) return;
    const nearbyCrate = directions.some(([dx, dy]) => crates.has(key(x + dx, y + dy)));
    if (!nearbyCrate && Math.random() > .28) return;
    bombs.push({ x, y, placedAt: now, explodeAt: now + 1900, range: 2, exploded: false });
    bot.nextBomb = now + 2900 + Math.random() * 1800;
  }

  function explode(bomb, now) {
    if (bomb.exploded) return;
    bomb.exploded = true;
    const cells = [[bomb.x, bomb.y]];
    for (const [dx, dy] of directions) {
      for (let step = 1; step <= bomb.range; step += 1) {
        const x = bomb.x + dx * step;
        const y = bomb.y + dy * step;
        if (wall(x, y)) break;
        cells.push([x, y]);
        const cellKey = key(x, y);
        if (crates.has(cellKey)) {
          crates.delete(cellKey);
          if ((x * 7 + y * 11 + Math.floor(now / 100)) % 4 === 0) pickups.push({ x, y, type: (x + y) % 3, born: now });
          break;
        }
      }
    }
    for (const [x, y] of cells) flames.push({ x, y, until: now + 460 });
  }

  function update(dt, now) {
    for (const bomb of bombs) if (!bomb.exploded && now >= bomb.explodeAt) explode(bomb, now);
    while (bombs.length && bombs[0].exploded && now - bombs[0].explodeAt > 700) bombs.shift();
    for (let i = flames.length - 1; i >= 0; i -= 1) if (flames[i].until <= now) flames.splice(i, 1);

    for (const bot of bots) {
      if (now >= bot.nextThink || !bot.target) {
        const next = chooseStep(bot, now);
        if (next) {
          bot.target = { x: next.x + .5, y: next.y + .5 };
          bot.faceX = next.dx;
          bot.faceY = next.dy;
        }
        bot.nextThink = now + 250 + Math.random() * 260;
      }
      if (now >= bot.nextBomb) placeDemoBomb(bot, now);
      if (bot.target) {
        const dx = bot.target.x - bot.x;
        const dy = bot.target.y - bot.y;
        const distance = Math.hypot(dx, dy);
        const move = Math.min(distance, dt * 2.25);
        if (distance > .001) {
          bot.x += dx / distance * move;
          bot.y += dy / distance * move;
        }
        if (distance < .04) bot.target = null;
      }
      const botTileX = Math.floor(bot.x);
      const botTileY = Math.floor(bot.y);
      const pickupIndex = pickups.findIndex((item) => item.x === botTileX && item.y === botTileY);
      if (pickupIndex >= 0) pickups.splice(pickupIndex, 1);
    }
  }

  function shade(hex, amount) {
    const value = Number.parseInt(hex.slice(1), 16);
    const r = Math.max(0, Math.min(255, (value >> 16) + amount));
    const g = Math.max(0, Math.min(255, ((value >> 8) & 255) + amount));
    const b = Math.max(0, Math.min(255, (value & 255) + amount));
    return `rgb(${r},${g},${b})`;
  }

  function draw(now) {
    resize();
    ctx.clearRect(0, 0, width, height);
    const tile = Math.min(width / (COLS + 3), height / (ROWS + 1.5));
    const boardWidth = COLS * tile;
    const boardHeight = ROWS * tile;
    const ox = (width - boardWidth) / 2;
    const oy = (height - boardHeight) / 2 + tile * .25;

    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, '#07131d');
    sky.addColorStop(1, '#07100e');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.72)';
    ctx.shadowBlur = tile * .8;
    ctx.fillStyle = '#16251b';
    ctx.fillRect(ox - tile * .32, oy - tile * .32, boardWidth + tile * .64, boardHeight + tile * .72);
    ctx.restore();

    for (let y = 0; y < ROWS; y += 1) {
      for (let x = 0; x < COLS; x += 1) {
        const px = ox + x * tile;
        const py = oy + y * tile;
        ctx.fillStyle = (x + y) % 2 ? '#477a39' : '#4f8540';
        ctx.fillRect(px, py, tile + .5, tile + .5);
        if (wall(x, y)) {
          ctx.fillStyle = '#3d4852';
          ctx.fillRect(px + tile * .08, py + tile * .13, tile * .84, tile * .79);
          ctx.fillStyle = '#687785';
          ctx.fillRect(px + tile * .08, py + tile * .08, tile * .84, tile * .25);
        } else if (crates.has(key(x, y))) {
          ctx.fillStyle = '#6c3d20';
          ctx.fillRect(px + tile * .13, py + tile * .17, tile * .74, tile * .70);
          ctx.fillStyle = '#af6d35';
          ctx.fillRect(px + tile * .13, py + tile * .12, tile * .74, tile * .23);
          ctx.strokeStyle = '#d5964f';
          ctx.lineWidth = Math.max(1, tile * .045);
          ctx.beginPath();
          ctx.moveTo(px + tile * .23, py + tile * .27);
          ctx.lineTo(px + tile * .77, py + tile * .78);
          ctx.moveTo(px + tile * .77, py + tile * .27);
          ctx.lineTo(px + tile * .23, py + tile * .78);
          ctx.stroke();
        }
      }
    }

    for (const pickup of pickups) {
      const cx = ox + (pickup.x + .5) * tile;
      const cy = oy + (pickup.y + .5) * tile;
      const color = ['#54d7bb', '#f6aa42', '#7ca4ff'][pickup.type];
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(now * .0015 + pickup.x);
      ctx.shadowColor = color;
      ctx.shadowBlur = tile * .25;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, -tile * .21);
      ctx.lineTo(tile * .16, 0);
      ctx.lineTo(0, tile * .21);
      ctx.lineTo(-tile * .16, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    for (const bomb of bombs) {
      if (bomb.exploded) continue;
      const cx = ox + (bomb.x + .5) * tile;
      const cy = oy + (bomb.y + .54) * tile;
      const pulse = 1 + Math.sin(now * .013) * .035;
      const radius = tile * .27 * pulse;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.65)';
      ctx.shadowBlur = tile * .16;
      const gradient = ctx.createRadialGradient(cx - radius * .35, cy - radius * .38, radius * .08, cx, cy, radius);
      gradient.addColorStop(0, '#626a72');
      gradient.addColorStop(.20, '#252a30');
      gradient.addColorStop(1, '#07090b');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#59616a';
      ctx.fillRect(cx - radius * .22, cy - radius * 1.03, radius * .44, radius * .28);
      ctx.strokeStyle = '#7a4d28';
      ctx.lineWidth = Math.max(1.5, tile * .045);
      ctx.beginPath();
      ctx.moveTo(cx, cy - radius * 1.03);
      ctx.quadraticCurveTo(cx + radius * .45, cy - radius * 1.45, cx + radius * .65, cy - radius * 1.35);
      ctx.stroke();
      ctx.fillStyle = '#ffd166';
      ctx.beginPath();
      ctx.arc(cx + radius * .67, cy - radius * 1.36, tile * .04, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    for (const flame of flames) {
      const life = Math.max(0, Math.min(1, (flame.until - now) / 460));
      const cx = ox + (flame.x + .5) * tile;
      const cy = oy + (flame.y + .5) * tile;
      const radius = tile * (.42 + (1 - life) * .08);
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      gradient.addColorStop(0, '#fff7bd');
      gradient.addColorStop(.28, '#ffd166');
      gradient.addColorStop(.66, '#ff7a1a');
      gradient.addColorStop(1, 'rgba(255,54,20,0)');
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    for (const bot of bots) {
      const cx = ox + bot.x * tile;
      const cy = oy + bot.y * tile;
      const radius = tile * .27;
      const angle = Math.atan2(bot.faceX, bot.faceY);
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,.36)';
      ctx.beginPath();
      ctx.ellipse(cx, cy + radius * .78, radius * .86, radius * .30, 0, 0, Math.PI * 2);
      ctx.fill();
      const body = ctx.createRadialGradient(cx - radius * .35, cy - radius * .42, radius * .08, cx, cy, radius);
      body.addColorStop(0, '#fff');
      body.addColorStop(.14, bot.color);
      body.addColorStop(1, shade(bot.color, -55));
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.translate(cx, cy);
      ctx.rotate(-angle);
      ctx.fillStyle = '#f7fbff';
      ctx.beginPath();
      ctx.ellipse(-radius * .28, radius * .20, radius * .10, radius * .14, 0, 0, Math.PI * 2);
      ctx.ellipse(radius * .28, radius * .20, radius * .10, radius * .14, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#11151d';
      ctx.beginPath();
      ctx.arc(-radius * .28, radius * .25, radius * .045, 0, Math.PI * 2);
      ctx.arc(radius * .28, radius * .25, radius * .045, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function frame(now) {
    const dt = Math.min(.05, (now - previous) / 1000);
    previous = now;
    if (menu.classList.contains('active') && document.visibilityState !== 'hidden') {
      accumulator += dt;
      while (accumulator >= 1 / 30) {
        update(1 / 30, now);
        accumulator -= 1 / 30;
      }
      draw(now);
    }
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  requestAnimationFrame(frame);
})();
