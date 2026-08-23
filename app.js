import { Renderer } from "./render.js";
import { BitmapSource } from "./bitmap-source.js";
import { DrawingSource } from "./drawing-source.js";
import { BRUSH_TEXTURES, DEFAULT_BRUSH_TEXTURE_ID, brushTextureCatalog } from "./brush-textures.js";
import { GLOBAL_WALLPAPER_MODES } from "./global-wallpaper.js";

const $ = id => document.getElementById(id);
const canvas = $("gl");
const wedgeGuides = $("wedgeGuides");
const drawingGuides = $("drawingGuides");
const bitmapSource = new BitmapSource();
let activeSource = bitmapSource;
let sourceMode = "bitmap";
const WORKSPACE_STORAGE_KEY = "kaleidoscope.workspace.v10";
const PLANAR_SYMMETRY_MODES = new Set(["tile", "p2", "p4", "pg", "hexagonal", "wallpaper"]);
const TIMELINE_HALF_WINDOW = 30;
let persistenceTimer = null;
let persistenceEnabled = false;
let lastTimelineTickSecond = null;
let showMirrorGuides = false;
const MIRROR_WEDGE_MODES = new Set(["mirrorRadial", "spiral", "tunnel", "p2", "p4", "pg"]);
let mediaRecorder = null;
let recordedChunks = [];
let recordingTrack = null;
let recordingFrameInterval = 0;
let lastRecordedFrameTime = -Infinity;

function requestRecordingFrame() {
  if (!recordingTrack?.requestFrame || mediaRecorder?.state !== "recording") return;
  const time = performance.now();
  if (time - lastRecordedFrameTime < recordingFrameInterval) return;
  lastRecordedFrameTime = time;
  recordingTrack.requestFrame();
}

const renderer = new Renderer(canvas, {
  onStateChange: syncRendererState,
  onFrame: syncFrame,
  // Canvas capture receives the fully composited frame, including bloom,
  // regardless of whether that frame came from a bitmap or DrawingSource.
  onPresent: requestRecordingFrame
});
const drawingSource = new DrawingSource({ getRendererState: () => renderer.getCurrentMappingState() });

function setPersistenceStatus(message) { $("persistenceStatus").textContent = message; }

function setSourceMode(mode) {
  if (mode !== "bitmap" && mode !== "drawing") {
    throw new Error(`Unsupported source mode: ${mode}`);
  }
  if (mode !== sourceMode) drawingSource.cancelConstruction();
  sourceMode = mode;
  activeSource = mode === "drawing" ? drawingSource : bitmapSource;
  renderer.setSource(activeSource);
  $("bitmapControls").hidden = mode !== "bitmap";
  $("drawingControls").hidden = mode !== "drawing";
  refreshDrawingHistoryControls();
  $("sourceImage").classList.toggle("active", mode === "bitmap");
  $("sourceImage").setAttribute("aria-pressed", String(mode === "bitmap"));
  $("sourceDrawing").classList.toggle("active", mode === "drawing");
  $("sourceDrawing").setAttribute("aria-pressed", String(mode === "drawing"));
  $("dropHint").style.display = mode === "bitmap" && !bitmapSource.getFrame() ? "grid" : "none";
}

function workspaceSnapshot() {
  return {
    state: renderer.getState(),
    drawing: drawingSource.getState(),
    sourceMode,
    showMirrorGuides,
    recordFps: Number($("recordFps").value) || 60
  };
}

function saveWorkspaceSettingsNow() {
  if (!persistenceEnabled) return;
  try { localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspaceSnapshot())); }
  catch (error) { console.warn("Unable to save workspace settings", error); setPersistenceStatus("Browser storage is unavailable; workspace is not being saved."); }
}

function scheduleWorkspaceSave() {
  if (!persistenceEnabled) return;
  clearTimeout(persistenceTimer);
  persistenceTimer = setTimeout(saveWorkspaceSettingsNow, 150);
}

function restoreWorkspaceSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY) || "null");
    if (!saved?.state) return false;
    showMirrorGuides = Boolean(saved.showMirrorGuides);
    renderer.restoreState(saved.state);
    if (saved.drawing) drawingSource.restoreState(saved.drawing);
    if (saved.recordFps === 30 || saved.recordFps === 60) $("recordFps").value = String(saved.recordFps);
    if (saved.sourceMode === "drawing") {
      setSourceMode("drawing");
    }
    return true;
  } catch (error) {
    console.warn("Unable to restore workspace settings", error);
    return false;
  }
}

function populateWallpaperModes() {
  const current = renderer.getState().wallpaperMode;
  const modes = GLOBAL_WALLPAPER_MODES.filter(mode => ["single", "p6m", "p4m", "p3m1", "p31m"].includes(mode));
  $("wallpaperMode").replaceChildren(...modes.map(mode => Object.assign(document.createElement("option"), { value: mode, textContent: mode })));
  $("wallpaperMode").value = current;
}

function syncRendererState(state) {
  syncAllControls(state);
  syncTimelineControls(state);
  scheduleWorkspaceSave();
}

function syncFrame(state) {
  syncTimelineControls(state);
  drawMirrorWedgeGuides({ ...state, segments: renderer.getCurrentMappingState().segments });
  drawDrawingGuides();
}

function drawDrawingGuides() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (drawingGuides.width !== width || drawingGuides.height !== height) {
    drawingGuides.width = width;
    drawingGuides.height = height;
  }
  const context = drawingGuides.getContext("2d");
  context.clearRect(0, 0, width, height);
  const guide = sourceMode === "drawing" ? drawingSource.getInteractionGuide() : null;
  if (!guide) return;
  const map = point => ({ x: (point.x - rect.left) * dpr, y: (point.y - rect.top) * dpr });
  context.save();
  context.lineWidth = Math.max(1.25, dpr * 1.25);
  context.strokeStyle = "rgba(255, 215, 110, .9)";
  context.setLineDash([5 * dpr, 5 * dpr]);
  for (const line of guide.lines) {
    const from = map(line.from), to = map(line.to);
    context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); context.stroke();
  }
  context.setLineDash([]);
  for (const segment of guide.segments.length ? [guide.segments] : []) {
    if (!segment.length) continue;
    context.beginPath();
    const first = map(segment[0]); context.moveTo(first.x, first.y);
    for (let index = 1; index < segment.length; index += 1) { const point = map(segment[index]); context.lineTo(point.x, point.y); }
    context.stroke();
  }
  for (const anchor of guide.anchors) {
    const point = map(anchor.point);
    context.fillStyle = "#fff"; context.beginPath(); context.arc(point.x, point.y, 4 * dpr, 0, Math.PI * 2); context.fill();
  }
  for (const handle of guide.handles) {
    const point = map(handle.point);
    context.fillStyle = handle.id === guide.activeHandle ? "#ffcf4d" : "#8bd5ff";
    context.beginPath(); context.arc(point.x, point.y, 5 * dpr, 0, Math.PI * 2); context.fill();
  }
  context.restore();
}

function syncAllControls(state = renderer.getState()) {
  const ids = {
    segments:"segments", wallpaperSize:"wallpaperSize", gridRotationDeg:"gridRotation", gridX:"gridX", gridY:"gridY", twist:"twist", zoom:"zoom", rotationDeg:"rotation", panX:"panX", panY:"panY", centerX:"centerX", centerY:"centerY", speedDeg:"speed", driftX:"driftX", driftY:"driftY", driftSpeed:"driftSpeed", pulseAmount:"pulseAmount", pulseSpeed:"pulseSpeed", feedbackAmount:"feedbackAmount", feedbackZoom:"feedbackZoom", feedbackRotateDeg:"feedbackRotate", hue:"hue", bloomStrength:"bloomStrength", bloomThreshold:"bloomThreshold", bloomRadius:"bloomRadius"
  };
  for (const [key, id] of Object.entries(ids)) setControl(id, state[key]);
  $("mirror").checked = state.mirror;
  const supportsMirrorWedges = MIRROR_WEDGE_MODES.has(state.symmetryMode) || (state.symmetryMode === "radial" && state.mirror);
  $("showMirrorGuides").checked = showMirrorGuides;
  $("showMirrorGuides").disabled = !supportsMirrorWedges;
  $("symmetryMode").value = state.symmetryMode;
  $("wallpaperMode").value = state.wallpaperMode;
  $("animate").checked = state.animate;
  $("driftMode").value = state.driftMode;
  $("segmentsLabel").textContent = PLANAR_SYMMETRY_MODES.has(state.symmetryMode) ? "Pattern density" : "Segments";
  document.querySelectorAll(".motionButton").forEach(button => button.classList.toggle("active", state.motion[button.dataset.motion]?.source !== "none"));
  drawMirrorWedgeGuides(state, supportsMirrorWedges);
}

function drawMirrorWedgeGuides(state = renderer.getState(), supportsMirrorWedges = MIRROR_WEDGE_MODES.has(state.symmetryMode) || (state.symmetryMode === "radial" && state.mirror)) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (wedgeGuides.width !== width || wedgeGuides.height !== height) {
    wedgeGuides.width = width;
    wedgeGuides.height = height;
  }
  const context = wedgeGuides.getContext("2d");
  context.clearRect(0, 0, width, height);
  if (!showMirrorGuides || !supportsMirrorWedges) return;

  const centerX = width * state.centerX;
  const centerY = height * (1 - state.centerY);
  const radius = Math.hypot(width, height);
  const lineCount = Math.max(4, Math.round(state.segments) * 2);
  context.strokeStyle = "rgba(255, 255, 255, 0.55)";
  context.lineWidth = Math.max(1, dpr);
  context.setLineDash([5 * dpr, 7 * dpr]);
  context.beginPath();
  for (let index = 0; index < lineCount; index += 1) {
    const angle = index * Math.PI * 2 / lineCount;
    context.moveTo(centerX, centerY);
    context.lineTo(centerX + Math.cos(angle) * radius, centerY - Math.sin(angle) * radius);
  }
  context.stroke();
  context.setLineDash([]);
}

function setControl(id, value) {
  const input = $(id);
  if (!input) return;
  input.value = String(value);
  const num = $(id + "Num");
  if (num) num.value = String(value);
  const out = $(id + "Out");
  if (!out) return;
  if (id === "rotation" || id === "gridRotation" || id === "feedbackRotate") out.value = `${Number(value).toFixed(id === "rotation" || id === "gridRotation" ? 1 : 2)}°`;
  else if (id === "speed") out.value = `${Number(value).toFixed(1)}°/s`;
  else if (id === "driftSpeed" || id === "pulseSpeed") out.value = `${Number(value).toFixed(2)} Hz`;
  else if (id === "segments") out.value = String(Math.round(value));
  else if (id === "feedbackZoom") out.value = Number(value).toFixed(3);
  else out.value = Number(value).toFixed(2);
}

function bindRange(id, key, { preview = true } = {}) {
  const input = $(id), num = $(id + "Num");
  const apply = raw => {
    let value = Number(raw);
    if (!Number.isFinite(value)) return;
    value = Math.min(Number(input.max), Math.max(Number(input.min), value));
    renderer.updateState({ [key]: value }, { preview });
  };
  input.addEventListener("input", () => apply(input.value));
  num?.addEventListener("input", () => apply(num.value));
  num?.addEventListener("change", () => apply(num.value));
}

function bindPostProcessRange(id, key) {
  const input = $(id);
  const apply = raw => {
    const value = Math.min(Number(input.max), Math.max(Number(input.min), Number(raw)));
    if (Number.isFinite(value)) renderer.updatePostProcess({ [key]: value });
  };
  input.addEventListener("input", () => apply(input.value));
}

[
  ["segments","segments"], ["wallpaperSize","wallpaperSize"], ["gridRotation","gridRotationDeg"], ["gridX","gridX"], ["gridY","gridY"], ["twist","twist"], ["zoom","zoom"], ["rotation","rotationDeg"], ["panX","panX"], ["panY","panY"], ["centerX","centerX"], ["centerY","centerY"], ["speed","speedDeg"], ["driftX","driftX"], ["driftY","driftY"], ["driftSpeed","driftSpeed"], ["pulseAmount","pulseAmount"], ["pulseSpeed","pulseSpeed"], ["feedbackAmount","feedbackAmount"], ["feedbackZoom","feedbackZoom"], ["feedbackRotate","feedbackRotateDeg"], ["hue","hue"]
].forEach(([id,key]) => bindRange(id,key));
[["bloomStrength","bloomStrength"],["bloomThreshold","bloomThreshold"],["bloomRadius","bloomRadius"]].forEach(([id,key]) => bindPostProcessRange(id,key));

$("mirror").addEventListener("change", event => renderer.updateState({ mirror:event.target.checked }));
$("showMirrorGuides").addEventListener("change", event => { showMirrorGuides = event.target.checked; drawMirrorWedgeGuides(); });
$("symmetryMode").addEventListener("change", event => renderer.updateState({ symmetryMode:event.target.value }));
$("wallpaperMode").addEventListener("change", event => renderer.updateState({ wallpaperMode:event.target.value }));
$("animate").addEventListener("change", event => renderer.updateState({ animate:event.target.checked }));
$("driftMode").addEventListener("change", event => renderer.updateState({ driftMode:event.target.value }));

const motionMetadata = { zoom:[0,.75,.01], rotationDeg:[0,180,1], panX:[0,.5,.005], panY:[0,.5,.005], driftX:[0,.08,.001], driftY:[0,.08,.001], feedbackAmount:[0,.98,.01], hue:[0,1,.01], segments:[0,16,1], twist:[0,12,.1] };
let motionEditorTarget = null;
function syncMotionEditor() {
  if (!motionEditorTarget) return;
  const motion = renderer.getState().motion[motionEditorTarget], meta = motionMetadata[motionEditorTarget];
  $("motionTargetName").textContent = motionEditorTarget;
  $("motionAmount").min=meta[0]; $("motionAmount").max=meta[1]; $("motionAmount").step=meta[2];
  $("motionSpeed").value=motion.speed; $("motionAmount").value=motion.amount; $("motionPhase").value=motion.phase;
  $("motionSpeedOut").value=`${motion.speed.toFixed(2)} Hz`; $("motionAmountOut").value=motion.amount.toFixed(2); $("motionPhaseOut").value=motion.phase.toFixed(2);
  const selected=document.querySelector(`input[name="motionSource"][value="${motion.source}"]`); if(selected)selected.checked=true;
  $("motionSourceControls").hidden=motion.source === "none";
}
document.querySelectorAll(".motionButton").forEach(button => button.addEventListener("click", () => { motionEditorTarget=button.dataset.motion; $("motionEditor").hidden=false; syncMotionEditor(); }));
$("closeMotionEditor").addEventListener("click", () => { $("motionEditor").hidden=true; motionEditorTarget=null; });
document.querySelectorAll('input[name="motionSource"]').forEach(input => input.addEventListener("change", () => { if(motionEditorTarget&&input.checked){renderer.updateMotion(motionEditorTarget,{source:input.value});syncMotionEditor();} }));
[["motionSpeed","speed"],["motionAmount","amount"],["motionPhase","phase"]].forEach(([id,field]) => $(id).addEventListener("input", event => { if(motionEditorTarget){renderer.updateMotion(motionEditorTarget,{[field]:Number(event.target.value)});syncMotionEditor();} }));

function renderTimelineTicks(state = renderer.getState()) {
  const center=Math.round(state.currentTime); if(center===lastTimelineTickSecond)return; lastTimelineTickSecond=center;
  const fragment=document.createDocumentFragment(); for(let offset=-TIMELINE_HALF_WINDOW;offset<=TIMELINE_HALF_WINDOW;offset+=5){const tick=document.createElement("div"),label=document.createElement("span");tick.className="timelineTick";tick.style.left=`${((offset+TIMELINE_HALF_WINDOW)/(TIMELINE_HALF_WINDOW*2))*100}%`;label.textContent=`${center+offset}s`;tick.append(label);fragment.append(tick);} $("timelineTicks").replaceChildren(fragment);
}
function syncTimelineControls(state = renderer.getState()) { $("timelineNum").value=state.currentTime.toFixed(2); $("timelineOut").value=`${state.currentTime.toFixed(2)} s`; $("playPause").textContent=state.playing?"Pause":"Play"; $("timeline").setAttribute("aria-valuenow",state.currentTime); renderTimelineTicks(state); }
function seek(value, options) { renderer.seekToTime(Number(value),options); }
$("timelineNum").addEventListener("input", () => seek($("timelineNum").value,{pause:true,livePreview:true}));
$("timelineNum").addEventListener("change", () => seek($("timelineNum").value,{pause:true}));
let timelinePointer=null;
$("timeline").addEventListener("pointerdown", event => { timelinePointer={id:event.pointerId,startX:event.clientX,startTime:renderer.getState().currentTime}; $("timeline").setPointerCapture(event.pointerId); event.preventDefault(); });
$("timeline").addEventListener("pointermove", event => { if(!timelinePointer||timelinePointer.id!==event.pointerId)return;const secondsPerPixel=(TIMELINE_HALF_WINDOW*2)/Math.max($("timeline").getBoundingClientRect().width,1);seek(timelinePointer.startTime+(event.clientX-timelinePointer.startX)*secondsPerPixel,{pause:true,livePreview:true}); });
for(const eventName of ["pointerup","pointercancel"]) $("timeline").addEventListener(eventName,event=>{if(timelinePointer?.id===event.pointerId){timelinePointer=null;seek(renderer.getState().currentTime,{pause:true});}});
$("playPause").addEventListener("click",()=>renderer.updateState({playing:!renderer.getState().playing},{preview:false}));
$("stepBack").addEventListener("click",()=>seek(renderer.getState().currentTime-1,{pause:true})); $("stepForward").addEventListener("click",()=>seek(renderer.getState().currentTime+1,{pause:true}));
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && sourceMode === "drawing" && drawingSource.cancelConstruction()) {
    event.preventDefault();
    drawDrawingGuides();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    if (event.target instanceof Element && event.target.closest("input, select, textarea, [contenteditable='true']")) return;
    const changed = sourceMode === "drawing" && (event.shiftKey ? drawingSource.redo() : drawingSource.undo());
    if (changed) {
      event.preventDefault();
      refreshDrawingHistoryControls();
      scheduleWorkspaceSave();
    }
    return;
  }
  if (event.code !== "Space" || event.repeat) return;
  if (event.target instanceof Element && event.target.closest("input, select, textarea, button, [contenteditable='true']")) return;
  event.preventDefault();
  renderer.updateState({ playing: !renderer.getState().playing }, { preview: false });
});

async function loadSource(source, { persist = false } = {}) {
  try { await bitmapSource.load(source); if(persist) await bitmapSource.save(source); setSourceMode("bitmap"); $("dropHint").style.display="none"; setPersistenceStatus(persist?"Workspace and source image saved in this browser.":"Previous workspace restored."); }
  catch(error){console.warn("Unable to load source image",error);setPersistenceStatus("The source image could not be decoded.");}
}
$("file").addEventListener("change", event=>{const file=event.target.files?.[0];if(file)loadSource(file,{persist:true});});
for(const name of ["dragenter","dragover"])canvas.addEventListener(name,event=>event.preventDefault());
canvas.addEventListener("drop",event=>{event.preventDefault();const file=event.dataTransfer?.files?.[0];if(file)loadSource(file,{persist:true});});
let dragging=false,lastX=0,lastY=0,secondaryCanvasGesture=null;
canvas.addEventListener("pointerdown",event=>{
  if (event.button === 2) {
    if (sourceMode === "drawing" && drawingSource.cancelConstruction()) {
      event.preventDefault();
      drawDrawingGuides();
      return;
    }
    event.preventDefault();
    secondaryCanvasGesture = {
      pointerId: event.pointerId,
      mode: event.ctrlKey ? "timeline" : "drift",
      lastX: event.clientX,
      lastY: event.clientY
    };
    renderer.beginInteraction();
    canvas.setPointerCapture(event.pointerId);
    return;
  }
  if (sourceMode === "drawing") {
    if (event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    activeSource.pointerDown?.(event, canvas);
    drawDrawingGuides();
    return;
  }
  if (event.button !== 0) return;
  dragging=true;lastX=event.clientX;lastY=event.clientY;renderer.beginInteraction();canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove",event=>{
  if (secondaryCanvasGesture?.pointerId === event.pointerId) {
    const gesture = secondaryCanvasGesture;
    const rect = canvas.getBoundingClientRect();
    const deltaX = event.clientX - gesture.lastX;
    const deltaY = event.clientY - gesture.lastY;
    gesture.lastX = event.clientX;
    gesture.lastY = event.clientY;
    if (gesture.mode === "drift") {
      const state = renderer.getState();
      renderer.updateState({
        driftX: Math.min(.25, Math.max(-.25, state.driftX + deltaX / Math.max(rect.width, 1) * .25)),
        driftY: Math.min(.25, Math.max(-.25, state.driftY + deltaY / Math.max(rect.height, 1) * .25))
      });
    } else {
      const secondsPerPixel = (TIMELINE_HALF_WINDOW * 2) / Math.max(rect.width, 1);
      seek(renderer.getState().currentTime + deltaX * secondsPerPixel, { pause: true, livePreview: true });
    }
    return;
  }
  if (sourceMode === "drawing") {
    activeSource.pointerMove?.(event, canvas);
    drawDrawingGuides();
    return;
  }
  if(!dragging)return;const rect=canvas.getBoundingClientRect();renderer.panBy((event.clientX-lastX)/rect.width,(event.clientY-lastY)/rect.height);lastX=event.clientX;lastY=event.clientY;
});
for(const name of ["pointerup","pointercancel"])canvas.addEventListener(name,event=>{
  if (secondaryCanvasGesture?.pointerId === event.pointerId) {
    const mode = secondaryCanvasGesture.mode;
    secondaryCanvasGesture = null;
    renderer.endInteraction();
    if (name !== "pointercancel" && mode === "timeline") seek(renderer.getState().currentTime, { pause: true });
    return;
  }
  if (sourceMode === "drawing") {
    if (name === "pointercancel") activeSource.pointerCancel?.(event);
    else activeSource.pointerUp?.(event);
    drawDrawingGuides();
    refreshDrawingHistoryControls();
    if (name !== "pointercancel") scheduleWorkspaceSave();
    return;
  }
  if(dragging){dragging=false;renderer.endInteraction();}
});
canvas.addEventListener("contextmenu", event => event.preventDefault());
canvas.addEventListener("wheel",event=>{event.preventDefault();renderer.zoomBy(Math.exp(-event.deltaY*.001));},{passive:false});

$("sourceImage").addEventListener("click", () => setSourceMode("bitmap"));
$("sourceDrawing").addEventListener("click", () => setSourceMode("drawing"));
function syncDrawingBrushControls(name = drawingSource.brushName) {
  $("drawingRibbonControls").hidden = name !== "ribbon";
  $("drawingCalligraphyControls").hidden = name !== "calligraphy";
  $("drawingSprayControls").hidden = name !== "spray";
  $("drawingTextureControls").hidden = name !== "texture";
  syncDrawingColorControls(drawingSource.colorMode);
  if (name === "texture") {
    loadCurrentTexture();
  }
}
function syncDrawingColorControls(mode = drawingSource.colorMode) {
  $("drawingSolidColorControl").hidden = mode !== "solid";
  $("drawingGradientColorControls").hidden = mode !== "gradient";
}
function syncDrawingControls() {
  $("drawingBrush").value = drawingSource.brushName;
  $("drawingBackgroundColor").value = drawingSource.backgroundColor;
  $("drawingColorMode").value = drawingSource.colorMode;
  $("drawingColor").value = drawingSource.color;
  $("drawingGradientStartColor").value = drawingSource.gradientStartColor;
  $("drawingGradientEndColor").value = drawingSource.gradientEndColor;
  $("drawingSize").value = String(drawingSource.size);
  $("drawingOpacity").value = String(drawingSource.opacity);
  $("drawingSmoothing").value = String(Math.round(drawingSource.smoothing * 100));
  $("drawingSmoothingOut").value = `${Math.round(drawingSource.smoothing * 100)}%`;
  $("drawingLines").value = String(drawingSource.lines);
  $("drawingSpan").value = String(drawingSource.span);
  $("drawingNibRatio").value = String(drawingSource.nibRatio);
  $("drawingDensity").value = String(drawingSource.density);
  $("drawingParticleSize").value = String(drawingSource.particleSize);
  $("drawingTextureSpacing").value = String(drawingSource.textureSpacing);
  $("drawingTextureSpacingOut").value = `${drawingSource.textureSpacing.toFixed(2)}×`;
  const rotation = document.querySelector(`input[name="drawingTextureRotation"][value="${drawingSource.textureRotationMode}"]`);
  if (rotation) rotation.checked = true;
  syncDrawingBrushControls();
  syncDrawingColorControls();
  syncCurrentTexture();
}
function refreshDrawingHistoryControls() {
  $("undoDrawing").disabled = !drawingSource.canUndo();
  $("redoDrawing").disabled = !drawingSource.canRedo();
}
$("drawingBrush").addEventListener("change", event => {
  drawingSource.setBrush(event.target.value);
  // Pen begins at 8px, which reduces even a detailed PNG tip to a line. Give
  // Texture a useful first-use size without overriding an intentional size.
  if (event.target.value === "texture" && drawingSource.size === 8) {
    drawingSource.setSize(64);
    $("drawingSize").value = "64";
  }
  syncDrawingBrushControls();
  drawDrawingGuides();
});
$("drawingSmoothing").addEventListener("input", event => {
  const percent = Number(event.target.value);
  drawingSource.setSmoothing(percent / 100);
  $("drawingSmoothingOut").value = `${Math.round(percent)}%`;
});
$("drawingColor").addEventListener("input", event => drawingSource.setColor(event.target.value));
function applyDrawingBackgroundColor(value) {
  drawingSource.setBackgroundColor(value);
}
$("drawingBackgroundColor").addEventListener("input", event => applyDrawingBackgroundColor(event.target.value));
$("drawingBackgroundColor").addEventListener("change", event => applyDrawingBackgroundColor(event.target.value));
$("drawingColorMode").addEventListener("change", event => {
  drawingSource.setColorMode(event.target.value);
  syncDrawingColorControls();
});
$("drawingGradientStartColor").addEventListener("input", event => drawingSource.setGradientStartColor(event.target.value));
$("drawingGradientEndColor").addEventListener("input", event => drawingSource.setGradientEndColor(event.target.value));
$("drawingSize").addEventListener("input", event => drawingSource.setSize(event.target.value));
$("drawingOpacity").addEventListener("input", event => drawingSource.setOpacity(event.target.value));
$("drawingLines").addEventListener("input", event => drawingSource.setLines(event.target.value));
$("drawingSpan").addEventListener("input", event => drawingSource.setSpan(event.target.value));
$("drawingNibRatio").addEventListener("input", event => drawingSource.setNibRatio(event.target.value));
$("drawingDensity").addEventListener("input", event => drawingSource.setDensity(event.target.value));
$("drawingParticleSize").addEventListener("input", event => drawingSource.setParticleSize(event.target.value));
$("drawingTextureSpacing").addEventListener("input", event => {
  drawingSource.setTextureSpacing(event.target.value);
  $("drawingTextureSpacingOut").value = `${Number(event.target.value).toFixed(2)}×`;
});
document.querySelectorAll('input[name="drawingTextureRotation"]').forEach(input => input.addEventListener("change", event => {
  if (event.target.checked) drawingSource.setTextureRotationMode(event.target.value);
}));
$("undoDrawing").addEventListener("click", () => { drawingSource.undo(); refreshDrawingHistoryControls(); scheduleWorkspaceSave(); });
$("redoDrawing").addEventListener("click", () => { drawingSource.redo(); refreshDrawingHistoryControls(); scheduleWorkspaceSave(); });
$("clearDrawing").addEventListener("click", () => { drawingSource.clear(); refreshDrawingHistoryControls(); scheduleWorkspaceSave(); });

const brushDialog = $("brushBrowser");
function drawTexturePreview(canvas, texture) {
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (texture) context.drawImage(texture.thumbnailCanvas, 0, 0, canvas.width, canvas.height);
}
function syncCurrentTexture() {
  const entry = brushTextureCatalog.getEntry(drawingSource.textureId) || brushTextureCatalog.getEntry(DEFAULT_BRUSH_TEXTURE_ID);
  $("drawingCurrentTextureName").textContent = entry?.label || "No brush selected";
  drawTexturePreview($("drawingCurrentTexturePreview"), brushTextureCatalog.get(drawingSource.textureId));
  document.querySelectorAll("[data-brush-texture-id]").forEach(tile => {
    const selected = tile.dataset.brushTextureId === drawingSource.textureId;
    tile.setAttribute("aria-pressed", String(selected));
    tile.classList.toggle("selected", selected);
  });
}
function updateTextureTile(id) {
  const tile = document.querySelector(`[data-brush-texture-id="${id}"]`);
  if (!tile) return;
  const texture = brushTextureCatalog.get(id);
  tile.disabled = brushTextureCatalog.isFailed(id);
  tile.classList.toggle("unavailable", brushTextureCatalog.isFailed(id));
  const preview = tile.querySelector("canvas");
  if (texture && preview) drawTexturePreview(preview, texture);
}
async function loadCurrentTexture(id = drawingSource.textureId) {
  const pending = drawingSource.setTextureId(id);
  $("drawingTextureStatus").textContent = "Loading brush tip…";
  syncCurrentTexture();
  const texture = await pending;
  const fellBack = drawingSource.textureId !== id && id === DEFAULT_BRUSH_TEXTURE_ID && texture;
  if (drawingSource.textureId !== id && !fellBack) {
    updateTextureTile(id);
    return;
  }
  $("drawingTextureStatus").textContent = texture ? "" : "Brush tip unavailable.";
  syncCurrentTexture();
  updateTextureTile(id);
  if (drawingSource.textureId !== id) updateTextureTile(drawingSource.textureId);
}
function renderBrushBrowser() {
  const grid = $("brushBrowserGrid");
  if (grid.childElementCount) return;
  for (const entry of BRUSH_TEXTURES) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "brushTile";
    tile.dataset.brushTextureId = entry.id;
    tile.setAttribute("aria-pressed", String(entry.id === drawingSource.textureId));
    const preview = document.createElement("canvas");
    preview.width = 96; preview.height = 96;
    preview.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = entry.label;
    tile.append(preview, label);
    tile.addEventListener("click", () => {
      loadCurrentTexture(entry.id);
    });
    grid.append(tile);
  }
  BRUSH_TEXTURES.forEach((entry, index) => setTimeout(async () => {
    await brushTextureCatalog.ensure(entry.id);
    updateTextureTile(entry.id);
    if (entry.id === drawingSource.textureId) syncCurrentTexture();
  }, index * 20));
}
$("browseBrushes").addEventListener("click", () => {
  renderBrushBrowser();
  if (!brushDialog.open) brushDialog.showModal();
});
$("closeBrushBrowser").addEventListener("click", () => brushDialog.close());
$("closeBrushBrowserFooter").addEventListener("click", () => brushDialog.close());
$("brushBrowserSearch").addEventListener("input", event => {
  const query = event.target.value.trim().toLowerCase();
  document.querySelectorAll("[data-brush-texture-id]").forEach(tile => {
    const entry = brushTextureCatalog.getEntry(tile.dataset.brushTextureId);
    tile.hidden = Boolean(query) && !`${entry.label} ${entry.id}`.toLowerCase().includes(query);
  });
});
syncDrawingBrushControls();
syncDrawingColorControls();
refreshDrawingHistoryControls();

const presets={flower:{segments:12,mirror:true,symmetryMode:"mirrorRadial",twist:0,zoom:1.35,rotationDeg:8,speedDeg:4,driftX:.01,driftY:.01,driftMode:"orbit",driftSpeed:.05,pulseAmount:.03,pulseSpeed:.2,feedbackAmount:.15,feedbackZoom:1.002,feedbackRotateDeg:.1},crystal:{segments:16,mirror:true,symmetryMode:"mirrorRadial",twist:0,zoom:1.05,rotationDeg:0,speedDeg:0,driftX:.02,driftY:.02,driftMode:"smoothRandom",driftSpeed:.35,pulseAmount:.01,pulseSpeed:.15,feedbackAmount:.35,feedbackZoom:1.003,feedbackRotateDeg:.18},tunnel:{segments:8,mirror:true,symmetryMode:"tunnel",twist:4,zoom:1.1,rotationDeg:0,speedDeg:0,driftX:.01,driftY:.01,driftMode:"linear",driftSpeed:.1,pulseAmount:.08,pulseSpeed:.3,feedbackAmount:.6,feedbackZoom:1.006,feedbackRotateDeg:.35}};
document.querySelectorAll(".preset").forEach(button=>button.addEventListener("click",()=>renderer.updateState(presets[button.dataset.preset],{preview:false})));

function pickRecordingFormat(){for(const f of [{mime:"video/mp4;codecs=avc1.42E01E",ext:"mp4"},{mime:"video/mp4",ext:"mp4"},{mime:"video/webm;codecs=vp9",ext:"webm"},{mime:"video/webm",ext:"webm"}])if(typeof MediaRecorder!=="undefined"&&MediaRecorder.isTypeSupported(f.mime))return f;return null;}
$("startRecording").addEventListener("click",()=>{const format=pickRecordingFormat();if(!canvas.captureStream||!format){$("recordingStatus").textContent="Canvas recording is not supported by this browser.";return;}const fps=Number($("recordFps").value)||60,stream=canvas.captureStream(0);recordingTrack=stream.getVideoTracks()[0]||null;recordingFrameInterval=1000/fps;lastRecordedFrameTime=-Infinity;recordedChunks=[];try{mediaRecorder=new MediaRecorder(stream,{mimeType:format.mime,videoBitsPerSecond:12000000});}catch(error){stream.getTracks().forEach(track=>track.stop());recordingTrack=null;$("recordingStatus").textContent="Unable to start canvas recording in this browser.";return;}mediaRecorder.ondataavailable=e=>{if(e.data.size)recordedChunks.push(e.data);};mediaRecorder.onstop=()=>{const a=document.createElement("a"),url=URL.createObjectURL(new Blob(recordedChunks,{type:format.mime}));a.href=url;a.download=`kaleidoscope.${format.ext}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);stream.getTracks().forEach(track=>track.stop());recordingTrack=null;$("startRecording").disabled=false;$("stopRecording").disabled=true;$("recordingStatus").textContent="Recording saved.";};mediaRecorder.start(1000);requestRecordingFrame();$("recordingStatus").textContent=`Recording ${fps} fps…`;$("startRecording").disabled=true;$("stopRecording").disabled=false;});
$("stopRecording").addEventListener("click",()=>{if(mediaRecorder?.state!=="inactive"){ $("recordingStatus").textContent="Finalizing recording...";mediaRecorder.stop();}});
$("save").addEventListener("click",()=>{const a=document.createElement("a");a.download="kaleidoscope.png";a.href=canvas.toDataURL("image/png");a.click();});

document.addEventListener("input",scheduleWorkspaceSave,true); document.addEventListener("change",scheduleWorkspaceSave,true); window.addEventListener("pagehide",saveWorkspaceSettingsNow);
window.addEventListener("resize", () => drawMirrorWedgeGuides());
persistenceEnabled=false; const hadSavedSettings=restoreWorkspaceSettings(); populateWallpaperModes(); syncAllControls(); syncTimelineControls(); syncDrawingControls(); refreshDrawingHistoryControls(); persistenceEnabled=true;
setPersistenceStatus(hadSavedSettings?"Settings restored. Restoring source image...":"Local workspace save enabled."); renderer.start();
setTimeout(async()=>{try{const result=await bitmapSource.restore();if(result.restored){if(sourceMode==="bitmap")setSourceMode("bitmap");$("dropHint").style.display="none";setPersistenceStatus(result.migrated?"Previous workspace restored and image migrated to IndexedDB.":"Previous workspace restored.");}}catch(error){console.warn("Unable to restore source image",error);setPersistenceStatus("Settings restored; saved source image could not be decoded.");}},0);
saveWorkspaceSettingsNow();
