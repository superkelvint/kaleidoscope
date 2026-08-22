const canvas = document.querySelector("#gl");
const gl = canvas.getContext("webgl2", {
  antialias: true,
  preserveDrawingBuffer: true
});

if (!gl) {
  throw new Error("WebGL2 is not supported by this browser.");
}

const vertexSource = `#version 300 es
layout(location = 0) in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const feedbackFragmentSource = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_image;
uniform sampler2D u_prev;
uniform vec2 u_resolution;
uniform vec2 u_imageResolution;
uniform float u_segments;
uniform bool u_mirror;
uniform int u_symmetryMode;
uniform float u_twist;
uniform float u_zoom;
uniform float u_rotation;
uniform vec2 u_pan;
uniform vec2 u_center;
uniform float u_feedbackAmount;
uniform float u_feedbackZoom;
uniform float u_feedbackRotation;
uniform float u_hue;

const float PI = 3.141592653589793;
const float TAU = 6.283185307179586;

vec2 rotate2d(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c) * p;
}

vec2 radialFold(vec2 p, bool mirror, float twist) {
  float r = length(p);
  float a = atan(p.y, p.x) + r * twist;
  float wedge = TAU / max(u_segments, 2.0);
  a = mod(a + TAU, wedge);
  if (mirror) a = abs(a - wedge * 0.5);
  return vec2(cos(a), sin(a)) * r;
}

vec2 symmetryPoint(vec2 p) {
  float scale = max(u_segments, 2.0) * 0.25;

  // Radial retains the original repeat/mirror checkbox behavior. The
  // dedicated mirror-radial mode is the always-folded version.
  if (u_symmetryMode == 0) return radialFold(p, u_mirror, 0.0);
  if (u_symmetryMode == 1) return radialFold(p, true, 0.0);
  if (u_symmetryMode == 2) return radialFold(p, true, u_twist);
  if (u_symmetryMode == 3) {
    vec2 q = radialFold(p, true, u_twist);
    float rings = max(1.0, scale);
    return normalize(q + vec2(0.00001, 0.0)) * fract(length(q) * rings) / rings;
  }
  if (u_symmetryMode == 4) {
    vec2 q = p * scale;
    for (int i = 0; i < 3; i++) {
      q = abs(q);
      q = rotate2d(q, PI / 3.0);
      q = fract(q * 1.75) - 0.5;
    }
    return q / scale;
  }
  if (u_symmetryMode == 5) {
    return abs(fract(p * scale) - 0.5) / scale;
  }
  if (u_symmetryMode == 6) {
    vec2 q = p * scale;
    q.x *= 1.154700538;
    q.y += mod(floor(q.x), 2.0) * 0.5;
    q = fract(q) - 0.5;
    q.x *= 0.866025404;
    return abs(q) / scale;
  }
  return abs(fract(p * scale) - 0.5) / scale;
}

vec3 sampleKaleidoscope(vec2 uv) {
  vec2 p = uv - u_center;
  float canvasAspect = u_resolution.x / u_resolution.y;
  p.x *= canvasAspect;

  vec2 q = symmetryPoint(p);
  q = rotate2d(q, u_rotation);
  q.x /= canvasAspect;
  q /= max(u_zoom, 0.001);
  q += u_pan;
  q += vec2(0.5);

  float imageAspect = u_imageResolution.x / u_imageResolution.y;
  if (imageAspect > canvasAspect) {
    q.y = (q.y - 0.5) * (canvasAspect / imageAspect) + 0.5;
  } else {
    q.x = (q.x - 0.5) * (imageAspect / canvasAspect) + 0.5;
  }

  q = fract(q);
  return texture(u_image, q).rgb;
}

vec3 hueShift(vec3 color, float hue) {
  float angle = hue * TAU;
  float c = cos(angle);
  float s = sin(angle);
  mat3 rotation = mat3(
    0.299 + 0.701 * c + 0.168 * s, 0.587 - 0.587 * c + 0.330 * s, 0.114 - 0.114 * c - 0.497 * s,
    0.299 - 0.299 * c - 0.328 * s, 0.587 + 0.413 * c + 0.035 * s, 0.114 - 0.114 * c + 0.292 * s,
    0.299 - 0.300 * c + 1.250 * s, 0.587 - 0.588 * c - 1.050 * s, 0.114 + 0.886 * c - 0.203 * s
  );
  return clamp(rotation * color, 0.0, 1.0);
}

void main() {
  vec3 fresh = sampleKaleidoscope(v_uv);

  vec2 p = v_uv - u_center;
  float canvasAspect = u_resolution.x / u_resolution.y;
  p.x *= canvasAspect;
  p = rotate2d(p, u_feedbackRotation);
  p /= max(u_feedbackZoom, 0.001);
  p.x /= canvasAspect;

  vec2 feedbackUV = fract(p + u_center);
  vec3 prev = texture(u_prev, feedbackUV).rgb;

  vec3 color = mix(fresh, prev, u_feedbackAmount);
  color = hueShift(color, u_hue);
  outColor = vec4(color, 1.0);
}
`;

const blitFragmentSource = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;

void main() {
  outColor = texture(u_tex, v_uv);
}
`;

function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(info);
  }
  return shader;
}

function createProgram(vsSource, fsSource) {
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl.VERTEX_SHADER, vsSource));
  gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, fsSource));
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(info);
  }

  return program;
}

const feedbackProgram = createProgram(vertexSource, feedbackFragmentSource);
const blitProgram = createProgram(vertexSource, blitFragmentSource);

function getUniforms(program, names) {
  return Object.fromEntries(names.map(name => [name, gl.getUniformLocation(program, name)]));
}

const feedbackUniforms = getUniforms(feedbackProgram, [
  "u_image",
  "u_prev",
  "u_resolution",
  "u_imageResolution",
  "u_segments",
  "u_mirror",
  "u_symmetryMode",
  "u_twist",
  "u_zoom",
  "u_rotation",
  "u_pan",
  "u_center",
  "u_feedbackAmount",
  "u_feedbackZoom",
  "u_feedbackRotation",
  "u_hue"
]);

const blitUniforms = getUniforms(blitProgram, ["u_tex"]);

const positionLoc = gl.getAttribLocation(feedbackProgram, "a_position");
const blitPositionLoc = gl.getAttribLocation(blitProgram, "a_position");

const vao = gl.createVertexArray();
gl.bindVertexArray(vao);

const buffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
gl.bufferData(
  gl.ARRAY_BUFFER,
  new Float32Array([
    -1, -1,
     1, -1,
    -1,  1,
    -1,  1,
     1, -1,
     1,  1
  ]),
  gl.STATIC_DRAW
);

gl.enableVertexAttribArray(positionLoc);
gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

const blitVao = gl.createVertexArray();
gl.bindVertexArray(blitVao);
gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
gl.enableVertexAttribArray(blitPositionLoc);
gl.vertexAttribPointer(blitPositionLoc, 2, gl.FLOAT, false, 0, 0);

function createTexture2D() {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  return tex;
}

const sourceTexture = createTexture2D();
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
gl.texImage2D(
  gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE,
  new Uint8Array([
    40, 40, 40, 255,   70, 70, 70, 255,
    70, 70, 70, 255,   40, 40, 40, 255
  ])
);

let imageResolution = [2, 2];

function createRenderTarget(width, height) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

  return { texture, framebuffer, width, height };
}

let readTarget = null;
let writeTarget = null;

function destroyRenderTarget(target) {
  if (!target) return;
  gl.deleteFramebuffer(target.framebuffer);
  gl.deleteTexture(target.texture);
}

// A self-contained, LDR bloom post-process. It only receives the completed
// feedback texture and returns a separate composited texture, leaving the
// simulation targets and timeline behaviour untouched.
class BloomEffect {
  constructor(gl, { scale = 0.5 } = {}) {
    this.gl = gl;
    this.scale = scale;
    this.width = 0;
    this.height = 0;
    this.bloomWidth = 0;
    this.bloomHeight = 0;
    this.brightTarget = null;
    this.blurTargetA = null;
    this.blurTargetB = null;
    this.outputTarget = null;

    const vertex = `#version 300 es
layout(location = 0) in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

    this.brightProgram = this.createProgram(vertex, `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_scene;
uniform float u_threshold;
void main() {
  vec3 color = texture(u_scene, v_uv).rgb;
  float brightness = dot(color, vec3(0.2126, 0.7152, 0.0722));
  float contribution = smoothstep(u_threshold - 0.12, u_threshold + 0.12, brightness);
  outColor = vec4(color * contribution, 1.0);
}`);

    this.blurProgram = this.createProgram(vertex, `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_image;
uniform vec2 u_texelSize;
uniform vec2 u_direction;
uniform float u_radius;
void main() {
  vec2 stepUV = u_texelSize * u_direction * max(u_radius, 0.001);
  vec3 color = texture(u_image, v_uv).rgb * 0.227027;
  color += texture(u_image, v_uv + stepUV * 1.384615).rgb * 0.316216;
  color += texture(u_image, v_uv - stepUV * 1.384615).rgb * 0.316216;
  color += texture(u_image, v_uv + stepUV * 3.230769).rgb * 0.070270;
  color += texture(u_image, v_uv - stepUV * 3.230769).rgb * 0.070270;
  outColor = vec4(color, 1.0);
}`);

    this.compositeProgram = this.createProgram(vertex, `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float u_strength;
void main() {
  vec3 scene = texture(u_scene, v_uv).rgb;
  vec3 bloom = texture(u_bloom, v_uv).rgb;
  outColor = vec4(scene + bloom * u_strength, 1.0);
}`);

    this.brightUniforms = this.getUniforms(this.brightProgram, ["u_scene", "u_threshold"]);
    this.blurUniforms = this.getUniforms(this.blurProgram, ["u_image", "u_texelSize", "u_direction", "u_radius"]);
    this.compositeUniforms = this.getUniforms(this.compositeProgram, ["u_scene", "u_bloom", "u_strength"]);
    this.createFullscreenQuad();
  }

  createProgram(vertexSource, fragmentSource) {
    const gl = this.gl;
    const makeShader = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(info);
      }
      return shader;
    };
    const program = gl.createProgram();
    const vertex = makeShader(gl.VERTEX_SHADER, vertexSource);
    const fragment = makeShader(gl.FRAGMENT_SHADER, fragmentSource);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(info);
    }
    return program;
  }

  getUniforms(program, names) {
    return Object.fromEntries(names.map(name => [name, this.gl.getUniformLocation(program, name)]));
  }

  createFullscreenQuad() {
    const gl = this.gl;
    this.vao = gl.createVertexArray();
    this.buffer = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1, 1, 1, -1, 1, 1
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  createRenderTarget(width, height) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      throw new Error(`Bloom framebuffer incomplete: ${status}`);
    }
    return { texture, framebuffer, width, height };
  }

  destroyTarget(target) {
    if (!target) return;
    this.gl.deleteFramebuffer(target.framebuffer);
    this.gl.deleteTexture(target.texture);
  }

  destroyTargets() {
    this.destroyTarget(this.brightTarget);
    this.destroyTarget(this.blurTargetA);
    this.destroyTarget(this.blurTargetB);
    this.destroyTarget(this.outputTarget);
    this.brightTarget = this.blurTargetA = this.blurTargetB = this.outputTarget = null;
  }

  resize(width, height) {
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    const bloomWidth = Math.max(1, Math.floor(width * this.scale));
    const bloomHeight = Math.max(1, Math.floor(height * this.scale));
    if (width === this.width && height === this.height && bloomWidth === this.bloomWidth && bloomHeight === this.bloomHeight) return;
    this.width = width;
    this.height = height;
    this.bloomWidth = bloomWidth;
    this.bloomHeight = bloomHeight;
    this.destroyTargets();
    this.brightTarget = this.createRenderTarget(bloomWidth, bloomHeight);
    this.blurTargetA = this.createRenderTarget(bloomWidth, bloomHeight);
    this.blurTargetB = this.createRenderTarget(bloomWidth, bloomHeight);
    this.outputTarget = this.createRenderTarget(width, height);
  }

  draw(program, target, texture, uniforms) {
    const gl = this.gl;
    gl.useProgram(program);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    uniforms();
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  render(inputTexture, { threshold = 0.65, strength = 0.8, radius = 1.0, passes = 2 } = {}) {
    if (!this.outputTarget) throw new Error("BloomEffect.resize() must be called before render().");
    const gl = this.gl;
    this.draw(this.brightProgram, this.brightTarget, inputTexture, () => {
      gl.uniform1i(this.brightUniforms.u_scene, 0);
      gl.uniform1f(this.brightUniforms.u_threshold, threshold);
    });
    let texture = this.brightTarget.texture;
    for (let i = 0; i < Math.max(1, Math.floor(passes)); i++) {
      this.draw(this.blurProgram, this.blurTargetA, texture, () => {
        gl.uniform1i(this.blurUniforms.u_image, 0);
        gl.uniform2f(this.blurUniforms.u_texelSize, 1 / this.bloomWidth, 1 / this.bloomHeight);
        gl.uniform2f(this.blurUniforms.u_direction, 1, 0);
        gl.uniform1f(this.blurUniforms.u_radius, radius);
      });
      this.draw(this.blurProgram, this.blurTargetB, this.blurTargetA.texture, () => {
        gl.uniform1i(this.blurUniforms.u_image, 0);
        gl.uniform2f(this.blurUniforms.u_texelSize, 1 / this.bloomWidth, 1 / this.bloomHeight);
        gl.uniform2f(this.blurUniforms.u_direction, 0, 1);
        gl.uniform1f(this.blurUniforms.u_radius, radius);
      });
      texture = this.blurTargetB.texture;
    }
    this.draw(this.compositeProgram, this.outputTarget, inputTexture, () => {
      gl.uniform1i(this.compositeUniforms.u_scene, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(this.compositeUniforms.u_bloom, 1);
      gl.uniform1f(this.compositeUniforms.u_strength, strength);
    });
    return this.outputTarget.texture;
  }

  destroy() {
    const gl = this.gl;
    this.destroyTargets();
    gl.deleteProgram(this.brightProgram);
    gl.deleteProgram(this.blurProgram);
    gl.deleteProgram(this.compositeProgram);
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.buffer);
  }
}

const bloom = new BloomEffect(gl, { scale: 0.5 });

function resizeRenderTargets(width, height) {
  destroyRenderTarget(readTarget);
  destroyRenderTarget(writeTarget);
  readTarget = createRenderTarget(width, height);
  writeTarget = createRenderTarget(width, height);
  bloom.resize(width, height);
  clearFeedbackTargets();
}

function clearFeedbackTargets() {
  const targets = [readTarget, writeTarget];
  for (const target of targets) {
    if (!target) continue;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

const state = {
  segments: 12,
  mirror: true,
  symmetryMode: "mirrorRadial",
  twist: 0.0,
  zoom: 1.0,
  rotationDeg: 0.0,
  panX: 0.0,
  panY: 0.0,
  centerX: 0.5,
  centerY: 0.5,
  animate: true,
  speedDeg: 4.0,
  driftX: 0.0,
  driftY: 0.0,
  driftMode: "linear",
  driftSpeed: 0.20,
  pulseAmount: 0.0,
  pulseSpeed: 0.2,
  feedbackAmount: 0.0,
  feedbackZoom: 1.0,
  feedbackRotateDeg: 0.0,
  bloomStrength: 0.0,
  bloomThreshold: 0.60,
  bloomRadius: 1.5,
  hue: 0.0,
  motion: {
    zoom: { source: "none", speed: 0.15, amount: 0.15, phase: 0.0 },
    rotationDeg: { source: "none", speed: 0.10, amount: 20, phase: 0.0 },
    panX: { source: "none", speed: 0.12, amount: 0.12, phase: 0.0 },
    panY: { source: "none", speed: 0.12, amount: 0.12, phase: 0.25 },
    driftX: { source: "none", speed: 0.10, amount: 0.01, phase: 0.0 },
    driftY: { source: "none", speed: 0.10, amount: 0.01, phase: 0.25 },
    feedbackAmount: { source: "none", speed: 0.05, amount: 0.15, phase: 0.0 },
    hue: { source: "none", speed: 0.04, amount: 0.35, phase: 0.0 },
    segments: { source: "none", speed: 0.08, amount: 6, phase: 0.0 },
    twist: { source: "none", speed: 0.08, amount: 4, phase: 0.0 }
  },
  currentTime: 0.0,
  playing: false
};

const defaults = structuredClone(state);

const SYMMETRY_MODES = [
  "radial", "mirrorRadial", "spiral", "tunnel",
  "fractalFold", "tile", "hexagonal", "wallpaper"
];

const $ = id => document.getElementById(id);

// -----------------------------------------------------------------------------
// Local workspace persistence
// -----------------------------------------------------------------------------
//
// This layer is intentionally independent from the renderer. The WebGL image
// loading and timeline code below are unchanged from v0.7.

const WORKSPACE_STORAGE_KEY = "kaleidoscope.workspace.v10";
const LEGACY_IMAGE_STORAGE_KEY = "kaleidoscope.sourceImage.v10";
const IMAGE_DB_NAME = "kaleidoscope.workspace";
const IMAGE_DB_VERSION = 1;
const IMAGE_STORE_NAME = "source-images";
const SOURCE_IMAGE_KEY = "last-uploaded";
let persistenceTimer = null;
let persistenceEnabled = false;
let imageDbPromise = null;

function setPersistenceStatus(message) {
  const el = $("persistenceStatus");
  if (el) el.textContent = message;
}

function workspaceSnapshot() {
  return {
    state: {
      segments: state.segments,
      mirror: state.mirror,
      symmetryMode: state.symmetryMode,
      twist: state.twist,
      zoom: state.zoom,
      rotationDeg: state.rotationDeg,
      panX: state.panX,
      panY: state.panY,
      centerX: state.centerX,
      centerY: state.centerY,
      animate: state.animate,
      speedDeg: state.speedDeg,
      driftX: state.driftX,
      driftY: state.driftY,
      driftMode: state.driftMode,
      driftSpeed: state.driftSpeed,
      pulseAmount: state.pulseAmount,
      pulseSpeed: state.pulseSpeed,
      feedbackAmount: state.feedbackAmount,
      feedbackZoom: state.feedbackZoom,
      feedbackRotateDeg: state.feedbackRotateDeg,
      bloomStrength: state.bloomStrength,
      bloomThreshold: state.bloomThreshold,
      bloomRadius: state.bloomRadius,
      hue: state.hue,
      motion: state.motion,
      currentTime: state.currentTime,
      playing: state.playing
    },
    recordFps: Number($("recordFps")?.value) || 60
  };
}

function saveWorkspaceSettingsNow() {
  if (!persistenceEnabled) return;

  try {
    localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify(workspaceSnapshot())
    );
  } catch (error) {
    console.warn("Unable to save workspace settings", error);
    setPersistenceStatus("Browser storage is unavailable; workspace is not being saved.");
  }
}

function scheduleWorkspaceSave() {
  if (!persistenceEnabled) return;

  if (persistenceTimer !== null) {
    clearTimeout(persistenceTimer);
  }

  persistenceTimer = setTimeout(() => {
    persistenceTimer = null;
    saveWorkspaceSettingsNow();
  }, 150);
}

function restoreWorkspaceSettings() {
  let saved = null;

  try {
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (raw) saved = JSON.parse(raw);
  } catch (error) {
    console.warn("Unable to restore workspace settings", error);
  }

  if (!saved || !saved.state) {
    return false;
  }

  const s = saved.state;
  const numericKeys = [
    "segments", "twist", "zoom", "rotationDeg", "panX", "panY",
    "centerX", "centerY", "speedDeg", "driftX", "driftY",
    "driftSpeed", "pulseAmount", "pulseSpeed", "feedbackAmount",
    "feedbackZoom", "feedbackRotateDeg", "bloomStrength", "bloomThreshold",
    "bloomRadius", "hue", "currentTime"
  ];

  for (const key of numericKeys) {
    if (Number.isFinite(Number(s[key]))) {
      state[key] = Number(s[key]);
    }
  }

  if (typeof s.mirror === "boolean") state.mirror = s.mirror;
  if (SYMMETRY_MODES.includes(s.symmetryMode)) {
    state.symmetryMode = s.symmetryMode;
  } else {
    // Workspaces saved before symmetry modes used this checkbox as the mode.
    state.symmetryMode = state.mirror ? "mirrorRadial" : "radial";
  }
  if (typeof s.animate === "boolean") state.animate = s.animate;
  if (typeof s.playing === "boolean") state.playing = s.playing;

  if (["linear", "oscillate", "orbit", "smoothRandom"].includes(s.driftMode)) {
    state.driftMode = s.driftMode;
  }

  restoreMotionSettings(s.motion);

  setValue("segments", state.segments);
  setValue("twist", state.twist);
  setValue("zoom", state.zoom);
  setValue("rotation", state.rotationDeg);
  setValue("panX", state.panX);
  setValue("panY", state.panY);
  setValue("centerX", state.centerX);
  setValue("centerY", state.centerY);
  setValue("speed", state.speedDeg);
  setValue("driftX", state.driftX);
  setValue("driftY", state.driftY);
  setValue("driftSpeed", state.driftSpeed);
  setValue("pulseAmount", state.pulseAmount);
  setValue("pulseSpeed", state.pulseSpeed);
  setValue("feedbackAmount", state.feedbackAmount);
  setValue("feedbackZoom", state.feedbackZoom);
  setValue("feedbackRotate", state.feedbackRotateDeg);
  setValue("hue", state.hue);
  syncBloomControl("bloomStrength", "bloomStrength", state.bloomStrength);
  syncBloomControl("bloomThreshold", "bloomThreshold", state.bloomThreshold);
  syncBloomControl("bloomRadius", "bloomRadius", state.bloomRadius);
  syncMotionButtons();

  $("mirror").checked = state.mirror;
  $("symmetryMode").value = state.symmetryMode;
  $("animate").checked = state.animate;
  $("driftMode").value = state.driftMode;
  if (saved.recordFps === 30 || saved.recordFps === 60) {
    $("recordFps").value = String(saved.recordFps);
  }

  syncTimelineControls();
  return true;
}

function openImageDatabase() {
  if (imageDbPromise) return imageDbPromise;

  imageDbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB is not supported by this browser."));
      return;
    }

    const request = window.indexedDB.open(IMAGE_DB_NAME, IMAGE_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IMAGE_STORE_NAME)) {
        db.createObjectStore(IMAGE_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB is blocked by another tab."));
  });

  return imageDbPromise;
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function saveSourceImageToDatabase(source) {
  const db = await openImageDatabase();
  const transaction = db.transaction(IMAGE_STORE_NAME, "readwrite");
  transaction.objectStore(IMAGE_STORE_NAME).put(source, SOURCE_IMAGE_KEY);
  await transactionComplete(transaction);
}

async function readSourceImageFromDatabase() {
  const db = await openImageDatabase();
  const transaction = db.transaction(IMAGE_STORE_NAME, "readonly");
  const request = transaction.objectStore(IMAGE_STORE_NAME).get(SOURCE_IMAGE_KEY);

  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function saveSourceImage(file) {
  if (!file || !file.type || !file.type.startsWith("image/")) return;

  try {
    await saveSourceImageToDatabase(file);
    setPersistenceStatus("Workspace and source image saved in this browser.");
  } catch (error) {
    console.warn("Unable to save source image", error);
    setPersistenceStatus("Settings are saved, but the source image could not be saved.");
  }
}

function readLegacySourceImage() {
  try {
    return localStorage.getItem(LEGACY_IMAGE_STORAGE_KEY);
  } catch (error) {
    console.warn("Unable to read legacy source image", error);
    return null;
  }
}

async function migrateLegacySourceImage(dataUrl) {
  const response = await fetch(dataUrl);
  const source = await response.blob();
  if (!source.type.startsWith("image/")) {
    throw new Error("The legacy source image has an invalid type.");
  }

  await saveSourceImageToDatabase(source);
  localStorage.removeItem(LEGACY_IMAGE_STORAGE_KEY);
}

function restoreSourceImageInBackground() {
  // Run only after the renderer has already started. Persistence can never
  // block the application's core image path.
  setTimeout(async () => {
    try {
      const source = await readSourceImageFromDatabase();
      if (source) {
        await loadImage(source);
        setPersistenceStatus("Previous workspace restored.");
        return;
      }

      const legacySource = readLegacySourceImage();
      if (!legacySource) return;

      await loadImage(legacySource);

      try {
        await migrateLegacySourceImage(legacySource);
        setPersistenceStatus("Previous workspace restored and image migrated to IndexedDB.");
      } catch (migrationError) {
        console.warn("Unable to migrate legacy source image", migrationError);
        setPersistenceStatus(
          "Previous workspace restored; source image will move to IndexedDB after next upload."
        );
      }
    } catch (error) {
      console.warn("Unable to decode saved source image", error);
      setPersistenceStatus("Settings restored; saved source image could not be decoded.");
    }
  }, 0);
}

function attachPersistenceListeners() {
  // These are additional listeners only. They do not replace or wrap any of
  // the renderer's existing handlers.
  document.addEventListener("input", scheduleWorkspaceSave, true);
  document.addEventListener("change", scheduleWorkspaceSave, true);
  document.addEventListener("click", event => {
    if (event.target.closest("button")) scheduleWorkspaceSave();
  }, true);

  $("file").addEventListener("change", event => {
    const file = event.target.files?.[0];
    if (file) saveSourceImage(file);
  });

  canvas.addEventListener("drop", event => {
    const file = event.dataTransfer?.files?.[0];
    if (file) saveSourceImage(file);
  });

  // Keep the moving timeline position current while playback is running.
  setInterval(() => {
    if (state.playing) saveWorkspaceSettingsNow();
  }, 1000);

  window.addEventListener("pagehide", saveWorkspaceSettingsNow);
  window.addEventListener("beforeunload", saveWorkspaceSettingsNow);
}

let sceneDirty = true;
// Pan and zoom need to remain responsive even when the current timeline time
// has a long feedback history. These changes are drawn as one live frame while
// the gesture is active; the complete feedback history is rebuilt once the
// gesture ends.
let liveInteractionDirty = false;
let feedbackRebuildPending = false;
let feedbackRebuildTimer = null;

function markSceneDirty() {
  sceneDirty = true;
}

function forceSceneRebuild() {
  if (feedbackRebuildTimer !== null) {
    clearTimeout(feedbackRebuildTimer);
    feedbackRebuildTimer = null;
  }
  liveInteractionDirty = false;
  feedbackRebuildPending = false;
  markSceneDirty();
}

function markLiveInteractionDirty() {
  sceneDirty = false;
  liveInteractionDirty = true;
  feedbackRebuildPending = true;
}

function queueFeedbackRebuild() {
  if (feedbackRebuildTimer !== null) {
    clearTimeout(feedbackRebuildTimer);
  }

  feedbackRebuildTimer = setTimeout(() => {
    feedbackRebuildTimer = null;
    if (!feedbackRebuildPending) return;
    feedbackRebuildPending = false;
    forceSceneRebuild();
  }, 150);
}

function previewSceneChange() {
  markLiveInteractionDirty();
  queueFeedbackRebuild();
}

function bindRange(id, key, format, { livePreview = true } = {}) {
  const input = $(id);
  const num = $(id + "Num");
  const out = $(id + "Out");

  const clampToInputBounds = value => {
    let v = Number(value);
    if (!Number.isFinite(v)) return Number(input.value);
    const min = input.min === "" ? -Infinity : Number(input.min);
    const max = input.max === "" ? Infinity : Number(input.max);
    if (v < min) v = min;
    if (v > max) v = max;
    return v;
  };

  const applyValue = (rawValue, source) => {
    const v = clampToInputBounds(rawValue);
    state[key] = v;
    input.value = String(v);
    if (num) num.value = String(v);
    out.value = format(state[key]);

    // If the user is typing in the number box, keep that field canonicalized
    // without disturbing the rest of the sync logic.
    if (source === "num" && num) {
      num.value = String(v);
    }

    if (livePreview && source !== "initial") {
      previewSceneChange();
    } else {
      markSceneDirty();
    }
  };

  input.addEventListener("input", () => applyValue(input.value, "range"));

  if (num) {
    num.addEventListener("input", () => applyValue(num.value, "num"));
    num.addEventListener("change", () => applyValue(num.value, "num"));
  }

  applyValue(input.value, "initial");
}

bindRange("segments", "segments", v => String(Math.round(v)));
bindRange("twist", "twist", v => v.toFixed(2));
bindRange("zoom", "zoom", v => v.toFixed(2));
bindRange("rotation", "rotationDeg", v => `${v.toFixed(1)}°`);
bindRange("panX", "panX", v => v.toFixed(2));
bindRange("panY", "panY", v => v.toFixed(2));
bindRange("centerX", "centerX", v => v.toFixed(2));
bindRange("centerY", "centerY", v => v.toFixed(2));
bindRange("speed", "speedDeg", v => `${v.toFixed(1)}°/s`);
bindRange("driftX", "driftX", v => v.toFixed(2));
bindRange("driftY", "driftY", v => v.toFixed(2));
bindRange("driftSpeed", "driftSpeed", v => `${v.toFixed(2)} Hz`);
bindRange("pulseAmount", "pulseAmount", v => v.toFixed(2));
bindRange("pulseSpeed", "pulseSpeed", v => `${v.toFixed(2)} Hz`);
bindRange("feedbackAmount", "feedbackAmount", v => v.toFixed(2));
bindRange("feedbackZoom", "feedbackZoom", v => v.toFixed(3));
bindRange("feedbackRotate", "feedbackRotateDeg", v => `${v.toFixed(2)}°`);
bindRange("hue", "hue", v => v.toFixed(2));

const motionMetadata = {
  zoom: { label: "Zoom", amountMin: 0, amountMax: 0.75, amountStep: 0.01 },
  rotationDeg: { label: "Rotation", amountMin: 0, amountMax: 180, amountStep: 1 },
  panX: { label: "Pan X", amountMin: 0, amountMax: 0.5, amountStep: 0.005 },
  panY: { label: "Pan Y", amountMin: 0, amountMax: 0.5, amountStep: 0.005 },
  driftX: { label: "Drift X", amountMin: 0, amountMax: 0.08, amountStep: 0.001 },
  driftY: { label: "Drift Y", amountMin: 0, amountMax: 0.08, amountStep: 0.001 },
  feedbackAmount: { label: "Feedback amount", amountMin: 0, amountMax: 0.98, amountStep: 0.01 },
  hue: { label: "Hue", amountMin: 0, amountMax: 1, amountStep: 0.01 },
  segments: { label: "Segments", amountMin: 0, amountMax: 16, amountStep: 1 },
  twist: { label: "Twist", amountMin: 0, amountMax: 12, amountStep: 0.1 }
};
let motionEditorTarget = null;

function formatMotionAmount(key, value) {
  return key === "rotationDeg" ? `${value.toFixed(0)}°` : value.toFixed(2);
}

function motionBaseDescription(key, motion) {
  const baseValue = formatMotionAmount(key, state[key]);
  if (key === "driftX" || key === "driftY") {
    if (motion.source !== "none") {
      return `Base drift amplitude: ${baseValue}. This source adds a bounded offset of ±${formatMotionAmount(key, motion.amount)}.`;
    }
    return `Base drift amplitude: ${baseValue}. Drift mode and Drift speed move this base; modulation is currently off.`;
  }

  if (motion.source !== "none") {
    return `Base value: ${baseValue}. This source varies it by ±${formatMotionAmount(key, motion.amount)}.`;
  }

  return `Base value: ${baseValue}. Modulation is currently off.`;
}

function previewMotionChange() {
  previewSceneChange();
}

function syncMotionEditor() {
  if (!motionEditorTarget) return;
  const key = motionEditorTarget;
  const motion = state.motion[key];
  const meta = motionMetadata[key];
  $("motionTargetName").textContent = meta.label;
  $("motionAmount").min = String(meta.amountMin);
  $("motionAmount").max = String(meta.amountMax);
  $("motionAmount").step = String(meta.amountStep);
  $("motionSpeed").value = String(motion.speed);
  $("motionAmount").value = String(motion.amount);
  $("motionPhase").value = String(motion.phase);
  $("motionSpeedOut").value = `${motion.speed.toFixed(2)} Hz`;
  $("motionAmountOut").value = formatMotionAmount(key, motion.amount);
  $("motionPhaseOut").value = motion.phase.toFixed(2);
  const selected = document.querySelector(`input[name="motionSource"][value="${motion.source}"]`);
  if (selected) selected.checked = true;
  $("motionBaseDescription").textContent = motionBaseDescription(key, motion);
  $("motionSourceControls").hidden = motion.source === "none";
  syncMotionButtons();
}

function syncMotionButtons() {
  document.querySelectorAll(".motionButton").forEach(button => {
    button.classList.toggle("active", state.motion[button.dataset.motion].source !== "none");
  });
}

function positionMotionEditor(button) {
  const editor = $("motionEditor");
  const anchor = button.getBoundingClientRect();
  const margin = 8;
  const width = editor.offsetWidth;
  const height = editor.offsetHeight;
  const left = Math.min(window.innerWidth - width - margin, Math.max(margin, anchor.left));
  let top = anchor.bottom + margin;

  // If there is not enough room below the control, keep the popover adjacent
  // by placing it immediately above instead.
  if (top + height > window.innerHeight - margin) {
    top = Math.max(margin, anchor.top - height - margin);
  }

  editor.style.left = `${left}px`;
  editor.style.top = `${top}px`;
}

function openMotionEditor(key, button) {
  if (!motionMetadata[key]) return;
  motionEditorTarget = key;
  $("motionEditor").hidden = false;
  syncMotionEditor();
  positionMotionEditor(button);
}

document.querySelectorAll(".motionButton").forEach(button => {
  button.addEventListener("click", () => openMotionEditor(button.dataset.motion, button));
});

$("closeMotionEditor").addEventListener("click", () => {
  $("motionEditor").hidden = true;
  motionEditorTarget = null;
});

function dismissMotionEditorFromOutside(event) {
  const editor = $("motionEditor");
  if (editor.hidden || editor.contains(event.target) || event.target.closest(".motionButton")) return;
  editor.hidden = true;
  motionEditorTarget = null;
}

// Capture pointer input before the canvas/timeline handlers claim it. This is
// more reliable than waiting for a synthetic click after a drag interaction.
document.addEventListener("pointerdown", dismissMotionEditorFromOutside, true);
document.addEventListener("click", dismissMotionEditorFromOutside, true);
window.addEventListener("resize", () => { $("motionEditor").hidden = true; });
document.addEventListener("scroll", () => { $("motionEditor").hidden = true; }, true);

document.querySelectorAll('input[name="motionSource"]').forEach(input => {
  input.addEventListener("change", () => {
    if (!motionEditorTarget || !input.checked) return;
    state.motion[motionEditorTarget].source = input.value;
    syncMotionEditor();
    previewMotionChange();
  });
});

function bindMotionEditorRange(id, field) {
  $(id).addEventListener("input", event => {
    if (!motionEditorTarget) return;
    state.motion[motionEditorTarget][field] = Number(event.target.value);
    syncMotionEditor();
    previewMotionChange();
  });
}

bindMotionEditorRange("motionSpeed", "speed");
bindMotionEditorRange("motionAmount", "amount");
bindMotionEditorRange("motionPhase", "phase");

function syncBloomControl(id, key, value, render = false) {
  const input = $(id);
  const min = Number(input.min);
  const max = Number(input.max);
  const parsed = Number(value);
  const safeValue = Number.isFinite(parsed) ? parsed : Number(input.value);
  const clamped = Math.min(max, Math.max(min, safeValue));
  state[key] = clamped;
  input.value = String(clamped);

  // Bloom is a final post-process, so adjusting it should never rebuild the
  // feedback history. Re-composite the already completed frame instead.
  if (render && readTarget) presentCurrentFrame();
}

function bindBloomRange(id, key) {
  const input = $(id);
  input.addEventListener("input", () => syncBloomControl(id, key, input.value, true));
  syncBloomControl(id, key, input.value);
}

bindBloomRange("bloomStrength", "bloomStrength");
bindBloomRange("bloomThreshold", "bloomThreshold");
bindBloomRange("bloomRadius", "bloomRadius");

$("mirror").addEventListener("change", e => {
  state.mirror = e.target.checked;
  previewSceneChange();
});

$("symmetryMode").addEventListener("change", e => {
  state.symmetryMode = e.target.value;
  previewSceneChange();
});

$("animate").addEventListener("change", e => {
  state.animate = e.target.checked;
  previewSceneChange();
});

$("driftMode").addEventListener("change", e => {
  state.driftMode = e.target.value;
  previewSceneChange();
});

function setValue(id, value) {
  $(id).value = value;
  $(id).dispatchEvent(new Event("input"));
}

function setSelectValue(id, value) {
  $(id).value = value;
  $(id).dispatchEvent(new Event("change"));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

const TIMELINE_HALF_WINDOW = 30;
let lastTimelineTickSecond = null;

function renderTimelineTicks() {
  const centerSecond = Math.round(state.currentTime);
  if (centerSecond === lastTimelineTickSecond) return;
  lastTimelineTickSecond = centerSecond;

  const ticks = $("timelineTicks");
  const fragment = document.createDocumentFragment();

  for (let offset = -TIMELINE_HALF_WINDOW; offset <= TIMELINE_HALF_WINDOW; offset += 5) {
    const tick = document.createElement("div");
    tick.className = "timelineTick";
    tick.style.left = `${((offset + TIMELINE_HALF_WINDOW) / (TIMELINE_HALF_WINDOW * 2)) * 100}%`;

    const label = document.createElement("span");
    label.textContent = `${centerSecond + offset}s`;
    tick.append(label);
    fragment.append(tick);
  }

  ticks.replaceChildren(fragment);
}

function syncTimelineControls() {
  $("timelineNum").value = state.currentTime.toFixed(2);
  $("timelineOut").value = `${state.currentTime.toFixed(2)} s`;
  $("playPause").textContent = state.playing ? "Pause" : "Play";
  $("timeline").setAttribute("aria-valuenow", String(state.currentTime));
  $("timeline").setAttribute("aria-valuetext", `${state.currentTime.toFixed(2)} seconds`);
  renderTimelineTicks();
}

function requestSeekToTime(time, { pause = false, livePreview = false } = {}) {
  const nextTime = Number(time);
  if (!Number.isFinite(nextTime)) return;
  state.currentTime = nextTime;
  if (pause) {
    state.playing = false;
  }
  syncTimelineControls();

  if (livePreview) {
    previewSceneChange();
  } else {
    forceSceneRebuild();
  }
}

$("timelineNum").addEventListener("input", () => {
  requestSeekToTime($("timelineNum").value, { pause: true, livePreview: true });
});

$("timelineNum").addEventListener("change", () => {
  requestSeekToTime($("timelineNum").value, { pause: true });
});

let timelinePointer = null;

$("timeline").addEventListener("pointerdown", event => {
  const timeline = $("timeline");
  timelinePointer = {
    id: event.pointerId,
    startX: event.clientX,
    startTime: state.currentTime
  };
  timeline.setPointerCapture(event.pointerId);
  event.preventDefault();
});

$("timeline").addEventListener("pointermove", event => {
  if (!timelinePointer || event.pointerId !== timelinePointer.id) return;
  const rect = $("timeline").getBoundingClientRect();
  const secondsPerPixel = (TIMELINE_HALF_WINDOW * 2) / Math.max(rect.width, 1);
  const time = timelinePointer.startTime + (event.clientX - timelinePointer.startX) * secondsPerPixel;
  requestSeekToTime(time, { pause: true, livePreview: true });
});

function finishTimelineDrag(event) {
  if (!timelinePointer || event.pointerId !== timelinePointer.id) return;
  timelinePointer = null;
  requestSeekToTime(state.currentTime, { pause: true });
}

$("timeline").addEventListener("pointerup", finishTimelineDrag);
$("timeline").addEventListener("pointercancel", finishTimelineDrag);
$("timeline").addEventListener("keydown", event => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const delta = event.key === "ArrowLeft" ? -1 : 1;
  requestSeekToTime(state.currentTime + delta, { pause: true, livePreview: true });
});

function togglePlayback() {
  state.playing = !state.playing;
  syncTimelineControls();
}

$("playPause").addEventListener("click", togglePlayback);

document.addEventListener("keydown", event => {
  if (event.code !== "Space" || event.repeat) return;

  const target = event.target;
  const isEditing = target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement ||
    target?.isContentEditable;

  if (isEditing) return;

  event.preventDefault();
  togglePlayback();
});

$("stepBack").addEventListener("click", () => {
  requestSeekToTime(state.currentTime - 1, { pause: true });
});

$("stepForward").addEventListener("click", () => {
  requestSeekToTime(state.currentTime + 1, { pause: true });
});

function loadImage(source) {
  const isDataUrl = typeof source === "string" && source.startsWith("data:image/");
  const isImageFile = source && typeof source.type === "string" &&
    source.type.startsWith("image/");

  if (!isDataUrl && !isImageFile) {
    return Promise.reject(new Error("The selected source is not a supported image."));
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = isDataUrl ? null : URL.createObjectURL(source);

    img.onload = () => {
      try {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        imageResolution = [img.naturalWidth, img.naturalHeight];
        $("dropHint").style.display = "none";
        clearFeedbackTargets();
        state.playing = true;
        forceSceneRebuild();
        syncTimelineControls();
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }
    };

    img.onerror = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      reject(new Error("The browser could not decode this image."));
    };

    img.src = isDataUrl ? source : objectUrl;
  });
}

function reportImageLoadError(error) {
  console.warn("Unable to load source image", error);
  setPersistenceStatus("The source image could not be decoded.");
}

$("file").addEventListener("change", e => {
  const file = e.target.files?.[0];
  if (file) loadImage(file).catch(reportImageLoadError);
});

for (const eventName of ["dragenter", "dragover"]) {
  canvas.addEventListener(eventName, e => e.preventDefault());
}

canvas.addEventListener("drop", e => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) loadImage(file).catch(reportImageLoadError);
});

let dragging = false;
let lastX = 0;
let lastY = 0;

canvas.addEventListener("pointerdown", e => {
  if (feedbackRebuildTimer !== null) {
    clearTimeout(feedbackRebuildTimer);
    feedbackRebuildTimer = null;
  }
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener("pointermove", e => {
  if (!dragging) return;
  const rect = canvas.getBoundingClientRect();
  const dx = (e.clientX - lastX) / rect.width;
  const dy = (e.clientY - lastY) / rect.height;

  state.panX -= dx / state.zoom;
  state.panY += dy / state.zoom;

  setValue("panX", state.panX);
  setValue("panY", state.panY);
  markLiveInteractionDirty();

  lastX = e.clientX;
  lastY = e.clientY;
});

function finishDrag() {
  if (!dragging) return;
  dragging = false;

  if (feedbackRebuildTimer !== null) {
    clearTimeout(feedbackRebuildTimer);
    feedbackRebuildTimer = null;
  }

  // Reconstruct an accurate feedback trail after the interaction, rather
  // than replaying the entire timeline for every pointer movement.
  if (feedbackRebuildPending) {
    feedbackRebuildPending = false;
    markSceneDirty();
  }
}

canvas.addEventListener("pointerup", finishDrag);
canvas.addEventListener("pointercancel", finishDrag);

canvas.addEventListener("wheel", e => {
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * 0.001);
  state.zoom = Math.min(5, Math.max(0.2, state.zoom * factor));
  setValue("zoom", state.zoom);
  markLiveInteractionDirty();
  queueFeedbackRebuild();
}, { passive: false });

function applyPreset(name) {
  const presets = {
    flower: {
      segments: 12,
      mirror: true,
      symmetryMode: "mirrorRadial",
      twist: 0.0,
      zoom: 1.35,
      rotationDeg: 8.0,
      panX: 0.00,
      panY: 0.00,
      centerX: 0.50,
      centerY: 0.50,
      animate: true,
      speedDeg: 3.5,
      driftX: 0.03,
      driftY: 0.02,
      driftMode: "orbit",
      driftSpeed: 0.05,
      pulseAmount: 0.03,
      pulseSpeed: 0.20,
      feedbackAmount: 0.15,
      feedbackZoom: 1.002,
      feedbackRotateDeg: 0.10
    },
    crystal: {
      segments: 16,
      mirror: true,
      symmetryMode: "hexagonal",
      twist: 0.0,
      zoom: 1.8,
      rotationDeg: 0.0,
      panX: 0.02,
      panY: -0.03,
      centerX: 0.50,
      centerY: 0.50,
      animate: true,
      speedDeg: 1.8,
      driftX: 0.03,
      driftY: 0.02,
      driftMode: "smoothRandom",
      driftSpeed: 0.35,
      pulseAmount: 0.01,
      pulseSpeed: 0.15,
      feedbackAmount: 0.35,
      feedbackZoom: 1.003,
      feedbackRotateDeg: 0.18
    },
    tunnel: {
      segments: 8,
      mirror: true,
      symmetryMode: "tunnel",
      twist: 2.5,
      zoom: 2.3,
      rotationDeg: 0.0,
      panX: 0.00,
      panY: 0.00,
      centerX: 0.50,
      centerY: 0.50,
      animate: true,
      speedDeg: 6.0,
      driftX: 0.02,
      driftY: 0.02,
      driftMode: "orbit",
      driftSpeed: 0.10,
      pulseAmount: 0.08,
      pulseSpeed: 0.30,
      feedbackAmount: 0.60,
      feedbackZoom: 1.006,
      feedbackRotateDeg: 0.35
    }
  };

  const p = presets[name];
  if (!p) return;

  Object.assign(state, p);

  const idMap = {
    segments: "segments",
    twist: "twist",
    zoom: "zoom",
    rotationDeg: "rotation",
    panX: "panX",
    panY: "panY",
    centerX: "centerX",
    centerY: "centerY",
    speedDeg: "speed",
    driftX: "driftX",
    driftY: "driftY",
    driftSpeed: "driftSpeed",
    pulseAmount: "pulseAmount",
    pulseSpeed: "pulseSpeed",
    feedbackAmount: "feedbackAmount",
    feedbackZoom: "feedbackZoom",
    feedbackRotateDeg: "feedbackRotate"
  };

  for (const [key, id] of Object.entries(idMap)) {
    setValue(id, state[key]);
  }

  $("mirror").checked = state.mirror;
  $("symmetryMode").value = state.symmetryMode;
  $("animate").checked = state.animate;
  setSelectValue("driftMode", state.driftMode);
  syncTimelineControls();
  clearFeedbackTargets();
  forceSceneRebuild();
}

document.querySelectorAll(".preset").forEach(button => {
  button.addEventListener("click", () => applyPreset(button.dataset.preset));
});

$("clearFeedback").addEventListener("click", () => {
  clearFeedbackTargets();
  forceSceneRebuild();
});

$("reset").addEventListener("click", () => {
  Object.assign(state, structuredClone(defaults));

  setValue("segments", state.segments);
  setValue("twist", state.twist);
  setValue("zoom", state.zoom);
  setValue("rotation", state.rotationDeg);
  setValue("panX", state.panX);
  setValue("panY", state.panY);
  setValue("centerX", state.centerX);
  setValue("centerY", state.centerY);
  setValue("speed", state.speedDeg);
  setValue("driftX", state.driftX);
  setValue("driftY", state.driftY);
  setValue("driftSpeed", state.driftSpeed);
  setValue("pulseAmount", state.pulseAmount);
  setValue("pulseSpeed", state.pulseSpeed);
  setValue("feedbackAmount", state.feedbackAmount);
  setValue("feedbackZoom", state.feedbackZoom);
  setValue("feedbackRotate", state.feedbackRotateDeg);
  setValue("hue", state.hue);
  syncBloomControl("bloomStrength", "bloomStrength", state.bloomStrength);
  syncBloomControl("bloomThreshold", "bloomThreshold", state.bloomThreshold);
  syncBloomControl("bloomRadius", "bloomRadius", state.bloomRadius);
  syncMotionButtons();

  $("mirror").checked = state.mirror;
  $("symmetryMode").value = state.symmetryMode;
  $("animate").checked = state.animate;
  setSelectValue("driftMode", state.driftMode);
  syncTimelineControls();
  clearFeedbackTargets();
  forceSceneRebuild();
});


// -----------------------------------------------------------------------------
// Canvas recording
// -----------------------------------------------------------------------------

let mediaRecorder = null;
let recordedChunks = [];
let recordingStartedAt = 0;
let recordingTimer = null;
let recordingMimeType = "";
let recordingExtension = "";

function pickRecordingFormat() {
  const candidates = [
    { mime: "video/mp4;codecs=avc1.42E01E", ext: "mp4" },
    { mime: "video/mp4", ext: "mp4" },
    { mime: "video/webm;codecs=vp9", ext: "webm" },
    { mime: "video/webm;codecs=vp8", ext: "webm" },
    { mime: "video/webm", ext: "webm" }
  ];

  for (const candidate of candidates) {
    if (typeof MediaRecorder !== "undefined" &&
        MediaRecorder.isTypeSupported(candidate.mime)) {
      return candidate;
    }
  }

  return null;
}

function setRecordingStatus(message) {
  $("recordingStatus").textContent = message;
}

function formatRecordingTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function stopRecordingTimer() {
  if (recordingTimer !== null) {
    clearInterval(recordingTimer);
    recordingTimer = null;
  }
}

function startRecordingTimer() {
  stopRecordingTimer();
  recordingStartedAt = performance.now();

  recordingTimer = setInterval(() => {
    const elapsedMs = performance.now() - recordingStartedAt;
    setRecordingStatus(
      `Recording ${recordingExtension.toUpperCase()} · ${formatRecordingTime(elapsedMs)}`
    );
  }, 250);
}

$("startRecording").addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state !== "inactive") return;

  if (!canvas.captureStream || typeof MediaRecorder === "undefined") {
    setRecordingStatus("This browser does not support canvas recording.");
    return;
  }

  const format = pickRecordingFormat();
  if (!format) {
    setRecordingStatus("No supported browser-native recording format was found.");
    return;
  }

  const fps = Number($("recordFps").value) || 60;
  const stream = canvas.captureStream(fps);

  recordedChunks = [];
  recordingMimeType = format.mime;
  recordingExtension = format.ext;

  try {
    mediaRecorder = new MediaRecorder(stream, {
      mimeType: recordingMimeType,
      videoBitsPerSecond: 12_000_000
    });
  } catch (error) {
    setRecordingStatus(`Could not start recording: ${error.message}`);
    stream.getTracks().forEach(track => track.stop());
    return;
  }

  mediaRecorder.addEventListener("dataavailable", event => {
    if (event.data && event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  });

  mediaRecorder.addEventListener("stop", () => {
    stopRecordingTimer();

    const blob = new Blob(recordedChunks, {
      type: recordingMimeType
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-");

    a.href = url;
    a.download = `kaleidoscope-${timestamp}.${recordingExtension}`;
    a.click();

    setTimeout(() => URL.revokeObjectURL(url), 2000);

    stream.getTracks().forEach(track => track.stop());

    $("startRecording").disabled = false;
    $("stopRecording").disabled = true;

    const formatLabel = recordingExtension.toUpperCase();
    setRecordingStatus(`Saved ${formatLabel} recording.`);
  });

  mediaRecorder.addEventListener("error", event => {
    stopRecordingTimer();
    $("startRecording").disabled = false;
    $("stopRecording").disabled = true;
    setRecordingStatus(`Recording error: ${event.error?.message || "unknown error"}`);
  });

  mediaRecorder.start(1000);

  $("startRecording").disabled = true;
  $("stopRecording").disabled = false;

  startRecordingTimer();
});

$("stopRecording").addEventListener("click", () => {
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;
  setRecordingStatus("Finalizing recording...");
  mediaRecorder.stop();
});

const initialRecordingFormat = pickRecordingFormat();
if (initialRecordingFormat) {
  const preferredLabel =
    initialRecordingFormat.ext === "mp4"
      ? "MP4/H.264 available in this browser."
      : "MP4 recording is unavailable here; recordings will use WebM.";
  setRecordingStatus(preferredLabel);
} else {
  setRecordingStatus("Canvas recording is not supported by this browser.");
}


$("save").addEventListener("click", () => {
  const a = document.createElement("a");
  a.download = "kaleidoscope.png";
  a.href = canvas.toDataURL("image/png");
  a.click();
});


function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(canvas.clientWidth * dpr);
  const height = Math.round(canvas.clientHeight * dpr);

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    resizeRenderTargets(width, height);
    markSceneDirty();
  }

  gl.viewport(0, 0, canvas.width, canvas.height);
}

const TAU = Math.PI * 2.0;
const SEEK_SIM_FPS = 30;

function resetDriftMotion() {
  // Kept only for compatibility with older event handlers / presets.
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function fract(x) {
  return x - Math.floor(x);
}

function hash1(x) {
  return fract(Math.sin(x * 127.1 + 311.7) * 43758.5453123);
}

function smoothNoiseSigned(t, seed) {
  const i0 = Math.floor(t);
  const i1 = i0 + 1;
  const f = t - i0;
  const u = f * f * (3.0 - 2.0 * f);

  const a = hash1(i0 + seed) * 2.0 - 1.0;
  const b = hash1(i1 + seed) * 2.0 - 1.0;
  return lerp(a, b, u);
}

const MOTION_SOURCES = new Set(["none", "sine", "triangle", "smoothRandom", "ramp", "steps"]);

function restoreMotionSettings(savedMotion) {
  if (!savedMotion || typeof savedMotion !== "object") return;

  for (const [key] of Object.entries(defaults.motion)) {
    const saved = savedMotion[key];
    if (!saved || typeof saved !== "object") continue;
    const target = state.motion[key];
    if (MOTION_SOURCES.has(saved.source)) target.source = saved.source;
    for (const field of ["speed", "amount", "phase"]) {
      if (Number.isFinite(Number(saved[field]))) target[field] = Number(saved[field]);
    }
  }
}

function motionWave(source, cycles, seed) {
  switch (source) {
    case "sine":
      return Math.sin(TAU * cycles);
    case "triangle":
      return 1.0 - 4.0 * Math.abs(fract(cycles) - 0.5);
    case "smoothRandom":
      return smoothNoiseSigned(cycles, seed);
    case "ramp":
      return fract(cycles) * 2.0 - 1.0;
    case "steps":
      return Math.round((fract(cycles) * 2.0 - 1.0) * 3.0) / 3.0;
    default:
      return 0.0;
  }
}

function applyMotion(key, base, t) {
  if (!state.animate) return base;
  const motion = state.motion[key];
  if (!motion || motion.source === "none") return base;
  const seed = [...key].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const cycles = t * Math.max(0, motion.speed) + motion.phase;
  return base + motionWave(motion.source, cycles, seed) * motion.amount;
}

function motionOffset(key, t) {
  return applyMotion(key, 0.0, t);
}

function computeDriftOffsetsAtTime(t) {
  if (!state.animate) {
    return { x: 0.0, y: 0.0 };
  }

  const driftX = state.driftX;
  const driftY = state.driftY;
  let base;

  switch (state.driftMode) {
    case "linear":
      base = {
        x: driftX * t,
        y: driftY * t
      };
      break;

    case "oscillate": {
      const phase = TAU * state.driftSpeed * t;
      const wave = Math.sin(phase);
      base = {
        x: driftX * wave,
        y: driftY * wave
      };
      break;
    }

    case "orbit": {
      const phase = TAU * state.driftSpeed * t;
      base = {
        x: driftX * Math.cos(phase),
        y: driftY * Math.sin(phase)
      };
      break;
    }

    case "smoothRandom": {
      const freq = Math.max(0.02, state.driftSpeed);
      base = {
        x: driftX * smoothNoiseSigned(t * freq * 1.15 + 2.71, 17.13),
        y: driftY * smoothNoiseSigned(t * freq * 0.93 + 9.42, 47.77)
      };
      break;
    }

    default:
      base = { x: 0.0, y: 0.0 };
  }

  return {
    x: base.x + motionOffset("driftX", t),
    y: base.y + motionOffset("driftY", t)
  };
}

function computeDynamicAtTime(t) {
  const drift = computeDriftOffsetsAtTime(t);
  const pulse = state.animate
    ? Math.sin(TAU * state.pulseSpeed * t) * state.pulseAmount
    : 0.0;

  const rotationDeg = state.animate
    ? state.rotationDeg + state.speedDeg * t
    : state.rotationDeg;

  return {
    zoom: Math.max(0.2, applyMotion("zoom", state.zoom * (1.0 + pulse), t)),
    rotationRad: applyMotion("rotationDeg", rotationDeg, t) * Math.PI / 180.0,
    panX: applyMotion("panX", state.panX + drift.x, t),
    panY: applyMotion("panY", state.panY + drift.y, t),
    segments: Math.max(2, Math.round(applyMotion("segments", state.segments, t))),
    twist: applyMotion("twist", state.twist, t),
    feedbackAmount: Math.min(0.98, Math.max(0, applyMotion("feedbackAmount", state.feedbackAmount, t))),
    hue: fract(applyMotion("hue", state.hue, t))
  };
}

function swapTargets() {
  const temp = readTarget;
  readTarget = writeTarget;
  writeTarget = temp;
}

function drawFeedbackPass(dynamic) {
  gl.useProgram(feedbackProgram);
  gl.bindVertexArray(vao);
  gl.bindFramebuffer(gl.FRAMEBUFFER, writeTarget.framebuffer);
  gl.viewport(0, 0, writeTarget.width, writeTarget.height);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
  gl.uniform1i(feedbackUniforms.u_image, 0);

  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, readTarget.texture);
  gl.uniform1i(feedbackUniforms.u_prev, 1);

  gl.uniform2f(feedbackUniforms.u_resolution, canvas.width, canvas.height);
  gl.uniform2f(
    feedbackUniforms.u_imageResolution,
    imageResolution[0],
    imageResolution[1]
  );
  gl.uniform1f(feedbackUniforms.u_segments, dynamic.segments);
  gl.uniform1i(feedbackUniforms.u_mirror, state.mirror ? 1 : 0);
  gl.uniform1i(feedbackUniforms.u_symmetryMode, Math.max(0, SYMMETRY_MODES.indexOf(state.symmetryMode)));
  gl.uniform1f(feedbackUniforms.u_twist, dynamic.twist);
  gl.uniform1f(feedbackUniforms.u_zoom, dynamic.zoom);
  gl.uniform1f(feedbackUniforms.u_rotation, dynamic.rotationRad);
  gl.uniform2f(feedbackUniforms.u_pan, dynamic.panX, dynamic.panY);
  gl.uniform2f(feedbackUniforms.u_center, state.centerX, state.centerY);
  gl.uniform1f(feedbackUniforms.u_feedbackAmount, dynamic.feedbackAmount);
  gl.uniform1f(feedbackUniforms.u_feedbackZoom, state.feedbackZoom);
  gl.uniform1f(
    feedbackUniforms.u_feedbackRotation,
    state.feedbackRotateDeg * Math.PI / 180.0
  );
  gl.uniform1f(feedbackUniforms.u_hue, dynamic.hue);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function drawScreenTexture(texture) {
  gl.useProgram(blitProgram);
  gl.bindVertexArray(blitVao);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(blitUniforms.u_tex, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function drawSimulationStepAtTime(t) {
  const dynamic = computeDynamicAtTime(t);
  drawFeedbackPass(dynamic);
  swapTargets();
}

function presentCurrentFrame() {
  if (state.bloomStrength <= 0) {
    drawScreenTexture(readTarget.texture);
    return;
  }

  drawScreenTexture(bloom.render(readTarget.texture, {
    threshold: state.bloomThreshold,
    strength: state.bloomStrength,
    radius: state.bloomRadius,
    passes: 2
  }));
}

function seekToTime(targetTime) {
  state.currentTime = Number.isFinite(targetTime) ? targetTime : state.currentTime;
  syncTimelineControls();

  clearFeedbackTargets();

  const finalTime = state.currentTime;
  const step = 1.0 / SEEK_SIM_FPS;

  // Without feedback, each frame depends only on the source image and the
  // controls at this exact time. Replaying prior frames is unnecessary.
  if (finalTime <= 0 || (state.feedbackAmount <= 0 && state.motion.feedbackAmount.source === "none")) {
    drawSimulationStepAtTime(finalTime);
    presentCurrentFrame();
    sceneDirty = false;
    return;
  }

  let t = 0.0;
  while (t + step < finalTime) {
    drawSimulationStepAtTime(t);
    t += step;
  }

  drawSimulationStepAtTime(finalTime);
  presentCurrentFrame();
  sceneDirty = false;
}

let previousTime = performance.now();

function render(now) {
  resizeCanvas();

  const dt = Math.min((now - previousTime) / 1000, 0.1);
  previousTime = now;

  if (liveInteractionDirty) {
    drawSimulationStepAtTime(state.currentTime);
    presentCurrentFrame();
    liveInteractionDirty = false;
    sceneDirty = false;
  } else if (sceneDirty) {
    seekToTime(state.currentTime);
  } else if (state.playing) {
    state.currentTime += dt;
    syncTimelineControls();
    drawSimulationStepAtTime(state.currentTime);
    presentCurrentFrame();
  }

  requestAnimationFrame(render);
}

// Restore settings synchronously, but keep persistence disabled while the UI
// is being populated so initialization cannot overwrite the saved state.
persistenceEnabled = false;
const hadSavedSettings = restoreWorkspaceSettings();
persistenceEnabled = true;
attachPersistenceListeners();

if (hadSavedSettings) {
  setPersistenceStatus("Settings restored. Restoring source image...");
} else {
  setPersistenceStatus("Local workspace save enabled.");
}

// Important: this is the same renderer startup path as v0.7.
requestAnimationFrame(render);

// Image restoration happens only after rendering is alive.
restoreSourceImageInBackground();
saveWorkspaceSettingsNow();
