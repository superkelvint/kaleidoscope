import { GLOBAL_WALLPAPER_GLSL, globalWallpaperModeIndex } from "./global-wallpaper.js";
import { LOCAL_MOTIF_GLSL } from "./local-motif.js";
import { count, measure } from "./perf.js";

const VERTEX_SOURCE = `#version 300 es
layout(location = 0) in vec2 a_position;
out vec2 v_uv;
void main() { v_uv = a_position * 0.5 + 0.5; gl_Position = vec4(a_position, 0.0, 1.0); }`;

const FEEDBACK_SOURCE = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 outColor;
uniform sampler2D u_image, u_prev;
uniform vec2 u_resolution, u_imageResolution, u_gridOffset, u_pan, u_center, u_worldOrigin, u_worldExtent, u_worldScale;
uniform float u_segments, u_wallpaperSize, u_gridRotation, u_twist, u_zoom, u_rotation, u_feedbackAmount, u_feedbackZoom, u_feedbackRotation, u_hue;
uniform bool u_mirror, u_worldSource, u_worldRepeat; uniform int u_symmetryMode, u_wallpaperMode;
const float PI = 3.141592653589793; const float TAU = 6.283185307179586;
vec2 rotate2d(vec2 p, float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c) * p; }
${GLOBAL_WALLPAPER_GLSL}
${LOCAL_MOTIF_GLSL}
vec3 hueShift(vec3 color,float hue){float a=hue*TAU,c=cos(a),s=sin(a);mat3 r=mat3(.299+.701*c+.168*s,.587-.587*c+.330*s,.114-.114*c-.497*s,.299-.299*c-.328*s,.587+.413*c+.035*s,.114-.114*c+.292*s,.299-.300*c+1.250*s,.587-.588*c-1.050*s,.114+.886*c-.203*s);return clamp(r*color,0.,1.);}
void main(){// p is isotropic display/symmetry space: one unit is one display-height.
 vec2 p=v_uv-u_center;float aspect=u_resolution.x/u_resolution.y;p.x*=aspect;vec2 grid=p;if(u_wallpaperMode!=0)grid=rotate2d(p-u_gridOffset,-u_gridRotation);vec2 q=localMotifPoint(globalWallpaperPoint(grid,u_wallpaperMode,u_wallpaperSize));q=rotate2d(q,u_rotation);q/=max(u_zoom,.001);
 // Convert once from isotropic symmetry space to source UV. A drawing
 // material uses its fixed semantic scale, never its raster pixel size.
 float imageAspect=u_worldSource ? u_worldScale.x/u_worldScale.y : u_imageResolution.x/u_imageResolution.y;q.x/=max(imageAspect,.001);q+=u_pan+vec2(.5);
 vec2 sourceUV=u_worldSource ? vec2((q.x*u_worldScale.x-u_worldOrigin.x)/u_worldExtent.x,1.-((1.-q.y)*u_worldScale.y-u_worldOrigin.y)/u_worldExtent.y) : fract(q);
vec2 sampleUV=u_worldSource?(u_worldRepeat?fract(sourceUV):clamp(sourceUV,0.,1.)):sourceUV;
vec3 fresh=texture(u_image,sampleUV).rgb;
 p=v_uv-u_center;p.x*=aspect;p=rotate2d(p,u_feedbackRotation);p/=max(u_feedbackZoom,.001);p.x/=aspect;vec3 prev=texture(u_prev,fract(p+u_center)).rgb;outColor=vec4(hueShift(mix(fresh,prev,u_feedbackAmount),u_hue),1.);}`;

const BLIT_SOURCE = `#version 300 es
precision highp float; in vec2 v_uv; out vec4 outColor; uniform sampler2D u_tex; void main(){outColor=texture(u_tex,v_uv);}`;

const DEFAULT_STATE = {
  segments: 12, mirror: true, symmetryMode: "mirrorRadial", wallpaperMode: "p6m", wallpaperSize: 0.45,
  gridRotationDeg: 0, gridX: 0, gridY: 0, twist: 0, zoom: 1, rotationDeg: 0, panX: 0, panY: 0,
  centerX: 0.5, centerY: 0.5, animate: true, speedDeg: 4, driftX: 0, driftY: 0, driftMode: "linear",
  driftSpeed: .2, pulseAmount: 0, pulseSpeed: .2, feedbackAmount: 0, feedbackZoom: 1, feedbackRotateDeg: 0,
  bloomStrength: 0, bloomThreshold: .6, bloomRadius: 1.5, hue: 0, currentTime: 0, playing: false,
  motion: {
    zoom:{source:"none",speed:.15,amount:.15,phase:0}, rotationDeg:{source:"none",speed:.1,amount:20,phase:0},
    panX:{source:"none",speed:.12,amount:.12,phase:0}, panY:{source:"none",speed:.12,amount:.12,phase:.25},
    driftX:{source:"none",speed:.1,amount:.01,phase:0}, driftY:{source:"none",speed:.1,amount:.01,phase:.25},
    feedbackAmount:{source:"none",speed:.05,amount:.15,phase:0}, hue:{source:"none",speed:.04,amount:.35,phase:0},
    segments:{source:"none",speed:.08,amount:6,phase:0}, twist:{source:"none",speed:.08,amount:4,phase:0}
  }
};

const SYMMETRY_MODES = ["radial","mirrorRadial","spiral","tunnel","fractalFold","tile","p2","p4","pg","hexagonal","wallpaper"];
const MOTION_SOURCES = new Set(["none","sine","triangle","smoothRandom","ramp","steps"]);
const WALLPAPER_MODES = new Set(["single","p6m","p6","p4m","p4g","p3m1","p3","p31m"]);
const DRIFT_MODES = new Set(["linear","oscillate","orbit","smoothRandom"]);
const TAU = Math.PI * 2;

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

    this.brightProgram = createProgram(gl, VERTEX_SOURCE, `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 outColor;
uniform sampler2D u_scene; uniform float u_threshold;
void main() {
  vec3 color=texture(u_scene,v_uv).rgb;
  float brightness=max(max(color.r,color.g),color.b);
  // Preserve the portion above the threshold instead of multiplying the
  // entire source color by a narrow step. The old extraction made bloom from
  // thin, bright drawing marks almost indistinguishable after downsampling.
  float knee=.12;
  float soft=clamp(brightness-u_threshold+knee,0.,2.*knee);
  soft=soft*soft/max(4.*knee,.0001);
  float extracted=max(brightness-u_threshold,soft);
  outColor=vec4(color*extracted/max(brightness,.0001),1.);
}`);
    this.blurProgram = createProgram(gl, VERTEX_SOURCE, `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 outColor;
uniform sampler2D u_image; uniform vec2 u_texelSize, u_direction; uniform float u_radius;
void main() { vec2 stepUV=u_texelSize*u_direction*max(u_radius,.001); vec3 color=texture(u_image,v_uv).rgb*.227027; color+=texture(u_image,v_uv+stepUV*1.384615).rgb*.316216; color+=texture(u_image,v_uv-stepUV*1.384615).rgb*.316216; color+=texture(u_image,v_uv+stepUV*3.230769).rgb*.070270; color+=texture(u_image,v_uv-stepUV*3.230769).rgb*.070270; outColor=vec4(color,1.); }`);
    this.compositeProgram = createProgram(gl, VERTEX_SOURCE, `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 outColor;
uniform sampler2D u_scene, u_bloom; uniform float u_strength;
void main() { vec3 scene=texture(u_scene,v_uv).rgb; vec3 bloom=texture(u_bloom,v_uv).rgb; outColor=vec4(scene+bloom*u_strength,1.); }`);
    this.brightUniforms = uniforms(gl, this.brightProgram, ["u_scene", "u_threshold"]);
    this.blurUniforms = uniforms(gl, this.blurProgram, ["u_image", "u_texelSize", "u_direction", "u_radius"]);
    this.compositeUniforms = uniforms(gl, this.compositeProgram, ["u_scene", "u_bloom", "u_strength"]);
    this.vao = createQuad(gl, this.brightProgram);
  }

  createTarget(width, height) {
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
    return { texture, framebuffer, width, height };
  }

  resize(width, height) {
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    const bloomWidth = Math.max(1, Math.floor(width * this.scale));
    const bloomHeight = Math.max(1, Math.floor(height * this.scale));
    if (width === this.width && height === this.height && bloomWidth === this.bloomWidth && bloomHeight === this.bloomHeight) return;
    this.destroyTargets();
    this.width = width; this.height = height; this.bloomWidth = bloomWidth; this.bloomHeight = bloomHeight;
    this.brightTarget = this.createTarget(bloomWidth, bloomHeight);
    this.blurTargetA = this.createTarget(bloomWidth, bloomHeight);
    this.blurTargetB = this.createTarget(bloomWidth, bloomHeight);
    this.outputTarget = this.createTarget(width, height);
  }

  draw(program, target, texture, applyUniforms) {
    const gl = this.gl;
    gl.useProgram(program);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    applyUniforms();
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  render(inputTexture, { threshold, strength, radius, passes = 2 }) {
    const gl = this.gl;
    this.draw(this.brightProgram, this.brightTarget, inputTexture, () => {
      gl.uniform1i(this.brightUniforms.u_scene, 0);
      gl.uniform1f(this.brightUniforms.u_threshold, threshold);
    });
    let texture = this.brightTarget.texture;
    for (let index = 0; index < passes; index += 1) {
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

  destroyTargets() {
    for (const target of [this.brightTarget, this.blurTargetA, this.blurTargetB, this.outputTarget]) {
      if (!target) continue;
      this.gl.deleteFramebuffer(target.framebuffer);
      this.gl.deleteTexture(target.texture);
    }
    this.brightTarget = this.blurTargetA = this.blurTargetB = this.outputTarget = null;
  }
}

export class Renderer {
  constructor(canvas, { onStateChange = () => {}, onBeforeFrame = () => {}, onFrame = () => {}, onPresent = () => {} } = {}) {
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl2", { antialias: true, preserveDrawingBuffer: true });
    if (!this.gl) throw new Error("WebGL2 is not supported by this browser.");
    this.onStateChange = onStateChange;
    this.onBeforeFrame = onBeforeFrame;
    this.onFrame = onFrame;
    this.onPresent = onPresent;
    this.state = structuredClone(DEFAULT_STATE);
    this.source = null;
    this.uploadedSource = null;
    this.uploadedRevision = -1;
    this.uploadedSourceSize = [0, 0];
    this.activeSourceTexture = null;
    this.sourceDiagnostics = { textureUploads: 0, textureSubUploads: 0, gpuTextureUses: 0, readPixelsCalls: 0 };
    this.imageResolution = [2, 2];
    this.sceneDirty = true;
    this.liveInteractionDirty = false;
    this.feedbackRebuildTimer = null;
    this.framePending = false;
    this.previousTime = performance.now();
    this.readTarget = null;
    this.writeTarget = null;
    this.initGpu();
  }

  initGpu() {
    const gl = this.gl;
    this.feedbackProgram = createProgram(gl, VERTEX_SOURCE, FEEDBACK_SOURCE);
    this.blitProgram = createProgram(gl, VERTEX_SOURCE, BLIT_SOURCE);
    this.feedbackUniforms = uniforms(gl, this.feedbackProgram, ["u_image","u_prev","u_resolution","u_imageResolution","u_segments","u_mirror","u_symmetryMode","u_wallpaperMode","u_wallpaperSize","u_gridRotation","u_gridOffset","u_twist","u_zoom","u_rotation","u_pan","u_center","u_worldSource","u_worldRepeat","u_worldOrigin","u_worldExtent","u_worldScale","u_feedbackAmount","u_feedbackZoom","u_feedbackRotation","u_hue"]);
    this.blitUniforms = uniforms(gl, this.blitProgram, ["u_tex"]);
    this.vao = createQuad(gl, this.feedbackProgram);
    this.blitVao = createQuad(gl, this.blitProgram);
    this.bloom = new BloomEffect(gl, { scale: 0.5 });
    this.sourceTexture = gl.createTexture();
    this.activeSourceTexture = this.sourceTexture;
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,2,2,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([40,40,40,255,70,70,70,255,70,70,70,255,40,40,40,255]));
  }

  getState() { return structuredClone(this.state); }
  /** Stable structural diagnostics for zero-copy source regression tests. */
  getSourceDiagnostics() { return { ...this.sourceDiagnostics }; }
  getCurrentMappingState() {
    const dynamic = this.dynamic(this.state.currentTime);
    return {
      segments: dynamic.segments,
      mirror: this.state.mirror,
      symmetryMode: this.state.symmetryMode,
      twist: dynamic.twist,
      zoom: dynamic.zoom,
      rotationRad: dynamic.rotationRad,
      panX: dynamic.panX,
      panY: dynamic.panY,
      centerX: this.state.centerX,
      centerY: this.state.centerY,
      wallpaperMode: this.state.wallpaperMode,
      wallpaperSize: this.state.wallpaperSize,
      gridRotationDeg: this.state.gridRotationDeg,
      gridX: this.state.gridX,
      gridY: this.state.gridY
    };
  }
  restoreState(snapshot) { this.applySnapshot(snapshot); this.forceSceneRebuild(); this.emitState(); }
  updateState(patch, { preview = true } = {}) { this.applySnapshot(patch); preview ? this.preview() : this.forceSceneRebuild(); this.emitState(); }
  updatePostProcess(patch) { this.applySnapshot(patch); if (this.readTarget) this.present(); this.requestRender(); this.emitState(); }
  updateMotion(key, patch) { if (!this.state.motion[key]) return; const next={...this.state.motion[key],...patch}; if(MOTION_SOURCES.has(next.source)) this.state.motion[key]=next; this.preview(); this.emitState(); }
  setSource(source) {
    this.source = source;
    this.syncSourceTexture();

    // Source activation is intentionally different from a source edit. A new
    // source starts a new feedback history; incremental source updates do not.
    this.clearFeedbackTargets();
    this.forceSceneRebuild();
  }
  start() { if (this.running) return; this.running = true; this.requestRender(); }
  requestRender() { if (!this.running || this.framePending) return; this.framePending = true; requestAnimationFrame(this.render); }
  seekToTime(time, { pause = false, livePreview = false } = {}) { if (!Number.isFinite(Number(time))) return; this.state.currentTime=Number(time); if(pause)this.state.playing=false; livePreview?this.preview():this.forceSceneRebuild(); this.emitState(); }
  panBy(dx, dy) { this.state.panX -= dx / this.state.zoom; this.state.panY += dy / this.state.zoom; this.preview(); this.emitState(); }
  zoomBy(factor) { this.state.zoom=Math.min(5,Math.max(.2,this.state.zoom*factor)); this.preview(); this.queueFeedbackRebuild(); this.emitState(); }
  beginInteraction() { if(this.feedbackRebuildTimer){clearTimeout(this.feedbackRebuildTimer);this.feedbackRebuildTimer=null;} }
  endInteraction() { if(this.feedbackRebuildTimer){clearTimeout(this.feedbackRebuildTimer);this.feedbackRebuildTimer=null;} if(this.liveInteractionDirty){this.liveInteractionDirty=false;this.sceneDirty=true;this.requestRender();} }
  preview() { this.sceneDirty=false; this.liveInteractionDirty=true; this.queueFeedbackRebuild(); this.requestRender(); }
  queueFeedbackRebuild() { clearTimeout(this.feedbackRebuildTimer); this.feedbackRebuildTimer=setTimeout(()=>{this.feedbackRebuildTimer=null;if(this.liveInteractionDirty)this.forceSceneRebuild();},150); }
  forceSceneRebuild() { if(this.feedbackRebuildTimer){clearTimeout(this.feedbackRebuildTimer);this.feedbackRebuildTimer=null;} this.liveInteractionDirty=false;this.sceneDirty=true;this.requestRender(); }
  emitState() { this.onStateChange(this.getState()); }

  applySnapshot(snapshot = {}) {
    for (const [key, value] of Object.entries(snapshot)) {
      if (key === "motion" || !(key in this.state)) continue;
      if (typeof this.state[key] === "boolean") { if(typeof value === "boolean") this.state[key]=value; }
      else if(typeof this.state[key] === "number" && Number.isFinite(Number(value))) this.state[key]=Number(value);
      else if(typeof this.state[key] === "string" && typeof value === "string") {
        if (key === "symmetryMode" && !SYMMETRY_MODES.includes(value)) continue;
        if (key === "wallpaperMode" && !WALLPAPER_MODES.has(value)) continue;
        if (key === "driftMode" && !DRIFT_MODES.has(value)) continue;
        this.state[key]=value;
      }
    }
    if (snapshot.motion && typeof snapshot.motion === "object") for(const key of Object.keys(this.state.motion)) this.updateMotionSnapshot(key,snapshot.motion[key]);
  }
  updateMotionSnapshot(key, patch) { if(!patch||typeof patch!=="object")return; const next={...this.state.motion[key]}; if(MOTION_SOURCES.has(patch.source))next.source=patch.source; for(const f of ["speed","amount","phase"])if(Number.isFinite(Number(patch[f])))next[f]=Number(patch[f]); this.state.motion[key]=next; }

  uploadSourceTexture(frame) {
    if (!frame || !Number.isFinite(frame.width) || !Number.isFinite(frame.height)) return false;
    if (frame.kind === "gpu") {
      if (!frame.texture) return false;
      this.activeSourceTexture = frame.texture;
      this.imageResolution = [frame.width, frame.height]; this.uploadedSourceSize = [frame.width, frame.height]; this.sourceWorld = frame.world || null;
      this.sourceDiagnostics.gpuTextureUses += 1;
      count("Renderer GPU source texture use", { revision: frame.revision, width: frame.width, height: frame.height, sourceType: this.source?.constructor?.name || "anonymous" });
      return true;
    }
    if (!frame.pixels) return false;
    const needsStorage = this.uploadedSource !== this.source || this.uploadedSourceSize[0] !== frame.width || this.uploadedSourceSize[1] !== frame.height;
    const metadata = { revision: frame.revision, width: frame.width, height: frame.height, storage: needsStorage ? "texImage2D" : "texSubImage2D", sourceType: this.source?.constructor?.name || "anonymous" };
    count("Renderer source texture upload", metadata);
    return measure("source texture upload", () => {
      const gl=this.gl;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,this.sourceTexture); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
      if (needsStorage) { gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,frame.pixels); this.sourceDiagnostics.textureUploads += 1; }
      else { gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame.pixels); this.sourceDiagnostics.textureSubUploads += 1; }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, frame.world?.wrap === "clamp" ? gl.CLAMP_TO_EDGE : gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, frame.world?.wrap === "clamp" ? gl.CLAMP_TO_EDGE : gl.REPEAT);
      this.activeSourceTexture = this.sourceTexture; this.imageResolution=[frame.width,frame.height]; this.uploadedSourceSize=[frame.width,frame.height]; this.sourceWorld=frame.world || null;
      return true;
    }, metadata);
  }

  syncSourceTexture() {
    this.prepareSourceView();
    const frame = this.source?.getFrame?.();
    if (!frame) return false;
    if (this.uploadedSource === this.source && this.uploadedRevision === frame.revision) return false;
    if (!this.uploadSourceTexture(frame)) return false;
    this.uploadedSource = this.source;
    this.uploadedRevision = frame.revision;
    return true;
  }
  prepareSourceView() {
    const scale = this.source?.getWorldScale?.();
    if (!scale || !this.source?.prepareView) return;
    const dynamic = this.dynamic(this.state.currentTime);
    const width = Math.max(1, this.canvas.width || this.canvas.clientWidth || 1), height = Math.max(1, this.canvas.height || this.canvas.clientHeight || 1);
    // Drawing material has a stable semantic domain. Quality depends only on
    // display density and zoom, never on where animation samples the period.
    const pixelDensity = Math.max(width / scale.width, height / scale.height) * dynamic.zoom;
    this.source.prepareView({ pixelDensity });
  }
  resizeCanvas() { const dpr=Math.min(window.devicePixelRatio||1,2), width=Math.round(this.canvas.clientWidth*dpr), height=Math.round(this.canvas.clientHeight*dpr); if(this.canvas.width!==width||this.canvas.height!==height||!this.readTarget||!this.writeTarget){this.canvas.width=width;this.canvas.height=height;this.resizeTargets(width,height);this.sceneDirty=true;} this.gl.viewport(0,0,this.canvas.width,this.canvas.height); }
  createTarget(width,height) { const gl=this.gl, texture=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,texture); for(const [p,v] of [[gl.TEXTURE_MIN_FILTER,gl.LINEAR],[gl.TEXTURE_MAG_FILTER,gl.LINEAR],[gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE]])gl.texParameteri(gl.TEXTURE_2D,p,v); gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null); const framebuffer=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);return{texture,framebuffer,width,height}; }
  resizeTargets(width,height) { this.deleteTarget(this.readTarget);this.deleteTarget(this.writeTarget);this.readTarget=this.createTarget(width,height);this.writeTarget=this.createTarget(width,height);this.bloom.resize(width,height);this.clearFeedbackTargets(); }
  deleteTarget(target) { if(!target)return;this.gl.deleteFramebuffer(target.framebuffer);this.gl.deleteTexture(target.texture); }
  clearFeedbackTargets() { const gl=this.gl;for(const t of [this.readTarget,this.writeTarget]){if(!t)continue;gl.bindFramebuffer(gl.FRAMEBUFFER,t.framebuffer);gl.viewport(0,0,t.width,t.height);gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);}gl.bindFramebuffer(gl.FRAMEBUFFER,null); }
  dynamic(t) {
    const state = this.state;
    const drift = this.drift(t);
    const pulse = state.animate ? Math.sin(TAU * state.pulseSpeed * t) * state.pulseAmount : 0;
    const motion = (key, base) => this.applyMotion(key, base, t);

    return {
      zoom: Math.max(0.2, motion("zoom", state.zoom * (1 + pulse))),
      rotationRad: motion("rotationDeg", state.animate ? state.rotationDeg + state.speedDeg * t : state.rotationDeg) * Math.PI / 180,
      panX: motion("panX", state.panX + drift.x),
      panY: motion("panY", state.panY + drift.y),
      segments: Math.max(2, Math.round(motion("segments", state.segments))),
      twist: motion("twist", state.twist),
      feedbackAmount: Math.min(0.98, Math.max(0, motion("feedbackAmount", state.feedbackAmount))),
      hue: fract(motion("hue", state.hue))
    };
  }

  drift(t) {
    const state = this.state;
    if (!state.animate) return { x: 0, y: 0 };
    let x = 0;
    let y = 0;

    if (state.driftMode === "linear") {
      x = state.driftX * t;
      y = state.driftY * t;
    } else if (state.driftMode === "oscillate") {
      const value = Math.sin(TAU * state.driftSpeed * t);
      x = state.driftX * value;
      y = state.driftY * value;
    } else if (state.driftMode === "orbit") {
      const angle = TAU * state.driftSpeed * t;
      x = state.driftX * Math.cos(angle);
      y = state.driftY * Math.sin(angle);
    } else if (state.driftMode === "smoothRandom") {
      const frequency = Math.max(0.02, state.driftSpeed);
      x = state.driftX * noise(t * frequency * 1.15 + 2.71, 17.13);
      y = state.driftY * noise(t * frequency * 0.93 + 9.42, 47.77);
    }

    return { x: x + this.applyMotion("driftX", 0, t), y: y + this.applyMotion("driftY", 0, t) };
  }
  applyMotion(key,base,t) { const m=this.state.motion[key];if(!this.state.animate||!m||m.source==="none")return base;const cycles=t*Math.max(0,m.speed)+m.phase,seed=[...key].reduce((a,c)=>a+c.charCodeAt(0),0);return base+wave(m.source,cycles,seed)*m.amount; }
  drawStep(time) {
    const gl = this.gl;
    const dynamic = this.dynamic(time);
    const state = this.state;
    const uniforms = this.feedbackUniforms;
    const target = this.writeTarget;

    gl.useProgram(this.feedbackProgram);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.activeSourceTexture);
    gl.uniform1i(uniforms.u_image, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.readTarget.texture);
    gl.uniform1i(uniforms.u_prev, 1);

    gl.uniform2f(uniforms.u_resolution, this.canvas.width, this.canvas.height);
    gl.uniform2f(uniforms.u_imageResolution, ...this.imageResolution);
    const world = this.sourceWorld;
    gl.uniform1i(uniforms.u_worldSource, world ? 1 : 0);
    gl.uniform1i(uniforms.u_worldRepeat, world?.wrap === "repeat" ? 1 : 0);
    gl.uniform2f(uniforms.u_worldOrigin, world?.origin?.x || 0, world?.origin?.y || 0);
    gl.uniform2f(uniforms.u_worldExtent, world?.extent?.width || 1, world?.extent?.height || 1);
    gl.uniform2f(uniforms.u_worldScale, world?.scale?.width || 1, world?.scale?.height || 1);
    gl.uniform1f(uniforms.u_segments, dynamic.segments);
    gl.uniform1i(uniforms.u_mirror, state.mirror ? 1 : 0);
    gl.uniform1i(uniforms.u_symmetryMode, Math.max(0, SYMMETRY_MODES.indexOf(state.symmetryMode)));
    gl.uniform1i(uniforms.u_wallpaperMode, globalWallpaperModeIndex(state.wallpaperMode));
    gl.uniform1f(uniforms.u_wallpaperSize, state.wallpaperSize);
    gl.uniform1f(uniforms.u_gridRotation, state.gridRotationDeg * Math.PI / 180);
    gl.uniform2f(uniforms.u_gridOffset, state.gridX, state.gridY);
    gl.uniform1f(uniforms.u_twist, dynamic.twist);
    gl.uniform1f(uniforms.u_zoom, dynamic.zoom);
    gl.uniform1f(uniforms.u_rotation, dynamic.rotationRad);
    gl.uniform2f(uniforms.u_pan, dynamic.panX, dynamic.panY);
    gl.uniform2f(uniforms.u_center, state.centerX, state.centerY);
    gl.uniform1f(uniforms.u_feedbackAmount, dynamic.feedbackAmount);
    gl.uniform1f(uniforms.u_feedbackZoom, state.feedbackZoom);
    gl.uniform1f(uniforms.u_feedbackRotation, state.feedbackRotateDeg * Math.PI / 180);
    gl.uniform1f(uniforms.u_hue, dynamic.hue);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    [this.readTarget, this.writeTarget] = [this.writeTarget, this.readTarget];
  }
  present() {
    const texture = this.state.bloomStrength <= 0
      ? this.readTarget.texture
      : this.bloom.render(this.readTarget.texture, {
        threshold: this.state.bloomThreshold,
        strength: this.state.bloomStrength,
        radius: this.state.bloomRadius,
        passes: 2
      });

    const gl = this.gl;
    gl.useProgram(this.blitProgram);
    gl.bindVertexArray(this.blitVao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.blitUniforms.u_tex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.onPresent();
  }
  rebuild() {
    this.clearFeedbackTargets();
    const finalTime = this.state.currentTime;
    const step = 1 / 30;

    if (finalTime <= 0 || (this.state.feedbackAmount <= 0 && this.state.motion.feedbackAmount.source === "none")) {
      this.drawStep(finalTime);
    } else {
      for (let time = 0; time + step < finalTime; time += step) this.drawStep(time);
      this.drawStep(finalTime);
    }

    this.present();
    this.sceneDirty = false;
  }
  render = now => {
    if (!this.running) return;
    this.framePending = false;
    this.resizeCanvas();
    const dt = Math.min((now - this.previousTime) / 1000, 0.1);
    this.previousTime = now;
    if (this.state.playing) this.state.currentTime += dt;
    if (this.state.playing) this.onBeforeFrame(this.getState());
    const sourceUpdated = this.syncSourceTexture();
    if (this.liveInteractionDirty) {
      this.drawStep(this.state.currentTime);
      this.present();
      this.liveInteractionDirty = false;
      this.sceneDirty = false;
    } else if (this.sceneDirty) {
      this.rebuild();
    } else if (this.state.playing) {
      this.drawStep(this.state.currentTime);
      this.present();
      this.onFrame(this.getState());
    } else if (sourceUpdated) {
      // Keep the existing feedback history, but present a frame containing
      // newly uploaded source pixels while playback is paused.
      this.drawStep(this.state.currentTime);
      this.present();
    }

    if (this.state.playing) this.requestRender();
  };
}

function createProgram(gl,vs,fs){const shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){const info=gl.getShaderInfoLog(s);gl.deleteShader(s);throw new Error(info);}return s;};const p=gl.createProgram(),v=shader(gl.VERTEX_SHADER,vs),f=shader(gl.FRAGMENT_SHADER,fs);gl.attachShader(p,v);gl.attachShader(p,f);gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS)){const info=gl.getProgramInfoLog(p);gl.deleteProgram(p);throw new Error(info);}return p;}
function uniforms(gl,p,names){return Object.fromEntries(names.map(n=>[n,gl.getUniformLocation(p,n)]));}
function createQuad(gl,program){const vao=gl.createVertexArray(),buffer=gl.createBuffer(),loc=gl.getAttribLocation(program,"a_position");gl.bindVertexArray(vao);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);return vao;}
function fract(x){return x-Math.floor(x);}function noise(t,seed){const i=Math.floor(t),f=t-i,u=f*f*(3-2*f),h=x=>fract(Math.sin(x*127.1+311.7)*43758.5453123);return(h(i+seed)*2-1)*(1-u)+(h(i+1+seed)*2-1)*u;}function wave(source,cycles,seed){if(source==="sine")return Math.sin(TAU*cycles);if(source==="triangle")return 1-4*Math.abs(fract(cycles)-.5);if(source==="smoothRandom")return noise(cycles,seed);if(source==="ramp")return fract(cycles)*2-1;if(source==="steps")return Math.round((fract(cycles)*2-1)*3)/3;return 0;}
