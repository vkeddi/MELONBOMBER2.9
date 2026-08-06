'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'renderer3d.js'), 'utf8');
const clientSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
const menuDemoSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'menu-demo.js'), 'utf8');

assert.match(rendererSource, /shine: bomb\.mega \? \.06 : 0/, 'standard 3D bombs should use a matte shell');
assert.match(rendererSource, /if \(bomb\.mega\) \{\s*draw\('torus'/, 'only mega bombs should retain a warning band');
assert.doesNotMatch(clientSource, /gradient\.addColorStop\(0, '#747b83'\)/, 'software bombs should not have a bright center highlight');
assert.doesNotMatch(menuDemoSource, /gradient\.addColorStop\(0, '#626a72'\)/, 'homepage bombs should not have a bright center highlight');

function makeClassList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    toggle(name, force) {
      if (force === undefined) {
        if (values.has(name)) values.delete(name);
        else values.add(name);
      } else if (force) values.add(name);
      else values.delete(name);
    },
    contains: (name) => values.has(name),
  };
}

function makeElement() {
  const children = [];
  const selectors = new Map();
  return {
    style: {},
    classList: makeClassList(),
    className: '',
    textContent: '',
    innerHTML: '',
    appendChild(child) { children.push(child); },
    remove() {},
    addEventListener() {},
    querySelector(selector) {
      if (!selectors.has(selector)) selectors.set(selector, makeElement());
      return selectors.get(selector);
    },
  };
}

function makeFakeGl(isWebGL2, presentsFrame = true) {
  class FakeWebGL2RenderingContext {}
  const base = isWebGL2 ? new FakeWebGL2RenderingContext() : {};
  const shaderSources = [];
  let nextId = 1;
  const constants = {
    VERTEX_SHADER: 0x8B31,
    FRAGMENT_SHADER: 0x8B30,
    COMPILE_STATUS: 0x8B81,
    LINK_STATUS: 0x8B82,
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    STATIC_DRAW: 0x88E4,
    UNSIGNED_INT: 0x1405,
    UNSIGNED_SHORT: 0x1403,
    FLOAT: 0x1406,
    DEPTH_TEST: 0x0B71,
    LEQUAL: 0x0203,
    CULL_FACE: 0x0B44,
    BACK: 0x0405,
    BLEND: 0x0BE2,
    SRC_ALPHA: 0x0302,
    ONE: 1,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    TRIANGLES: 0x0004,
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_BUFFER_BIT: 0x0100,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    NO_ERROR: 0,
  };
  Object.assign(base, constants, {
    shaderSources,
    createShader(type) { return { id: nextId += 1, type, source: '' }; },
    shaderSource(shader, source) { shader.source = source; shaderSources.push({ type: shader.type, source }); },
    compileShader() {},
    getShaderParameter(shader, parameter) {
      if (parameter !== constants.COMPILE_STATUS) return true;
      if (isWebGL2) {
        return shader.source.startsWith('#version 300 es')
          && !/\battribute\b|\bvarying\b|gl_FragColor/.test(shader.source);
      }
      return !shader.source.includes('#version 300 es')
        && (shader.type === constants.VERTEX_SHADER ? /\battribute\b/.test(shader.source) : /gl_FragColor/.test(shader.source));
    },
    getShaderInfoLog(shader) { return `Incompatible shader for ${isWebGL2 ? 'WebGL2' : 'WebGL1'}: ${shader.source.slice(0, 80)}`; },
    deleteShader() {},
    createProgram() { return { id: nextId += 1 }; },
    attachShader() {},
    linkProgram() {},
    getProgramParameter() { return true; },
    getProgramInfoLog() { return ''; },
    getAttribLocation(_program, name) { return name === 'aPosition' ? 0 : 1; },
    getUniformLocation(_program, name) { return { name }; },
    createBuffer() { return { id: nextId += 1 }; },
    bindBuffer() {},
    bufferData() {},
    useProgram() {},
    enable() {},
    disable() {},
    depthFunc() {},
    cullFace() {},
    clearColor() {},
    uniform3fv() {},
    uniform1f() {},
    viewport() {},
    clear() {},
    blendFunc() {},
    depthMask() {},
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    uniformMatrix4fv() {},
    uniformMatrix3fv() {},
    drawElements() {},
    readPixels(_x, _y, _w, _h, _format, _type, pixel) {
      if (presentsFrame) {
        pixel[0] = 90; pixel[1] = 140; pixel[2] = 80; pixel[3] = 255;
      } else {
        pixel[0] = 7; pixel[1] = 17; pixel[2] = 28; pixel[3] = 255;
      }
    },
    getError() { return constants.NO_ERROR; },
    isContextLost() { return false; },
  });
  return { gl: base, FakeWebGL2RenderingContext, shaderSources };
}

function runRenderer(isWebGL2, presentsFrame = true) {
  const { gl, FakeWebGL2RenderingContext, shaderSources } = makeFakeGl(isWebGL2, presentsFrame);
  const canvas = makeElement();
  canvas.width = 1200;
  canvas.height = 860;
  canvas.getContext = (type) => {
    if (isWebGL2) return type === 'webgl2' ? gl : null;
    return type === 'webgl2' ? null : type === 'webgl' ? gl : null;
  };
  const labels = makeElement();
  const notice = makeElement();
  const elements = { gameCanvas: canvas, worldLabels: labels, renderNotice: notice };
  const windowObject = {
    innerWidth: 1200,
    innerHeight: 860,
    devicePixelRatio: 1,
    __ffaSocketId: 'p1',
  };
  const context = vm.createContext({
    console,
    document: {
      getElementById: (id) => elements[id] || null,
      createElement: () => makeElement(),
    },
    window: windowObject,
    performance: { now: () => 1000 },
    WebGL2RenderingContext: isWebGL2 ? FakeWebGL2RenderingContext : undefined,
    Float32Array,
    Uint16Array,
    Uint32Array,
    Math,
    Number,
    Array,
    Map,
    Set,
    String,
  });
  vm.runInContext(rendererSource, context, { filename: 'renderer3d.js' });
  assert.equal(windowObject.FFA3D?.available, true, `${isWebGL2 ? 'WebGL2' : 'WebGL1'} renderer should initialize`);

  const grid = Array(15 * 13).fill(0);
  grid[0] = 1;
  grid[1] = 2;
  grid[2] = 3;
  const state = {
    cols: 15,
    rows: 13,
    mapId: 'classic',
    grid,
    players: [
      { id: 'p1', name: 'Tester', x: 1.5, y: 1.5, alive: true, color: '#b7ef4a', moveX: 1, moveY: 0 },
      { id: 'p2', name: 'Spectator', x: 13.5, y: 11.5, alive: false, color: '#ff5d73', moveX: 0, moveY: 0 },
    ],
    bombs: [{ id: 'b1', x: 3.5, y: 3.5, tx: 3, ty: 3, explodeAt: 2400, mega: false, remote: false }],
    powerups: [{ x: 4, y: 4, type: 'range' }],
    flames: [{ x: 5, y: 5, until: 1500, mega: false }],
  };
  const displayPlayers = new Map(state.players.map((player) => [player.id, player]));
  const displayBombs = new Map(state.bombs.map((bomb) => [bomb.id, bomb]));
  windowObject.FFA3D.resize(1200, 860, 1);
  let rendered = true;
  for (let frame = 0; frame < (presentsFrame ? 2 : 4); frame += 1) {
    rendered = windowObject.FFA3D.render({
      state,
      displayPlayers,
      displayBombs,
      serverNow: 1100 + frame * 20,
      animationTime: 1100 + frame * 20,
      shake: frame ? 3 : 0,
    });
  }
  windowObject.FFA3D.triggerExplosion({ x: 3, y: 3, mega: false });
  windowObject.FFA3D.triggerDeath({ playerId: 'p2' });
  assert.equal(notice.textContent, '', 'renderer should not show an initialization error');
  assert.equal(shaderSources.length, 2, 'renderer should compile one vertex and one fragment shader');
  if (presentsFrame) {
    assert.equal(rendered, true, 'visible frames should remain on the 3D renderer');
    assert.equal(windowObject.FFA3D.getStatus().framePresented, true, 'visible frame should be detected');
  } else {
    assert.equal(rendered, false, 'four blank gameplay frames should trigger recovery');
    assert.equal(windowObject.FFA3D.getStatus().healthy, false, 'blank renderer should report unhealthy');
  }
}

runRenderer(false);
runRenderer(true);
runRenderer(false, false);
console.log('Renderer runtime test passed for WebGL1/WebGL2 first-frame rendering and blank-frame recovery.');
