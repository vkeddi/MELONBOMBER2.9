'use strict';

(() => {
  const canvas = document.getElementById('gameCanvas');
  const labelLayer = document.getElementById('worldLabels');
  const renderNotice = document.getElementById('renderNotice');
  if (!canvas) return;

  function installRendererFallback(message) {
    if (renderNotice) {
      renderNotice.classList.remove('hidden');
      renderNotice.textContent = message;
    }
    window.FFA3D = {
      available: false,
      resize() {},
      render() { return false; },
      reset() {},
      triggerExplosion() {},
      triggerDeath() {},
      resetRound() {},
      getStatus() { return { available: false, healthy: false, framePresented: false, message }; },
    };
  }

  const contextOptions = {
    antialias: true,
    alpha: false,
    depth: true,
    stencil: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  };
  // This renderer only uses WebGL 1 features. Prefer that context because it is
  // more consistent across integrated GPUs and hosted/virtualized browsers.
  // WebGL 2 remains a fallback for browsers that expose only the newer context.
  const gl = canvas.getContext('webgl', contextOptions)
    || canvas.getContext('experimental-webgl', contextOptions)
    || canvas.getContext('webgl2', contextOptions);

  if (!gl) {
    installRendererFallback('This browser could not start the 3D renderer. Enable hardware acceleration or try a current Chrome, Edge, Firefox, or Safari browser.');
    return;
  }

  const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined'
    && gl instanceof WebGL2RenderingContext;

  // WebGL 2 only accepts GLSL ES 3.00 shaders, while WebGL 1 uses GLSL ES 1.00.
  // The original 3D release always supplied the WebGL 1 syntax even after a
  // WebGL 2 context was created, causing the first gameplay frame to fail on
  // most current browsers. Keep equivalent shader variants for both contexts.
  const vertexShaderSource = isWebGL2 ? `#version 300 es
    in vec3 aPosition;
    in vec3 aNormal;
    uniform mat4 uModel;
    uniform mat4 uViewProjection;
    uniform mat3 uNormalMatrix;
    out vec3 vNormal;
    out vec3 vWorldPosition;
    void main() {
      vec4 world = uModel * vec4(aPosition, 1.0);
      vWorldPosition = world.xyz;
      vNormal = normalize(uNormalMatrix * aNormal);
      gl_Position = uViewProjection * world;
    }
  ` : `
    attribute vec3 aPosition;
    attribute vec3 aNormal;
    uniform mat4 uModel;
    uniform mat4 uViewProjection;
    uniform mat3 uNormalMatrix;
    varying vec3 vNormal;
    varying vec3 vWorldPosition;
    void main() {
      vec4 world = uModel * vec4(aPosition, 1.0);
      vWorldPosition = world.xyz;
      vNormal = normalize(uNormalMatrix * aNormal);
      gl_Position = uViewProjection * world;
    }
  `;

  const fragmentShaderBody = `
    uniform vec3 uColor;
    uniform vec3 uEmissive;
    uniform vec3 uCameraPosition;
    uniform vec3 uLightDirection;
    uniform float uAlpha;
    uniform float uShine;
    uniform float uUnlit;
    uniform float uFogDensity;
    uniform vec3 uFogColor;
    void main() {
      vec3 normal = normalize(vNormal);
      vec3 lightDir = normalize(-uLightDirection);
      float diffuse = max(dot(normal, lightDir), 0.0);
      float halfLambert = diffuse * 0.72 + 0.28;
      vec3 viewDir = normalize(uCameraPosition - vWorldPosition);
      vec3 halfDir = normalize(lightDir + viewDir);
      float specular = pow(max(dot(normal, halfDir), 0.0), mix(6.0, 42.0, uShine)) * uShine;
      vec3 lit = uColor * halfLambert + vec3(specular) * 0.55 + uEmissive;
      lit = mix(lit, uColor + uEmissive, uUnlit);
      float distanceToCamera = length(uCameraPosition - vWorldPosition);
      float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * distanceToCamera * distanceToCamera);
      vec3 finalColor = mix(lit, uFogColor, clamp(fogFactor, 0.0, 0.78));
      OUTPUT_COLOR = vec4(finalColor, uAlpha);
    }
  `;
  const fragmentShaderSource = isWebGL2
    ? `#version 300 es
      precision mediump float;
      in vec3 vNormal;
      in vec3 vWorldPosition;
      out vec4 outColor;
${fragmentShaderBody.replace('OUTPUT_COLOR', 'outColor')}`
    : `
      precision mediump float;
      varying vec3 vNormal;
      varying vec3 vWorldPosition;
${fragmentShaderBody.replace('OUTPUT_COLOR', 'gl_FragColor')}`;

  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || 'Unknown shader error';
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  }

  function createProgram() {
    const program = gl.createProgram();
    gl.attachShader(program, compileShader(gl.VERTEX_SHADER, vertexShaderSource));
    gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || 'Unable to link WebGL program');
    }
    return program;
  }

  let program;
  try {
    program = createProgram();
  } catch (error) {
    console.error(error);
    installRendererFallback('The 3D renderer failed to initialize. Refresh the page or enable hardware acceleration.');
    return;
  }

  const locations = {
    position: gl.getAttribLocation(program, 'aPosition'),
    normal: gl.getAttribLocation(program, 'aNormal'),
    model: gl.getUniformLocation(program, 'uModel'),
    viewProjection: gl.getUniformLocation(program, 'uViewProjection'),
    normalMatrix: gl.getUniformLocation(program, 'uNormalMatrix'),
    color: gl.getUniformLocation(program, 'uColor'),
    emissive: gl.getUniformLocation(program, 'uEmissive'),
    cameraPosition: gl.getUniformLocation(program, 'uCameraPosition'),
    lightDirection: gl.getUniformLocation(program, 'uLightDirection'),
    alpha: gl.getUniformLocation(program, 'uAlpha'),
    shine: gl.getUniformLocation(program, 'uShine'),
    unlit: gl.getUniformLocation(program, 'uUnlit'),
    fogDensity: gl.getUniformLocation(program, 'uFogDensity'),
    fogColor: gl.getUniformLocation(program, 'uFogColor'),
  };

  const meshes = {};
  const playerLabels = new Map();
  let width = 1;
  let height = 1;
  let dpr = 1;
  let viewProjection = identity4();
  let cameraPosition = [0, 18, 14];
  let currentState = null;
  let lastTime = performance.now();
  let particles = [];
  let shockwaves = [];
  let deathBursts = [];
  let ambientPulse = 0;
  let lastBoardSignature = '';
  let scenerySeed = 0;
  let contextLost = false;
  let framePresented = false;
  let blankFrameChecks = 0;
  let lastRenderError = '';

  canvas.addEventListener?.('webglcontextlost', (event) => {
    event.preventDefault?.();
    contextLost = true;
    lastRenderError = 'The browser lost the WebGL context.';
  });
  canvas.addEventListener?.('webglcontextrestored', () => {
    contextLost = false;
    framePresented = false;
    blankFrameChecks = 0;
    lastRenderError = '';
  });

  const COLORS = {
    fog: '#07111c',
    soil: '#172719',
    platform: '#213c2d',
    platformEdge: '#0e1d18',
    floorA: '#78b84a',
    floorB: '#6da83f',
    grid: '#a6d875',
    stone: '#617185',
    stoneTop: '#8797a8',
    stoneInset: '#405064',
    wood: '#ad6c34',
    woodLight: '#d2934d',
    woodDark: '#65381e',
    danger: '#5a1730',
    dangerGlow: '#ff4b72',
    bomb: '#111419',
    bombStripe: '#343b43',
    mega: '#15171c',
    megaStripe: '#b52d45',
    fuse: '#5f3a20',
    spark: '#ffd76a',
    flame: '#ff8a23',
    flameCore: '#fff3ac',
    shadow: '#050a08',
    white: '#f5fbff',
    black: '#11151d',
    leaf: '#4c9b3f',
    leafLight: '#8ed35d',
  };

  const POWER_COLORS = {
    speed: '#55d6be',
    bomb: '#f6f7fb',
    range: '#ff9f1c',
    kick: '#7aa2ff',
    mega: '#ff5d73',
    remote: '#c77dff',
    piercing: '#ffd166',
    line: '#80ed99',
  };

  const clearRgb = hexToRgb(COLORS.fog).map((value) => Math.round(value * 255));

  function hexToRgb(value) {
    if (Array.isArray(value)) return value;
    const hex = String(value || '#ffffff').replace('#', '');
    const normalized = hex.length === 3
      ? hex.split('').map((character) => character + character).join('')
      : hex.padEnd(6, 'f').slice(0, 6);
    const integer = Number.parseInt(normalized, 16);
    return [
      ((integer >> 16) & 255) / 255,
      ((integer >> 8) & 255) / 255,
      (integer & 255) / 255,
    ];
  }

  function shade(value, amount) {
    const [r, g, b] = hexToRgb(value);
    const factor = 1 + amount;
    return [Math.min(1, r * factor), Math.min(1, g * factor), Math.min(1, b * factor)];
  }

  function identity4() {
    return new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);
  }

  function multiply4(a, b) {
    const out = new Float32Array(16);
    for (let column = 0; column < 4; column += 1) {
      for (let row = 0; row < 4; row += 1) {
        out[column * 4 + row] =
          a[0 * 4 + row] * b[column * 4 + 0]
          + a[1 * 4 + row] * b[column * 4 + 1]
          + a[2 * 4 + row] * b[column * 4 + 2]
          + a[3 * 4 + row] * b[column * 4 + 3];
      }
    }
    return out;
  }

  function translation4(x, y, z) {
    const out = identity4();
    out[12] = x;
    out[13] = y;
    out[14] = z;
    return out;
  }

  function scale4(x, y, z) {
    const out = identity4();
    out[0] = x;
    out[5] = y;
    out[10] = z;
    return out;
  }

  function rotationX4(angle) {
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    return new Float32Array([
      1, 0, 0, 0,
      0, cosine, sine, 0,
      0, -sine, cosine, 0,
      0, 0, 0, 1,
    ]);
  }

  function rotationY4(angle) {
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    return new Float32Array([
      cosine, 0, -sine, 0,
      0, 1, 0, 0,
      sine, 0, cosine, 0,
      0, 0, 0, 1,
    ]);
  }

  function rotationZ4(angle) {
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    return new Float32Array([
      cosine, sine, 0, 0,
      -sine, cosine, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);
  }

  function compose(position, scale, rotation = [0, 0, 0]) {
    let matrix = translation4(position[0], position[1], position[2]);
    if (rotation[1]) matrix = multiply4(matrix, rotationY4(rotation[1]));
    if (rotation[0]) matrix = multiply4(matrix, rotationX4(rotation[0]));
    if (rotation[2]) matrix = multiply4(matrix, rotationZ4(rotation[2]));
    return multiply4(matrix, scale4(scale[0], scale[1], scale[2]));
  }

  function perspective4(fovRadians, aspect, near, far) {
    const f = 1 / Math.tan(fovRadians / 2);
    const rangeInverse = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (near + far) * rangeInverse, -1,
      0, 0, near * far * 2 * rangeInverse, 0,
    ]);
  }

  function normalize3(vector) {
    const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
    return [vector[0] / length, vector[1] / length, vector[2] / length];
  }

  function cross3(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }

  function dot3(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  function subtract3(a, b) {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  }

  function lookAt4(eye, target, up = [0, 1, 0]) {
    const zAxis = normalize3(subtract3(eye, target));
    const xAxis = normalize3(cross3(up, zAxis));
    const yAxis = cross3(zAxis, xAxis);
    return new Float32Array([
      xAxis[0], yAxis[0], zAxis[0], 0,
      xAxis[1], yAxis[1], zAxis[1], 0,
      xAxis[2], yAxis[2], zAxis[2], 0,
      -dot3(xAxis, eye), -dot3(yAxis, eye), -dot3(zAxis, eye), 1,
    ]);
  }

  function normalMatrix3(model) {
    const a00 = model[0]; const a01 = model[4]; const a02 = model[8];
    const a10 = model[1]; const a11 = model[5]; const a12 = model[9];
    const a20 = model[2]; const a21 = model[6]; const a22 = model[10];
    const b01 = a22 * a11 - a12 * a21;
    const b11 = -a22 * a10 + a12 * a20;
    const b21 = a21 * a10 - a11 * a20;
    let determinant = a00 * b01 + a01 * b11 + a02 * b21;
    if (!determinant) determinant = 1;
    const inverse = 1 / determinant;
    const inverseMatrix = [
      b01 * inverse,
      (-a22 * a01 + a02 * a21) * inverse,
      (a12 * a01 - a02 * a11) * inverse,
      b11 * inverse,
      (a22 * a00 - a02 * a20) * inverse,
      (-a12 * a00 + a02 * a10) * inverse,
      b21 * inverse,
      (-a21 * a00 + a01 * a20) * inverse,
      (a11 * a00 - a01 * a10) * inverse,
    ];
    return new Float32Array([
      inverseMatrix[0], inverseMatrix[3], inverseMatrix[6],
      inverseMatrix[1], inverseMatrix[4], inverseMatrix[7],
      inverseMatrix[2], inverseMatrix[5], inverseMatrix[8],
    ]);
  }

  function transformPoint(matrix, point) {
    const x = point[0]; const y = point[1]; const z = point[2];
    const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
    return [
      (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w,
      (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w,
      (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / w,
      w,
    ];
  }

  function createMesh(vertices, normals, indices) {
    const interleaved = new Float32Array(vertices.length * 2);
    for (let index = 0; index < vertices.length / 3; index += 1) {
      interleaved[index * 6 + 0] = vertices[index * 3 + 0];
      interleaved[index * 6 + 1] = vertices[index * 3 + 1];
      interleaved[index * 6 + 2] = vertices[index * 3 + 2];
      interleaved[index * 6 + 3] = normals[index * 3 + 0];
      interleaved[index * 6 + 4] = normals[index * 3 + 1];
      interleaved[index * 6 + 5] = normals[index * 3 + 2];
    }
    const vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, interleaved, gl.STATIC_DRAW);
    const indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    const IndexArray = vertices.length / 3 > 65535 ? Uint32Array : Uint16Array;
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new IndexArray(indices), gl.STATIC_DRAW);
    return {
      vertexBuffer,
      indexBuffer,
      count: indices.length,
      indexType: IndexArray === Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
    };
  }

  function cubeGeometry() {
    const positions = [];
    const normals = [];
    const indices = [];
    const faces = [
      { normal: [1, 0, 0], corners: [[.5, -.5, -.5], [.5, .5, -.5], [.5, .5, .5], [.5, -.5, .5]] },
      { normal: [-1, 0, 0], corners: [[-.5, -.5, .5], [-.5, .5, .5], [-.5, .5, -.5], [-.5, -.5, -.5]] },
      { normal: [0, 1, 0], corners: [[-.5, .5, -.5], [-.5, .5, .5], [.5, .5, .5], [.5, .5, -.5]] },
      { normal: [0, -1, 0], corners: [[-.5, -.5, .5], [-.5, -.5, -.5], [.5, -.5, -.5], [.5, -.5, .5]] },
      { normal: [0, 0, 1], corners: [[.5, -.5, .5], [.5, .5, .5], [-.5, .5, .5], [-.5, -.5, .5]] },
      { normal: [0, 0, -1], corners: [[-.5, -.5, -.5], [-.5, .5, -.5], [.5, .5, -.5], [.5, -.5, -.5]] },
    ];
    faces.forEach((face) => {
      const base = positions.length / 3;
      face.corners.forEach((corner) => {
        positions.push(...corner);
        normals.push(...face.normal);
      });
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
    return createMesh(positions, normals, indices);
  }

  function sphereGeometry(longitudes = 16, latitudes = 10) {
    const positions = [];
    const normals = [];
    const indices = [];
    for (let latitude = 0; latitude <= latitudes; latitude += 1) {
      const theta = latitude / latitudes * Math.PI;
      const sinTheta = Math.sin(theta);
      const cosTheta = Math.cos(theta);
      for (let longitude = 0; longitude <= longitudes; longitude += 1) {
        const phi = longitude / longitudes * Math.PI * 2;
        const x = Math.cos(phi) * sinTheta;
        const y = cosTheta;
        const z = Math.sin(phi) * sinTheta;
        positions.push(x * .5, y * .5, z * .5);
        normals.push(x, y, z);
      }
    }
    for (let latitude = 0; latitude < latitudes; latitude += 1) {
      for (let longitude = 0; longitude < longitudes; longitude += 1) {
        const first = latitude * (longitudes + 1) + longitude;
        const second = first + longitudes + 1;
        indices.push(first, second, first + 1, second, second + 1, first + 1);
      }
    }
    return createMesh(positions, normals, indices);
  }

  function cylinderGeometry(segments = 16, topRadius = .5, bottomRadius = .5) {
    const positions = [];
    const normals = [];
    const indices = [];
    for (let segment = 0; segment <= segments; segment += 1) {
      const angle = segment / segments * Math.PI * 2;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      positions.push(cosine * bottomRadius, -.5, sine * bottomRadius);
      positions.push(cosine * topRadius, .5, sine * topRadius);
      const slope = bottomRadius - topRadius;
      const normal = normalize3([cosine, slope, sine]);
      normals.push(...normal, ...normal);
    }
    for (let segment = 0; segment < segments; segment += 1) {
      const base = segment * 2;
      indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
    const bottomCenter = positions.length / 3;
    positions.push(0, -.5, 0);
    normals.push(0, -1, 0);
    const topCenter = positions.length / 3;
    positions.push(0, .5, 0);
    normals.push(0, 1, 0);
    for (let segment = 0; segment < segments; segment += 1) {
      const next = (segment + 1) % segments;
      const bottomA = segment * 2;
      const bottomB = next * 2;
      const topA = segment * 2 + 1;
      const topB = next * 2 + 1;
      indices.push(bottomCenter, bottomB, bottomA);
      indices.push(topCenter, topA, topB);
    }
    return createMesh(positions, normals, indices);
  }

  function torusGeometry(radialSegments = 10, tubularSegments = 20, majorRadius = .34, tubeRadius = .1) {
    const positions = [];
    const normals = [];
    const indices = [];
    for (let radial = 0; radial <= radialSegments; radial += 1) {
      const v = radial / radialSegments * Math.PI * 2;
      const cosV = Math.cos(v);
      const sinV = Math.sin(v);
      for (let tubular = 0; tubular <= tubularSegments; tubular += 1) {
        const u = tubular / tubularSegments * Math.PI * 2;
        const cosU = Math.cos(u);
        const sinU = Math.sin(u);
        const x = (majorRadius + tubeRadius * cosV) * cosU;
        const y = tubeRadius * sinV;
        const z = (majorRadius + tubeRadius * cosV) * sinU;
        positions.push(x, y, z);
        normals.push(cosV * cosU, sinV, cosV * sinU);
      }
    }
    const row = tubularSegments + 1;
    for (let radial = 0; radial < radialSegments; radial += 1) {
      for (let tubular = 0; tubular < tubularSegments; tubular += 1) {
        const a = radial * row + tubular;
        const b = (radial + 1) * row + tubular;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    return createMesh(positions, normals, indices);
  }

  function octahedronGeometry() {
    const vertices = [
      0, .6, 0,
      .5, 0, 0,
      0, 0, .5,
      -.5, 0, 0,
      0, 0, -.5,
      0, -.6, 0,
    ];
    const faces = [
      [0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 1],
      [5, 2, 1], [5, 3, 2], [5, 4, 3], [5, 1, 4],
    ];
    const positions = [];
    const normals = [];
    const indices = [];
    faces.forEach((face) => {
      const a = [vertices[face[0] * 3], vertices[face[0] * 3 + 1], vertices[face[0] * 3 + 2]];
      const b = [vertices[face[1] * 3], vertices[face[1] * 3 + 1], vertices[face[1] * 3 + 2]];
      const c = [vertices[face[2] * 3], vertices[face[2] * 3 + 1], vertices[face[2] * 3 + 2]];
      const normal = normalize3(cross3(subtract3(b, a), subtract3(c, a)));
      const base = positions.length / 3;
      positions.push(...a, ...b, ...c);
      normals.push(...normal, ...normal, ...normal);
      indices.push(base, base + 1, base + 2);
    });
    return createMesh(positions, normals, indices);
  }

  meshes.cube = cubeGeometry();
  meshes.sphere = sphereGeometry();
  meshes.lowSphere = sphereGeometry(10, 7);
  meshes.cylinder = cylinderGeometry();
  meshes.cone = cylinderGeometry(14, 0, .5);
  meshes.torus = torusGeometry();
  meshes.octahedron = octahedronGeometry();

  gl.useProgram(program);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.clearColor(...hexToRgb(COLORS.fog), 1);
  gl.uniform3fv(locations.lightDirection, new Float32Array(normalize3([-.55, -1, -.35])));
  gl.uniform3fv(locations.fogColor, new Float32Array(hexToRgb(COLORS.fog)));
  gl.uniform1f(locations.fogDensity, .028);

  function draw(meshName, position, scale, color, rotation = [0, 0, 0], options = {}) {
    const mesh = meshes[meshName];
    if (!mesh) return;
    const model = compose(position, scale, rotation);
    const rgb = hexToRgb(color);
    const emissive = options.emissive ? hexToRgb(options.emissive) : [0, 0, 0];
    const alpha = options.alpha == null ? 1 : options.alpha;
    const blended = alpha < .999 || options.blend;

    if (blended) {
      gl.enable(gl.BLEND);
      gl.blendFunc(options.additive ? gl.SRC_ALPHA : gl.SRC_ALPHA, options.additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      if (options.doubleSided) gl.disable(gl.CULL_FACE);
    } else {
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.enable(gl.CULL_FACE);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vertexBuffer);
    gl.enableVertexAttribArray(locations.position);
    gl.vertexAttribPointer(locations.position, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(locations.normal);
    gl.vertexAttribPointer(locations.normal, 3, gl.FLOAT, false, 24, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indexBuffer);
    gl.uniformMatrix4fv(locations.model, false, model);
    gl.uniformMatrix3fv(locations.normalMatrix, false, normalMatrix3(model));
    gl.uniform3fv(locations.color, new Float32Array(rgb));
    gl.uniform3fv(locations.emissive, new Float32Array(emissive));
    gl.uniform1f(locations.alpha, alpha);
    gl.uniform1f(locations.shine, options.shine || 0);
    gl.uniform1f(locations.unlit, options.unlit ? 1 : 0);
    gl.drawElements(gl.TRIANGLES, mesh.count, mesh.indexType, 0);

    if (blended) {
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.enable(gl.CULL_FACE);
    }
  }

  function gridToWorldX(x, cols) {
    return x - cols / 2;
  }

  function gridToWorldZ(y, rows) {
    return y - rows / 2;
  }

  function cellCenterX(x, cols) {
    return x + .5 - cols / 2;
  }

  function cellCenterZ(y, rows) {
    return y + .5 - rows / 2;
  }

  function hashNoise(x, y = 0, seed = 0) {
    const value = Math.sin(x * 127.1 + y * 311.7 + seed * 91.37) * 43758.5453123;
    return value - Math.floor(value);
  }

  function drawShadow(x, z, radius, alpha = .24) {
    draw('lowSphere', [x, .018, z], [radius * 2, .035, radius * 1.35], COLORS.shadow, [0, 0, 0], {
      alpha,
      unlit: true,
      blend: true,
    });
  }

  function drawEnvironment(state, now) {
    const cols = state.cols || 15;
    const rows = state.rows || 13;
    const boardWidth = cols;
    const boardDepth = rows;
    const pulse = .5 + .5 * Math.sin(now * .0007);

    draw('cube', [0, -.56, 0], [boardWidth + 2.4, .72, boardDepth + 2.4], COLORS.platformEdge, [0, 0, 0], { shine: .05 });
    draw('cube', [0, -.27, 0], [boardWidth + 1.65, .34, boardDepth + 1.65], COLORS.platform, [0, 0, 0], { shine: .1 });
    draw('cube', [0, -.075, 0], [boardWidth + .36, .16, boardDepth + .36], COLORS.floorA, [0, 0, 0], { shine: .04 });

    const borderColor = shade('#85d557', pulse * .08);
    draw('cube', [0, .015, -boardDepth / 2 - .18], [boardWidth + .35, .08, .09], borderColor, [0, 0, 0], { emissive: '#183a1e' });
    draw('cube', [0, .015, boardDepth / 2 + .18], [boardWidth + .35, .08, .09], borderColor, [0, 0, 0], { emissive: '#183a1e' });
    draw('cube', [-boardWidth / 2 - .18, .015, 0], [.09, .08, boardDepth + .35], borderColor, [0, 0, 0], { emissive: '#183a1e' });
    draw('cube', [boardWidth / 2 + .18, .015, 0], [.09, .08, boardDepth + .35], borderColor, [0, 0, 0], { emissive: '#183a1e' });

    const gridColor = shade(COLORS.grid, -.12);
    for (let x = 1; x < cols; x += 1) {
      draw('cube', [x - cols / 2, .015, 0], [.022, .022, rows], gridColor, [0, 0, 0], { alpha: .27, unlit: true, blend: true });
    }
    for (let y = 1; y < rows; y += 1) {
      draw('cube', [0, .015, y - rows / 2], [cols, .022, .022], gridColor, [0, 0, 0], { alpha: .27, unlit: true, blend: true });
    }

    const signature = `${cols}:${rows}:${state.mapId || state.mapName || ''}`;
    if (signature !== lastBoardSignature) {
      lastBoardSignature = signature;
      scenerySeed += 1;
    }

    const perimeter = Math.max(cols, rows) + 5.5;
    for (let index = 0; index < 18; index += 1) {
      const side = index % 4;
      const along = (hashNoise(index, scenerySeed, 2) - .5) * (side % 2 === 0 ? cols + 7 : rows + 7);
      const offset = perimeter * .5 + hashNoise(index, scenerySeed, 3) * 2.2;
      let x;
      let z;
      if (side === 0) { x = along; z = -offset; }
      else if (side === 1) { x = offset; z = along; }
      else if (side === 2) { x = along; z = offset; }
      else { x = -offset; z = along; }
      const scale = .72 + hashNoise(index, scenerySeed, 4) * .7;
      draw('cylinder', [x, .15 * scale, z], [.23 * scale, .8 * scale, .23 * scale], '#6b4727', [0, hashNoise(index, 3) * Math.PI, 0]);
      draw('lowSphere', [x, .72 * scale, z], [1.05 * scale, .9 * scale, 1.05 * scale], index % 3 === 0 ? '#39743e' : '#2f6537', [0, hashNoise(index, 4) * Math.PI, 0], { shine: .05 });
      draw('lowSphere', [x + .28 * scale, .78 * scale, z - .12 * scale], [.55 * scale, .48 * scale, .55 * scale], index % 2 ? '#e89b3d' : '#d95157', [0, 0, 0], { shine: .18 });
    }
  }

  function drawWall(x, z, now) {
    const shimmer = .03 * Math.sin(now * .0018 + x * 2 + z);
    draw('cube', [x, .48, z], [.86, .96, .86], shade(COLORS.stone, shimmer), [0, 0, 0], { shine: .14 });
    draw('cube', [x, .99, z], [.76, .10, .76], COLORS.stoneTop, [0, Math.PI / 4, 0], { shine: .22 });
    draw('cube', [x, .22, z + .435], [.46, .24, .025], COLORS.stoneInset, [0, 0, 0]);
  }

  function drawCrate(x, z, index) {
    const turn = (index % 2 ? 1 : -1) * .018;
    draw('cube', [x, .39, z], [.82, .78, .82], index % 3 === 0 ? COLORS.woodLight : COLORS.wood, [turn, 0, -turn], { shine: .06 });
    draw('cube', [x, .81, z], [.72, .055, .13], COLORS.woodDark, [0, Math.PI / 4, 0]);
    draw('cube', [x, .812, z], [.72, .055, .13], COLORS.woodDark, [0, -Math.PI / 4, 0]);
    draw('cube', [x, .39, z + .415], [.10, .58, .03], shade(COLORS.woodDark, .12), [0, 0, 0]);
  }

  function drawDeathBlock(x, z, now) {
    const pulse = .55 + .45 * Math.sin(now * .009 + x + z);
    draw('cube', [x, .50, z], [.88, 1, .88], COLORS.danger, [0, 0, 0], {
      emissive: shade(COLORS.dangerGlow, pulse * .25),
      shine: .25,
    });
    draw('torus', [x, 1.03, z], [.82, .82, .82], COLORS.dangerGlow, [0, 0, 0], {
      emissive: COLORS.dangerGlow,
      alpha: .45 + pulse * .35,
      blend: true,
      additive: true,
      unlit: true,
    });
    for (let spike = 0; spike < 4; spike += 1) {
      const angle = spike * Math.PI / 2 + Math.PI / 4;
      draw('cone', [x + Math.cos(angle) * .26, 1.18, z + Math.sin(angle) * .26], [.16, .34, .16], COLORS.dangerGlow, [0, 0, 0], {
        emissive: COLORS.dangerGlow,
      });
    }
  }

  function drawGridObjects(state, now) {
    for (let y = 0; y < state.rows; y += 1) {
      for (let x = 0; x < state.cols; x += 1) {
        const cell = state.grid[y * state.cols + x];
        if (!cell) continue;
        const worldX = cellCenterX(x, state.cols);
        const worldZ = cellCenterZ(y, state.rows);
        if (cell === 1) drawWall(worldX, worldZ, now);
        else if (cell === 2) drawCrate(worldX, worldZ, y * state.cols + x);
        else if (cell === 3) drawDeathBlock(worldX, worldZ, now);
      }
    }
  }

  function drawPowerups(state, now) {
    for (const item of state.powerups || []) {
      const x = cellCenterX(item.x, state.cols);
      const z = cellCenterZ(item.y, state.rows);
      const color = POWER_COLORS[item.type] || POWER_COLORS.range;
      const bob = .48 + Math.sin(now * .0045 + item.x * .7 + item.y) * .08;
      drawShadow(x, z, .34, .18);
      draw('cylinder', [x, .10, z], [.48, .10, .48], '#20262d', [0, 0, 0], { shine: .62 });
      draw('torus', [x, .18, z], [.54, .54, .54], color, [0, now * .0011, 0], {
        emissive: shade(color, -.62), alpha: .42, blend: true, unlit: true,
      });
      if (item.type === 'bomb' || item.type === 'mega') {
        const scale = item.type === 'mega' ? .45 : .38;
        draw('sphere', [x, bob, z], [scale, scale, scale], COLORS.bomb, [0, now * .0008, 0], { shine: .88 });
        draw('cylinder', [x, bob + scale * .76, z], [.095, .13, .095], '#656d75', [0, 0, 0], { shine: .92 });
        if (item.type === 'mega') {
          draw('torus', [x, bob, z], [scale * 1.02, scale * 1.02, scale * 1.02], COLORS.megaStripe, [Math.PI / 2, 0, 0], { shine: .55 });
        }
      } else if (item.type === 'speed' || item.type === 'kick') {
        const bootColor = item.type === 'kick' ? '#315f9c' : '#356b54';
        draw('cube', [x + .05, bob - .04, z + .04], [.43, .19, .29], bootColor, [0, -.35, 0], { shine: .34 });
        draw('cube', [x - .10, bob + .15, z - .02], [.20, .32, .25], shade(bootColor, -.22), [0, -.35, 0], { shine: .28 });
        draw('cube', [x + .17, bob - .13, z + .02], [.28, .07, .33], '#1b2026', [0, -.35, 0], { shine: .18 });
      } else if (item.type === 'remote') {
        draw('cube', [x, bob, z], [.34, .45, .18], '#252a31', [.12, now * .0008, 0], { shine: .72 });
        draw('sphere', [x, bob + .13, z + .20], [.075, .075, .045], '#b52d45', [0, 0, 0], { emissive: '#4b0d19', shine: .8 });
        draw('cylinder', [x + .20, bob + .36, z], [.025, .30, .025], '#8b9298', [0, 0, -.22], { shine: .95 });
      } else if (item.type === 'piercing') {
        draw('cone', [x, bob, z], [.30, .64, .30], '#aeb7bf', [0, 0, Math.PI / 2], { shine: .95 });
        draw('cylinder', [x - .28, bob, z], [.20, .20, .20], '#3a424a', [0, 0, Math.PI / 2], { shine: .55 });
      } else if (item.type === 'line') {
        for (let offset = -1; offset <= 1; offset += 1) {
          draw('sphere', [x + offset * .28, bob, z], [.20, .20, .20], COLORS.bomb, [0, 0, 0], { shine: .82 });
          draw('cylinder', [x + offset * .28, bob + .17, z], [.035, .08, .035], '#6b7177', [0, 0, 0], { shine: .8 });
        }
      } else {
        draw('cylinder', [x, bob, z], [.26, .54, .26], '#41484e', [0, now * .0007, 0], { shine: .76 });
        draw('cone', [x, bob + .42, z], [.30, .42, .30], color, [0, now * .0011, 0], { emissive: shade(color, -.48), shine: .62 });
      }
    }
  }

  function drawBombs(state, displayBombs, serverNow, now) {
    for (const bomb of state.bombs || []) {
      const display = displayBombs?.get?.(bomb.id) || bomb;
      const x = gridToWorldX(display.x, state.cols);
      const z = gridToWorldZ(display.y, state.rows);
      const remaining = bomb.explodeAt ? Math.max(0, Math.min(1, (bomb.explodeAt - serverNow) / 2200)) : .55;
      const urgency = bomb.remote ? .08 : 1 - remaining;
      const pulse = 1 + Math.sin(now * (.006 + urgency * .014)) * (.025 + urgency * .065);
      const size = (bomb.mega ? .82 : .66) * pulse;
      const body = bomb.mega ? COLORS.mega : COLORS.bomb;
      const stripe = bomb.mega ? COLORS.megaStripe : COLORS.bombStripe;
      drawShadow(x, z, bomb.mega ? .46 : .38, .30);
      draw('sphere', [x, .43, z], [size, size, size], body, [0, now * .00045, 0], { shine: .62 });
      draw('torus', [x, .43, z], [size * 1.02, size * 1.02, size * 1.02], stripe, [Math.PI / 2, 0, 0], {
        emissive: shade(stripe, -.55),
        shine: .4,
      });
      draw('torus', [x, .43, z], [size * .78, size * 1.01, size * .78], stripe, [0, 0, Math.PI / 2], {
        emissive: shade(stripe, -.55),
        shine: .4,
      });
      draw('cylinder', [x + .04, .84, z - .01], [.065, .34, .065], COLORS.fuse, [0, 0, -.28]);
      draw('cylinder', [x, .78, z], [.14, .13, .14], '#626a72', [0, 0, 0], { shine: .92 });
      const sparkColor = bomb.remote ? POWER_COLORS.remote : COLORS.spark;
      const sparkPulse = .13 + urgency * .12 + Math.sin(now * .025) * .025;
      draw('sphere', [x + .13, 1.02, z - .01], [sparkPulse, sparkPulse, sparkPulse], sparkColor, [0, 0, 0], {
        emissive: sparkColor,
        alpha: .82,
        blend: true,
        additive: true,
        unlit: true,
      });
    }
  }

  function movementAngle(player) {
    const movingX = player.moveX || 0;
    const movingY = player.moveY || 0;
    const x = Math.abs(movingX) + Math.abs(movingY) >= .01 ? movingX : (player.facingX || 0);
    const y = Math.abs(movingX) + Math.abs(movingY) >= .01 ? movingY : (player.facingY || 1);
    return Math.atan2(x, y);
  }

  function orientedOffset(turn, localX, localZ) {
    const cosine = Math.cos(turn);
    const sine = Math.sin(turn);
    return [localX * cosine + localZ * sine, -localX * sine + localZ * cosine];
  }

  function drawPlayerCharacter(player, display, state, now) {
    const x = gridToWorldX(display.x, state.cols);
    const z = gridToWorldZ(display.y, state.rows);
    const moving = Math.abs(player.moveX || 0) + Math.abs(player.moveY || 0) > .01;
    const bob = player.alive ? Math.sin(now * .009 + (display.bob || 0)) * (moving ? .035 : .018) : 0;
    const bodyColor = player.color || '#b7ef4a';
    if (!player.alive) {
      drawShadow(x, z, .42, .20);
      draw('sphere', [x, .17, z], [.72, .20, .72], shade(bodyColor, -.58), [0, movementAngle(player), 0], { alpha: .55, blend: true });
      draw('cube', [x, .34, z], [.62, .055, .09], COLORS.white, [0, Math.PI / 4, 0], { alpha: .72, blend: true, unlit: true });
      draw('cube', [x, .34, z], [.62, .055, .09], COLORS.white, [0, -Math.PI / 4, 0], { alpha: .72, blend: true, unlit: true });
      return;
    }

    drawShadow(x, z, .42, player.id === window.__ffaSocketId ? .34 : .27);
    if (player.id === window.__ffaSocketId) {
      draw('torus', [x, .055, z], [1.05, 1.05, 1.05], bodyColor, [0, now * .0012, 0], {
        emissive: shade(bodyColor, -.25),
        alpha: .64,
        blend: true,
        additive: true,
        unlit: true,
      });
    }

    const turn = movementAngle(player);
    const bodyY = .48 + bob;
    draw('sphere', [x, bodyY, z], [.68, .72, .68], bodyColor, [0, turn, 0], { shine: .68 });
    const leftEye = orientedOffset(turn, -.13, .285);
    const rightEye = orientedOffset(turn, .13, .285);
    const leftPupil = orientedOffset(turn, -.13, .333);
    const rightPupil = orientedOffset(turn, .13, .333);
    draw('sphere', [x + leftEye[0], bodyY + .13, z + leftEye[1]], [.11, .15, .075], COLORS.white, [0, turn, 0], { shine: .9 });
    draw('sphere', [x + rightEye[0], bodyY + .13, z + rightEye[1]], [.11, .15, .075], COLORS.white, [0, turn, 0], { shine: .9 });
    draw('sphere', [x + leftPupil[0], bodyY + .13, z + leftPupil[1]], [.047, .065, .035], COLORS.black, [0, turn, 0], { shine: .25 });
    draw('sphere', [x + rightPupil[0], bodyY + .13, z + rightPupil[1]], [.047, .065, .035], COLORS.black, [0, turn, 0], { shine: .25 });
    draw('cylinder', [x, bodyY + .46, z], [.055, .22, .055], '#5c3a21', [0, 0, -.2]);
    draw('lowSphere', [x + .16, bodyY + .55, z], [.42, .12, .22], COLORS.leafLight, [0, -.55, .25], { shine: .16 });
    draw('lowSphere', [x - .09, bodyY + .55, z - .02], [.34, .10, .18], COLORS.leaf, [0, .7, -.2], { shine: .16 });
    if (moving) {
      const stride = Math.sin(now * .016) * .12;
      const leftFoot = orientedOffset(turn, -.23, .06);
      const rightFoot = orientedOffset(turn, .23, .06);
      draw('sphere', [x + leftFoot[0], .15 + Math.max(0, stride), z + leftFoot[1]], [.22, .18, .28], shade(bodyColor, -.35), [0, turn, 0], { shine: .2 });
      draw('sphere', [x + rightFoot[0], .15 + Math.max(0, -stride), z + rightFoot[1]], [.22, .18, .28], shade(bodyColor, -.35), [0, turn, 0], { shine: .2 });
    }
  }

  function syncLabels(state, displayPlayers) {
    if (!labelLayer) return;
    const active = new Set();
    for (const player of state.players || []) {
      active.add(player.id);
      let label = playerLabels.get(player.id);
      if (!label) {
        label = document.createElement('div');
        label.className = 'world-player-label';
        label.innerHTML = '<span></span><strong></strong>';
        labelLayer.appendChild(label);
        playerLabels.set(player.id, label);
      }
      label.querySelector('span').style.background = player.color;
      label.querySelector('strong').textContent = player.name;
      label.classList.toggle('dead', !player.alive);
      label.classList.toggle('local', player.id === window.__ffaSocketId);
      const display = displayPlayers?.get?.(player.id) || player;
      const projected = transformPoint(viewProjection, [
        gridToWorldX(display.x, state.cols),
        player.alive ? 1.45 : .65,
        gridToWorldZ(display.y, state.rows),
      ]);
      const visible = projected[3] > 0 && projected[2] > -1 && projected[2] < 1;
      label.style.display = visible ? 'flex' : 'none';
      if (visible) {
        label.style.transform = `translate(-50%, -100%) translate(${(projected[0] * .5 + .5) * width}px, ${(-projected[1] * .5 + .5) * height}px)`;
      }
    }
    for (const [id, label] of playerLabels) {
      if (active.has(id)) continue;
      label.remove();
      playerLabels.delete(id);
    }
  }

  function drawPlayers(state, displayPlayers, now) {
    const sorted = [...(state.players || [])].sort((a, b) => a.y - b.y);
    for (const player of sorted) {
      const display = displayPlayers?.get?.(player.id) || player;
      drawPlayerCharacter(player, display, state, now);
    }
    syncLabels(state, displayPlayers);
  }

  function drawFlames(state, serverNow, now) {
    for (const flame of state.flames || []) {
      const life = Math.max(0, Math.min(1, (flame.until - serverNow) / 520));
      const x = cellCenterX(flame.x, state.cols);
      const z = cellCenterZ(flame.y, state.rows);
      const flicker = .88 + Math.sin(now * .025 + flame.x * 2 + flame.y) * .12;
      const scale = (.74 + (1 - life) * .18) * flicker;
      const color = flame.mega ? COLORS.dangerGlow : COLORS.flame;
      draw('sphere', [x, .34, z], [scale, .68 * scale, scale], color, [0, now * .004, 0], {
        emissive: color,
        alpha: .62 * Math.min(1, life * 2.6),
        blend: true,
        additive: true,
        unlit: true,
      });
      draw('cone', [x, .72, z], [.44 * scale, .88 * scale, .44 * scale], COLORS.flameCore, [0, now * .003, 0], {
        emissive: COLORS.flameCore,
        alpha: .66 * Math.min(1, life * 3),
        blend: true,
        additive: true,
        unlit: true,
      });
    }
  }

  function updateEffects(dt) {
    shockwaves = shockwaves.filter((wave) => {
      wave.life -= dt;
      wave.radius += dt * (wave.mega ? 5.6 : 4.2);
      return wave.life > 0;
    });
    particles = particles.filter((particle) => {
      particle.life -= dt;
      particle.velocity[1] -= 3.6 * dt;
      particle.position[0] += particle.velocity[0] * dt;
      particle.position[1] += particle.velocity[1] * dt;
      particle.position[2] += particle.velocity[2] * dt;
      particle.rotation += particle.spin * dt;
      return particle.life > 0 && particle.position[1] > -.4;
    });
    deathBursts = deathBursts.filter((burst) => {
      burst.life -= dt;
      burst.radius += dt * 2.1;
      return burst.life > 0;
    });
  }

  function drawEffects() {
    for (const wave of shockwaves) {
      const progress = 1 - wave.life / wave.duration;
      const alpha = Math.max(0, 1 - progress) * (wave.mega ? .78 : .58);
      const color = wave.mega ? COLORS.dangerGlow : COLORS.spark;
      draw('torus', [wave.position[0], .075, wave.position[2]], [wave.radius, wave.radius, wave.radius], color, [0, 0, 0], {
        emissive: color,
        alpha,
        blend: true,
        additive: true,
        unlit: true,
      });
    }
    for (const particle of particles) {
      const alpha = Math.max(0, particle.life / particle.duration);
      draw(particle.mesh, particle.position, particle.scale, particle.color, [particle.rotation, particle.rotation * .7, particle.rotation * .35], {
        emissive: particle.emissive,
        alpha,
        blend: true,
        additive: particle.additive,
        unlit: particle.additive,
      });
    }
    for (const burst of deathBursts) {
      const alpha = Math.max(0, burst.life / burst.duration) * .55;
      draw('torus', [burst.position[0], .16, burst.position[2]], [burst.radius, burst.radius, burst.radius], burst.color, [0, 0, 0], {
        emissive: burst.color,
        alpha,
        blend: true,
        additive: true,
        unlit: true,
      });
    }
  }

  function configureCamera(state, shakeAmount = 0) {
    const cols = state?.cols || 15;
    const rows = state?.rows || 13;
    const aspect = Math.max(.35, width / Math.max(1, height));
    const fov = 40 * Math.PI / 180;
    const requiredVertical = Math.max(rows * .78 + 3.2, cols / aspect + 2.2);
    const distance = requiredVertical / (2 * Math.tan(fov / 2));
    const cameraDirection = normalize3([0, .82, .58]);
    const jitter = Math.min(.32, Math.max(0, shakeAmount || 0) * .018);
    cameraPosition = [
      (Math.random() - .5) * jitter,
      cameraDirection[1] * distance + (Math.random() - .5) * jitter,
      cameraDirection[2] * distance + (Math.random() - .5) * jitter,
    ];
    const projection = perspective4(fov, aspect, .1, 100);
    const view = lookAt4(cameraPosition, [0, .05, 0]);
    viewProjection = multiply4(projection, view);
    gl.uniformMatrix4fv(locations.viewProjection, false, viewProjection);
    gl.uniform3fv(locations.cameraPosition, new Float32Array(cameraPosition));
  }

  function probePresentedFrame() {
    if (framePresented || contextLost || !canvas.width || !canvas.height) return !contextLost;
    const points = [
      [0.5, 0.5], [0.38, 0.55], [0.62, 0.55], [0.5, 0.68],
    ];
    const pixel = new Uint8Array(4);
    let differsFromClear = false;
    for (const [nx, ny] of points) {
      const px = Math.max(0, Math.min(canvas.width - 1, Math.floor(canvas.width * nx)));
      const py = Math.max(0, Math.min(canvas.height - 1, Math.floor(canvas.height * ny)));
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      if (Math.abs(pixel[0] - clearRgb[0]) > 3
        || Math.abs(pixel[1] - clearRgb[1]) > 3
        || Math.abs(pixel[2] - clearRgb[2]) > 3) {
        differsFromClear = true;
        break;
      }
    }
    const error = gl.getError?.() || gl.NO_ERROR;
    if (error !== gl.NO_ERROR) {
      lastRenderError = `WebGL error ${error}`;
      return false;
    }
    if (differsFromClear) {
      framePresented = true;
      blankFrameChecks = 0;
      return true;
    }
    blankFrameChecks += 1;
    if (blankFrameChecks >= 4) {
      lastRenderError = 'The 3D canvas remained blank after the round began.';
      return false;
    }
    return true;
  }

  function renderFrame(payload = {}) {
    if (contextLost || gl.isContextLost?.()) return false;
    const now = payload.animationTime || performance.now();
    const dt = Math.min(.05, Math.max(0, (now - lastTime) / 1000));
    lastTime = now;
    const state = payload.state;
    currentState = state || currentState;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!state) {
      configureCamera({ cols: 15, rows: 13 }, 0);
      return true;
    }

    ambientPulse += dt;
    configureCamera(state, payload.shake || 0);
    updateEffects(dt);
    drawEnvironment(state, now);
    drawGridObjects(state, now);
    drawPowerups(state, now);
    drawBombs(state, payload.displayBombs, payload.serverNow || 0, now);
    drawPlayers(state, payload.displayPlayers, now);
    drawFlames(state, payload.serverNow || 0, now);
    drawEffects();
    return probePresentedFrame();
  }

  function resize(nextWidth = window.innerWidth, nextHeight = window.innerHeight, nextDpr = Math.min(window.devicePixelRatio || 1, 1.5)) {
    width = Math.max(1, nextWidth);
    height = Math.max(1, nextHeight);
    dpr = Math.max(1, Math.min(1.5, nextDpr));
    const pixelWidth = Math.max(1, Math.floor(width * dpr));
    const pixelHeight = Math.max(1, Math.floor(height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    gl.viewport(0, 0, pixelWidth, pixelHeight);
  }

  function triggerExplosion(event = {}) {
    if (!currentState || !Number.isFinite(event.x) || !Number.isFinite(event.y)) return;
    const x = cellCenterX(event.x, currentState.cols);
    const z = cellCenterZ(event.y, currentState.rows);
    const mega = Boolean(event.mega);
    const duration = mega ? .72 : .52;
    shockwaves.push({
      position: [x, .06, z],
      radius: .24,
      life: duration,
      duration,
      mega,
    });
    const count = mega ? 28 : 16;
    const colors = mega
      ? [COLORS.dangerGlow, COLORS.megaStripe, COLORS.spark]
      : [COLORS.flame, COLORS.flameCore, COLORS.spark];
    for (let index = 0; index < count; index += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (mega ? 2.5 : 1.7) + Math.random() * (mega ? 3.3 : 2.2);
      const life = .45 + Math.random() * .55;
      particles.push({
        position: [x, .34 + Math.random() * .35, z],
        velocity: [Math.cos(angle) * speed, 1.5 + Math.random() * 3.1, Math.sin(angle) * speed],
        scale: [mega ? .16 : .11, mega ? .16 : .11, mega ? .16 : .11],
        color: colors[index % colors.length],
        emissive: colors[index % colors.length],
        mesh: index % 3 === 0 ? 'octahedron' : 'cube',
        rotation: Math.random() * Math.PI,
        spin: (Math.random() - .5) * 13,
        life,
        duration: life,
        additive: index % 2 === 0,
      });
    }
  }

  function triggerDeath(event = {}) {
    if (!currentState) return;
    const player = currentState.players?.find((candidate) => candidate.id === event.playerId);
    if (!player) return;
    const duration = .72;
    deathBursts.push({
      position: [gridToWorldX(player.x, currentState.cols), .12, gridToWorldZ(player.y, currentState.rows)],
      radius: .26,
      color: player.color || COLORS.dangerGlow,
      life: duration,
      duration,
    });
  }

  function reset() {
    particles = [];
    shockwaves = [];
    deathBursts = [];
    currentState = null;
    lastBoardSignature = '';
    for (const label of playerLabels.values()) label.remove();
    playerLabels.clear();
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  function resetRound() {
    particles = [];
    shockwaves = [];
    deathBursts = [];
    framePresented = false;
    blankFrameChecks = 0;
    lastRenderError = '';
  }

  resize();
  window.FFA3D = {
    available: true,
    resize,
    render: renderFrame,
    reset,
    triggerExplosion,
    triggerDeath,
    resetRound,
    getStatus() {
      return {
        available: true,
        healthy: !contextLost && !lastRenderError,
        framePresented,
        contextLost,
        message: lastRenderError,
        contextType: isWebGL2 ? 'webgl2' : 'webgl1',
      };
    },
  };
})();
