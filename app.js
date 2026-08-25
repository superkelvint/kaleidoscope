import { Renderer } from "./render.js";
import { BitmapSource } from "./bitmap-source.js";
import { DrawingSource } from "./drawing-source.js";
import { DRAWING_BRUSHES, DrawingController } from "./drawing-controller.js";
import { BRUSH_TEXTURES, DEFAULT_BRUSH_TEXTURE_ID, brushTextureCatalog } from "./brush-textures.js";
import { GLOBAL_WALLPAPER_MODES } from "./global-wallpaper.js";
import { GENERATORS } from "./generators.js";

const $ = id => document.getElementById(id);
const canvas = $("gl");
const wedgeGuides = $("wedgeGuides");
const drawingGuides = $("drawingGuides");
const referenceOverlay = $("referenceOverlay");
const referenceImage = $("referenceImage");
const bitmapSource = new BitmapSource();
let activeSource = bitmapSource;
let sourceMode = "bitmap";
const WORKSPACE_STORAGE_KEY = "kaleidoscope.workspace.v13";
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
let referenceObjectUrl = null;
const referenceState = { visible: true, opacity: .5, editing: false, x: 0, y: 0, width: 0, height: 0 };
let referencePointer = null;
let generatorDraft = null;
let generatorEditorId = null;
let fpsWindowStarted = performance.now();
let fpsFrameCount = 0;

function requestRecordingFrame() {
  if (!recordingTrack?.requestFrame || mediaRecorder?.state !== "recording") return;
  const time = performance.now();
  if (time - lastRecordedFrameTime < recordingFrameInterval) return;
  lastRecordedFrameTime = time;
  recordingTrack.requestFrame();
}

function updateFpsMeter() {
  fpsFrameCount += 1;
  const now = performance.now(), elapsed = now - fpsWindowStarted;
  if (elapsed < 500) return;
  $("fpsMeter").value = `${Math.round(fpsFrameCount * 1000 / elapsed)} FPS`;
  fpsFrameCount = 0;
  fpsWindowStarted = now;
}

const renderer = new Renderer(canvas, {
  onStateChange: syncRendererState,
  onBeforeFrame: state => drawingSource.setTime(state.currentTime),
  onFrame: syncFrame,
  // Canvas capture receives the fully composited frame, including bloom,
  // regardless of whether that frame came from a bitmap or DrawingSource.
  onPresent: () => { requestRecordingFrame(); updateFpsMeter(); }
});
const drawingSource = new DrawingSource({ onFrameChange: () => renderer.requestRender() });
const drawingController = new DrawingController({ source: drawingSource, getRendererState: () => renderer.getCurrentMappingState() });

const DRAWING_CURSOR_BY_BRUSH = {
  pen: "pen",
  ribbon: "ribbon",
  calligraphy: "calligraphy",
  spray: "spray",
  texture: "texture",
  fiber: "fiber",
  hair: "fiber"
};

function updateCanvasCursor() {
  if (sourceMode !== "drawing") {
    delete canvas.dataset.cursor;
    return;
  }
  const tool = drawingController.settings.tool;
  canvas.dataset.cursor = tool === "freehand"
    ? DRAWING_CURSOR_BY_BRUSH[drawingController.settings.brush] || "pen"
    : tool;
}

function setPersistenceStatus(message) { $("persistenceStatus").textContent = message; }

function setSourceMode(mode) {
  if (mode !== "bitmap" && mode !== "drawing") {
    throw new Error(`Unsupported source mode: ${mode}`);
  }
  if (mode !== sourceMode) drawingController.cancel();
  sourceMode = mode;
  activeSource = mode === "drawing" ? drawingSource : bitmapSource;
  renderer.setSource(activeSource);
  $("bitmapControls").hidden = mode !== "bitmap";
  $("drawingControls").hidden = mode !== "drawing";
  updateReferenceOverlay();
  refreshDrawingHistoryControls();
  $("sourceImage").classList.toggle("active", mode === "bitmap");
  $("sourceImage").setAttribute("aria-pressed", String(mode === "bitmap"));
  $("sourceDrawing").classList.toggle("active", mode === "drawing");
  $("sourceDrawing").setAttribute("aria-pressed", String(mode === "drawing"));
  $("dropHint").style.display = mode === "bitmap" && !bitmapSource.getFrame() ? "grid" : "none";
  updateCanvasCursor();
}

function updateReferenceOverlay() {
  const hasImage = Boolean(referenceImage.getAttribute("src"));
  referenceOverlay.hidden = sourceMode !== "drawing" || !hasImage || !referenceState.visible;
  referenceOverlay.classList.toggle("editing", !referenceOverlay.hidden && referenceState.editing);
  referenceOverlay.style.opacity = String(referenceState.opacity);
  referenceOverlay.style.left = `${referenceState.x}px`;
  referenceOverlay.style.top = `${referenceState.y}px`;
  referenceOverlay.style.width = `${referenceState.width}px`;
  referenceOverlay.style.height = `${referenceState.height}px`;
}

function syncReferenceControls() {
  $("referenceVisible").checked = referenceState.visible;
  $("referenceOpacity").value = String(referenceState.opacity);
  $("referenceOpacityOut").value = `${Math.round(referenceState.opacity * 100)}%`;
  $("referenceEditing").checked = referenceState.editing;
  updateReferenceOverlay();
}

function resetReferencePlacement() {
  if (!referenceImage.naturalWidth || !referenceImage.naturalHeight) return;
  const rect = canvas.getBoundingClientRect();
  const scale = Math.min(rect.width * .7 / referenceImage.naturalWidth, rect.height * .7 / referenceImage.naturalHeight, 1);
  referenceState.width = Math.max(1, referenceImage.naturalWidth * scale);
  referenceState.height = Math.max(1, referenceImage.naturalHeight * scale);
  referenceState.x = (rect.width - referenceState.width) / 2;
  referenceState.y = (rect.height - referenceState.height) / 2;
  updateReferenceOverlay();
}

function loadReferenceImage(file) {
  if (!file?.type.startsWith("image/")) return;
  if (referenceObjectUrl) URL.revokeObjectURL(referenceObjectUrl);
  referenceObjectUrl = URL.createObjectURL(file);
  referenceImage.onload = () => {
    resetReferencePlacement();
    scheduleWorkspaceSave();
  };
  referenceImage.src = referenceObjectUrl;
}

function workspaceSnapshot() {
  return {
    state: renderer.getState(),
    // Version 12 stores paths in the continuous drawing world. Earlier
    // fixed-bitmap coordinates deliberately are not replayed into it.
    drawing: { version: 2, settings: drawingController.getState(), content: drawingSource.getContentState() },
    sourceMode,
    showMirrorGuides,
    reference: { visible: referenceState.visible, opacity: referenceState.opacity },
    recordFps: Number($("recordFps").value) || 60
  };
}

function saveWorkspaceSettingsNow() {
  if (!persistenceEnabled) return;
  try { localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspaceSnapshot())); }
  catch (error) { console.warn("Unable to save workspace settings", error); setPersistenceStatus("Browser storage is unavailable; workspace is not being saved."); }
}

$("resetWorkspace").addEventListener("click", () => {
  if (!window.confirm("Reset the workspace? This clears saved renderer settings and all drawing history. Your saved source image is kept.")) return;
  persistenceEnabled = false;
  clearTimeout(persistenceTimer);
  localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  window.location.reload();
});

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
    if (saved.reference) {
      referenceState.visible = saved.reference.visible !== false;
      const opacity = Number(saved.reference.opacity);
      if (Number.isFinite(opacity)) referenceState.opacity = Math.min(1, Math.max(0, opacity));
    }
    renderer.restoreState(saved.state);
    if (saved.drawing?.version === 1) { drawingController.restoreState(saved.drawing.settings); drawingSource.restoreContentState(saved.drawing.content); }
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
  drawingSource.setTime(state.currentTime);
  syncGeneratorMotionButton(state);
  syncAllControls(state);
  syncTimelineControls(state);
  scheduleWorkspaceSave();
}

function syncFrame(state) {
  drawingSource.setTime(state.currentTime);
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
  const guide = sourceMode === "drawing" ? drawingController.getInteractionGuide() : null;
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
$("resetCanvasDrift").addEventListener("click", () => {
  renderer.updateState({ driftX: 0, driftY: 0 }, { preview: false });
  seek(0, { pause: true });
});

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
  if (event.key === "Escape" && sourceMode === "drawing" && drawingController.cancel()) {
    event.preventDefault();
    drawDrawingGuides();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    if (event.target instanceof Element && event.target.closest("input, select, textarea, [contenteditable='true']")) return;
    const changed = sourceMode === "drawing" && !event.shiftKey && drawingSource.undo();
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
    if (sourceMode === "drawing" && drawingController.cancel()) {
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
    if (generatorDraft) return;
    canvas.setPointerCapture(event.pointerId);
    drawingController.begin(event, canvas);
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
    if (generatorDraft) return;
    drawingController.move(event);
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
    if (generatorDraft) return;
    if (name === "pointercancel") drawingController.cancel(event);
    else drawingController.end(event);
    drawDrawingGuides();
    refreshDrawingHistoryControls();
    if (name !== "pointercancel") scheduleWorkspaceSave();
    return;
  }
  if(dragging){dragging=false;renderer.endInteraction();}
});
canvas.addEventListener("contextmenu", event => event.preventDefault());
canvas.addEventListener("wheel",event=>{event.preventDefault();renderer.zoomBy(Math.exp(-event.deltaY*.001));},{passive:false});

$("referenceFile").addEventListener("change", event => {
  const file = event.target.files?.[0];
  if (file) loadReferenceImage(file);
  event.target.value = "";
});
$("referenceVisible").addEventListener("change", event => {
  referenceState.visible = event.target.checked;
  updateReferenceOverlay();
});
$("referenceOpacity").addEventListener("input", event => {
  referenceState.opacity = Number(event.target.value);
  $("referenceOpacityOut").value = `${Math.round(referenceState.opacity * 100)}%`;
  updateReferenceOverlay();
});
$("referenceEditing").addEventListener("change", event => {
  referenceState.editing = event.target.checked;
  updateReferenceOverlay();
});
$("resetReference").addEventListener("click", resetReferencePlacement);
referenceOverlay.addEventListener("pointerdown", event => {
  if (!referenceState.editing || event.button !== 0) return;
  const resizing = event.target === $("referenceResizeHandle");
  referencePointer = {
    id: event.pointerId,
    resizing,
    startX: event.clientX,
    startY: event.clientY,
    x: referenceState.x,
    y: referenceState.y,
    width: referenceState.width,
    height: referenceState.height
  };
  referenceOverlay.setPointerCapture(event.pointerId);
  event.preventDefault();
});
referenceOverlay.addEventListener("pointermove", event => {
  if (!referencePointer || referencePointer.id !== event.pointerId) return;
  const gesture = referencePointer;
  const deltaX = event.clientX - gesture.startX;
  const deltaY = event.clientY - gesture.startY;
  if (gesture.resizing) {
    const aspect = gesture.width / Math.max(gesture.height, 1);
    const width = Math.max(24, gesture.width + deltaX);
    referenceState.width = width;
    referenceState.height = width / aspect;
  } else {
    referenceState.x = gesture.x + deltaX;
    referenceState.y = gesture.y + deltaY;
  }
  updateReferenceOverlay();
  event.preventDefault();
});
for (const eventName of ["pointerup", "pointercancel"]) referenceOverlay.addEventListener(eventName, event => {
  if (!referencePointer || referencePointer.id !== event.pointerId) return;
  referencePointer = null;
  if (eventName === "pointerup") scheduleWorkspaceSave();
});

$("sourceImage").addEventListener("click", () => setSourceMode("bitmap"));
$("sourceDrawing").addEventListener("click", () => setSourceMode("drawing"));
function makeSpirographDraft() {
  const generator = GENERATORS.spirograph;
  if (!DRAWING_BRUSHES.includes(drawingController.settings.brush)) drawingController.setBrush("pen");
  return {
    kind: "generatedStroke",
    generator: generator.id,
    generatorVersion: generator.version,
    config: structuredClone(generator.defaults),
    animation: { amount: .5, speed: .15, phase: 0 },
    domain: { start: 0, end: generator.period() },
    sampling: { mode: "parameter", step: .01 },
    style: drawingController.styleSnapshot()
  };
}
function makeGuillocheRosetteDraft() {
  const generator = GENERATORS.guillocheRosette;
  if (!DRAWING_BRUSHES.includes(drawingController.settings.brush)) drawingController.setBrush("pen");
  return {
    kind: "generatedStroke", generator: generator.id, generatorVersion: generator.version,
    config: structuredClone(generator.defaults),
    animation: { amount: .5, speed: .15, targets: { phaseOffset: false, secondaryAmplitude: false, secondaryFrequency: false, rotation: false } },
    domain: { start: 0, end: generator.period() },
    sampling: { mode: "parameter", step: .01 }, style: drawingController.styleSnapshot()
  };
}
function editedGenerator() { return generatorEditorId ? drawingSource.getDrawable(generatorEditorId) : null; }
function latestGenerated() { return drawingSource.findLatestDrawable(drawable => drawable?.kind === "generatedStroke"); }
function activeGenerator() { return generatorDraft || editedGenerator(); }
function syncGeneratorMotionButton(state = renderer.getState()) {
  const button = $("toggleGeneratorMotion");
  if (button) button.textContent = state.playing ? "Stop motion" : "Start motion";
  const rosetteButton = $("toggleGuillocheRosetteMotion");
  if (rosetteButton) rosetteButton.textContent = state.playing ? "Stop motion" : "Start motion";
}
function syncGeneratorControls() {
  const drawable = activeGenerator();
  const editing = Boolean(!generatorDraft && drawable);
  if (!drawable) generatorEditorId = null;
  $("drawingGenerator").value = drawable?.generator || "none";
  $("spirographControls").hidden = !drawable || drawable.generator !== "spirograph";
  $("guillocheRosetteControls").hidden = !drawable || drawable.generator !== "guillocheRosette";
  const latest = latestGenerated();
  $("editLatestGenerator").hidden = Boolean(drawable) || latest === null;
  $("editLatestGenerator").textContent = `Edit latest ${latest === null ? "generator" : latest.drawable.generator === "guillocheRosette" ? "Guilloché Rosette" : "Spirograph"}`;
  $("spirographEditorStatus").textContent = drawable?.generator === "spirograph" ? (generatorDraft ? "Draft preview — Commit to add it to the drawing." : editing ? "Editing committed Spirograph — changes are saved immediately." : "") : "";
  $("commitGenerator").textContent = editing ? "Done" : "Commit";
  $("resetGenerator").textContent = editing ? "Stop Editing" : "Reset";
  syncGeneratorMotionButton();
  if (!drawable) return;
  if (drawable.generator === "guillocheRosette") { syncGuillocheRosetteControls(drawable, editing); return; }
  const values = {
    Lobes: [drawable.config.lobes, value => String(Math.round(value))],
    PenOffset: [drawable.config.penOffset, value => Number(value).toFixed(2)],
    Reach: [drawable.config.reach, value => Number(value).toFixed(2)],
    Rotation: [drawable.config.rotation * 180 / Math.PI, value => `${Math.round(value)}°`],
    Arms: [drawable.config.arms, value => String(Math.round(value))],
    Motion: [drawable.animation.amount, value => Number(value).toFixed(2)],
    Speed: [drawable.animation.speed, value => `${Number(value).toFixed(2)} Hz`]
  };
  for (const [name, [value, format]] of Object.entries(values)) {
    $("spirograph" + name).value = String(value);
    $("spirograph" + name + "Out").value = format(value);
  }
}
function previewGeneratorDraft() {
  drawingSource.setTime(renderer.getState().currentTime);
  drawingSource.previewDrawable(generatorDraft);
  syncGeneratorControls();
  // A draft is a source-pixel change, not renderer state. Request one normal
  // presentation pass so a paused timeline shows it immediately.
  renderer.updateState({}, { preview: true });
}
function refreshGeneratorDraftStyle() {
  if (!generatorDraft) return;
  generatorDraft.style = { ...drawingController.styleSnapshot(), seed: generatorDraft.style.seed };
  previewGeneratorDraft();
}
function resetGeneratorDraft() {
  drawingSource.endReplaceAction();
  generatorDraft = null;
  generatorEditorId = null;
  drawingSource.previewDrawable(null);
  syncGeneratorControls();
  renderer.updateState({}, { preview: true });
}
$("drawingGenerator").addEventListener("change", event => {
  drawingSource.endReplaceAction();
  drawingController.cancel();
  if (event.target.value === "spirograph") {
    generatorEditorId = null;
    generatorDraft = makeSpirographDraft();
    previewGeneratorDraft();
  } else if (event.target.value === "guillocheRosette") {
    generatorEditorId = null;
    generatorDraft = makeGuillocheRosetteDraft();
    previewGeneratorDraft();
  } else resetGeneratorDraft();
  drawDrawingGuides();
});
$("editLatestGenerator").addEventListener("click", () => {
  drawingSource.endReplaceAction();
  const latest = latestGenerated();
  if (!latest) return;
  drawingController.cancel();
  generatorDraft = null;
  generatorEditorId = latest.id;
  drawingSource.previewDrawable(null);
  syncGeneratorControls();
});
const generatorInputFields = {
  spirographLobes: ["config", "lobes"], spirographPenOffset: ["config", "penOffset"], spirographReach: ["config", "reach"],
  spirographArms: ["config", "arms"], spirographMotion: ["animation", "amount"], spirographSpeed: ["animation", "speed"]
};
function replaceEditedGenerator(drawable, { immediate = false } = {}) {
  if (!generatorEditorId) return false;
  if (!drawingSource.beginReplaceAction(generatorEditorId)) return false;
  const changed = drawingSource.replaceDrawable(generatorEditorId, drawable);
  if (immediate) drawingSource.endReplaceAction();
  if (changed) { syncGeneratorControls(); refreshDrawingHistoryControls(); scheduleWorkspaceSave(); }
  return changed;
}
function finishGeneratorReplaceAction() { drawingSource.endReplaceAction(); refreshDrawingHistoryControls(); }
for (const [id, [group, key]] of Object.entries(generatorInputFields)) $(id).addEventListener("input", event => {
  const drawable = structuredClone(activeGenerator());
  if (!drawable) return;
  drawable[group][key] = Number(event.target.value);
  if (generatorDraft) { generatorDraft = drawable; previewGeneratorDraft(); }
  else replaceEditedGenerator(drawable);
});
$("spirographRotation").addEventListener("input", event => {
  const drawable = structuredClone(activeGenerator());
  if (!drawable) return;
  drawable.config.rotation = Number(event.target.value) * Math.PI / 180;
  if (generatorDraft) { generatorDraft = drawable; previewGeneratorDraft(); }
  else replaceEditedGenerator(drawable);
});
$("toggleGeneratorMotion").addEventListener("click", () => {
  renderer.updateState({ playing: !renderer.getState().playing }, { preview: false });
});
$("commitGenerator").addEventListener("click", () => {
  if (!generatorDraft) { resetGeneratorDraft(); return; }
  const committedId = drawingSource.commitDrawable(generatorDraft);
  if (committedId) {
    generatorDraft = null;
    generatorEditorId = committedId;
    syncGeneratorControls();
    refreshDrawingHistoryControls();
    scheduleWorkspaceSave();
  }
});
$("resetGenerator").addEventListener("click", resetGeneratorDraft);

function updateGuillocheRosette(drawable) {
  if (generatorDraft) { generatorDraft = drawable; previewGeneratorDraft(); }
  else replaceEditedGenerator(drawable);
}
function syncGuillocheRosetteControls(drawable, editing) {
  $("guillocheRosetteEditorStatus").textContent = generatorDraft ? "Draft preview — Commit to add it to the drawing." : editing ? "Editing committed Guilloché Rosette — changes are saved immediately." : "";
  $("commitGuillocheRosette").textContent = editing ? "Done" : "Commit";
  $("resetGuillocheRosette").textContent = editing ? "Stop Editing" : "Reset";
  $("toggleGuillocheRosetteMotion").textContent = renderer.getState().playing ? "Stop motion" : "Start motion";
  const config = { ...GENERATORS.guillocheRosette.defaults, ...drawable.config };
  const formats = { petals: value => String(Math.round(value)), secondaryFrequency: value => String(Math.round(value)), primaryAmplitude: value => Number(value).toFixed(3), roundness: value => Number(value).toFixed(2), secondaryAmplitude: value => Number(value).toFixed(3), baseRadius: value => Number(value).toFixed(2), rotation: value => `${Math.round(value)}°`, lineCount: value => String(Math.round(value)), lineSpacing: value => Number(value).toFixed(3), phaseOffset: value => `${Math.round(value)}°`, angularModulation: value => Number(value).toFixed(2), angularFrequency: value => String(Math.round(value)) };
  for (const [key, format] of Object.entries(formats)) {
    const value = key === "rotation" || key === "phaseOffset" ? config[key] * 180 / Math.PI : config[key];
    $("guillocheRosette" + key[0].toUpperCase() + key.slice(1)).value = String(value);
    $("guillocheRosette" + key[0].toUpperCase() + key.slice(1) + "Out").value = format(value);
  }
  for (const key of ["PhaseOffset", "SecondaryAmplitude", "SecondaryFrequency", "Rotation"]) $("guillocheRosetteMotion" + key).checked = drawable.animation.targets[key[0].toLowerCase() + key.slice(1)];
  $("guillocheRosetteMotion").value = String(drawable.animation.amount);
  $("guillocheRosetteMotionOut").value = Number(drawable.animation.amount).toFixed(2);
  $("guillocheRosetteSpeed").value = String(drawable.animation.speed);
  $("guillocheRosetteSpeedOut").value = `${Number(drawable.animation.speed).toFixed(2)} Hz`;
}
const guillocheConfigFields = ["petals", "secondaryFrequency", "primaryAmplitude", "roundness", "secondaryAmplitude", "baseRadius", "lineCount", "lineSpacing", "angularModulation", "angularFrequency"];
for (const key of guillocheConfigFields) $("guillocheRosette" + key[0].toUpperCase() + key.slice(1)).addEventListener("input", event => {
  const drawable = structuredClone(activeGenerator()); if (!drawable || drawable.generator !== "guillocheRosette") return;
  drawable.config[key] = Number(event.target.value); updateGuillocheRosette(drawable);
});
for (const key of ["rotation", "phaseOffset"]) $("guillocheRosette" + key[0].toUpperCase() + key.slice(1)).addEventListener("input", event => {
  const drawable = structuredClone(activeGenerator()); if (!drawable || drawable.generator !== "guillocheRosette") return;
  drawable.config[key] = Number(event.target.value) * Math.PI / 180; updateGuillocheRosette(drawable);
});
for (const [id, key] of [["guillocheRosetteMotion", "amount"], ["guillocheRosetteSpeed", "speed"]]) $(id).addEventListener("input", event => {
  const drawable = structuredClone(activeGenerator()); if (!drawable || drawable.generator !== "guillocheRosette") return;
  drawable.animation[key] = Number(event.target.value); updateGuillocheRosette(drawable);
});
for (const key of ["phaseOffset", "secondaryAmplitude", "secondaryFrequency", "rotation"]) $("guillocheRosetteMotion" + key[0].toUpperCase() + key.slice(1)).addEventListener("change", event => {
  const drawable = structuredClone(activeGenerator()); if (!drawable || drawable.generator !== "guillocheRosette") return;
  drawable.animation.targets[key] = event.target.checked;
  if (generatorDraft) updateGuillocheRosette(drawable); else replaceEditedGenerator(drawable, { immediate: true });
});
document.querySelectorAll("#spirographControls input[type='range'], #guillocheRosetteControls input[type='range']").forEach(input => {
  for (const eventName of ["change", "blur", "pointercancel"]) input.addEventListener(eventName, finishGeneratorReplaceAction);
});
$("toggleGuillocheRosetteMotion").addEventListener("click", () => renderer.updateState({ playing: !renderer.getState().playing }, { preview: false }));
$("commitGuillocheRosette").addEventListener("click", () => { if (!generatorDraft) { resetGeneratorDraft(); return; } const committedId = drawingSource.commitDrawable(generatorDraft); if (committedId) { generatorDraft = null; generatorEditorId = committedId; syncGeneratorControls(); refreshDrawingHistoryControls(); scheduleWorkspaceSave(); } });
$("resetGuillocheRosette").addEventListener("click", resetGeneratorDraft);
function syncDrawingBrushControls(name = drawingController.settings.brush) {
  $("drawingRibbonControls").hidden = name !== "ribbon";
  $("drawingCalligraphyControls").hidden = name !== "calligraphy";
  $("drawingSprayControls").hidden = name !== "spray";
  $("drawingTextureControls").hidden = name !== "texture";
  $("drawingFiberControls").hidden = name !== "fiber" && name !== "hair";
  syncDrawingColorControls(drawingController.settings.colorMode);
  if (name === "texture") {
    loadCurrentTexture();
  }
}
function syncDrawingColorControls(mode = drawingController.settings.colorMode) {
  $("drawingSolidColorControl").hidden = mode !== "solid";
  $("drawingGradientColorControls").hidden = mode !== "gradient";
}
function syncDrawingControls() {
  $("drawingTool").value = drawingController.settings.tool;
  $("drawingBrush").value = drawingController.settings.brush;
  $("drawingBackgroundColor").value = drawingSource.backgroundColor;
  $("drawingColorMode").value = drawingController.settings.colorMode;
  $("drawingColor").value = drawingController.settings.color;
  $("drawingGradientStartColor").value = drawingController.settings.gradientStartColor;
  $("drawingGradientEndColor").value = drawingController.settings.gradientEndColor;
  $("drawingSize").value = String(drawingController.settings.size);
  $("drawingOpacity").value = String(drawingController.settings.opacity);
  $("drawingSmoothing").value = String(Math.round(drawingController.settings.smoothing * 100));
  $("drawingSmoothingOut").value = `${Math.round(drawingController.settings.smoothing * 100)}%`;
  $("drawingLines").value = String(drawingController.settings.lines);
  $("drawingSpan").value = String(drawingController.settings.span);
  $("drawingNibRatio").value = String(drawingController.settings.nibRatio);
  $("drawingDensity").value = String(drawingController.settings.density);
  $("drawingParticleSize").value = String(drawingController.settings.particleSize);
  $("drawingTextureSpacing").value = String(drawingController.settings.textureSpacing);
  $("drawingTextureSpacingOut").value = `${Number(drawingController.settings.textureSpacing).toFixed(2)}×`;
  $("drawingFibers").value = String(drawingController.settings.fibers);
  $("drawingFiberGravity").value = String(drawingController.settings.gravity);
  $("drawingFiberBranching").value = String(drawingController.settings.branching);
  $("drawingFiberCurl").value = String(drawingController.settings.curl);
  const rotation = document.querySelector(`input[name="drawingTextureRotation"][value="${drawingController.settings.textureRotationMode}"]`);
  if (rotation) rotation.checked = true;
  syncDrawingBrushControls();
  syncDrawingColorControls();
  syncCurrentTexture();
}
function refreshDrawingHistoryControls() {
  $("undoDrawing").disabled = !drawingSource.canUndo();
}
$("drawingBrush").addEventListener("change", event => {
  drawingController.setBrush(event.target.value);
  // Pen begins at 8px, which reduces even a detailed PNG tip to a line. Give
  // Texture a useful first-use size without overriding an intentional size.
  if (event.target.value === "texture" && drawingController.settings.size === 8) {
    drawingController.set("size", 64);
    $("drawingSize").value = "64";
  }
  syncDrawingBrushControls();
  updateCanvasCursor();
  refreshGeneratorDraftStyle();
  drawDrawingGuides();
});
$("drawingTool").addEventListener("change", event => { drawingController.setTool(event.target.value); updateCanvasCursor(); drawDrawingGuides(); });
$("drawingSmoothing").addEventListener("input", event => {
  const percent = Number(event.target.value);
  drawingController.set("smoothing", percent / 100);
  $("drawingSmoothingOut").value = `${Math.round(percent)}%`;
});
$("drawingColor").addEventListener("input", event => { drawingController.set("color", event.target.value); refreshGeneratorDraftStyle(); });
function applyDrawingBackgroundColor(value) {
  if (drawingSource.setBackgroundColor(value)) { refreshDrawingHistoryControls(); scheduleWorkspaceSave(); }
}
$("drawingBackgroundColor").addEventListener("input", event => applyDrawingBackgroundColor(event.target.value));
$("drawingBackgroundColor").addEventListener("change", event => applyDrawingBackgroundColor(event.target.value));
$("drawingColorMode").addEventListener("change", event => {
  drawingController.set("colorMode", event.target.value);
  syncDrawingColorControls();
  refreshGeneratorDraftStyle();
});
$("drawingGradientStartColor").addEventListener("input", event => { drawingController.set("gradientStartColor", event.target.value); refreshGeneratorDraftStyle(); });
$("drawingGradientEndColor").addEventListener("input", event => { drawingController.set("gradientEndColor", event.target.value); refreshGeneratorDraftStyle(); });
$("drawingSize").addEventListener("input", event => { drawingController.set("size", event.target.value); refreshGeneratorDraftStyle(); });
$("drawingOpacity").addEventListener("input", event => { drawingController.set("opacity", event.target.value); refreshGeneratorDraftStyle(); });
$("drawingLines").addEventListener("input", event => { drawingController.set("lines", event.target.value); refreshGeneratorDraftStyle(); });
$("drawingSpan").addEventListener("input", event => { drawingController.set("span", event.target.value); refreshGeneratorDraftStyle(); });
$("drawingNibRatio").addEventListener("input", event => { drawingController.set("nibRatio", event.target.value); refreshGeneratorDraftStyle(); });
$("drawingDensity").addEventListener("input", event => { drawingController.set("density", event.target.value); refreshGeneratorDraftStyle(); });
$("drawingParticleSize").addEventListener("input", event => { drawingController.set("particleSize", event.target.value); refreshGeneratorDraftStyle(); });
$("drawingFibers").addEventListener("input", event => { drawingController.set("fibers", event.target.value); refreshGeneratorDraftStyle(); });
$("drawingFiberGravity").addEventListener("input", event => { drawingController.set("gravity", event.target.value); refreshGeneratorDraftStyle(); });
$("drawingFiberBranching").addEventListener("input", event => { drawingController.set("branching", event.target.value); refreshGeneratorDraftStyle(); });
$("drawingFiberCurl").addEventListener("input", event => { drawingController.set("curl", event.target.value); refreshGeneratorDraftStyle(); });
$("drawingTextureSpacing").addEventListener("input", event => {
  drawingController.set("textureSpacing", event.target.value);
  $("drawingTextureSpacingOut").value = `${Number(event.target.value).toFixed(2)}×`;
  refreshGeneratorDraftStyle();
});
document.querySelectorAll('input[name="drawingTextureRotation"]').forEach(input => input.addEventListener("change", event => {
  if (event.target.checked) { drawingController.set("textureRotationMode", event.target.value); refreshGeneratorDraftStyle(); }
}));
$("undoDrawing").addEventListener("click", () => { drawingSource.undo(); refreshDrawingHistoryControls(); scheduleWorkspaceSave(); });
$("clearDrawing").addEventListener("click", () => {
  drawingSource.clear();
  seek(0, { pause: true });
  refreshDrawingHistoryControls();
  scheduleWorkspaceSave();
});

const brushDialog = $("brushBrowser");
function drawTexturePreview(canvas, texture) {
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (texture) context.drawImage(texture.thumbnailCanvas, 0, 0, canvas.width, canvas.height);
}
function syncCurrentTexture() {
  const entry = brushTextureCatalog.getEntry(drawingController.settings.textureId) || brushTextureCatalog.getEntry(DEFAULT_BRUSH_TEXTURE_ID);
  $("drawingCurrentTextureName").textContent = entry?.label || "No brush selected";
  drawTexturePreview($("drawingCurrentTexturePreview"), brushTextureCatalog.get(drawingController.settings.textureId));
  document.querySelectorAll("[data-brush-texture-id]").forEach(tile => {
    const selected = tile.dataset.brushTextureId === drawingController.settings.textureId;
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
async function loadCurrentTexture(id = drawingController.settings.textureId) {
  if (!brushTextureCatalog.getEntry(id)) return;
  $("drawingTextureStatus").textContent = "Loading brush tip…";
  syncCurrentTexture();
  let selectedId = id;
  let texture = await brushTextureCatalog.ensure(selectedId);
  if (!texture && id === DEFAULT_BRUSH_TEXTURE_ID) {
    const fallback = BRUSH_TEXTURES.find(entry => brushTextureCatalog.getEntry(entry.id));
    if (fallback) { selectedId = fallback.id; texture = await brushTextureCatalog.ensure(selectedId); }
  }
  if (!texture) {
    updateTextureTile(id);
    return;
  }
  drawingController.set("textureId", selectedId);
  refreshGeneratorDraftStyle();
  $("drawingTextureStatus").textContent = texture ? "" : "Brush tip unavailable.";
  syncCurrentTexture();
  updateTextureTile(id);
  if (selectedId !== id) updateTextureTile(selectedId);
}
function renderBrushBrowser() {
  const grid = $("brushBrowserGrid");
  if (grid.childElementCount) return;
  for (const entry of BRUSH_TEXTURES) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "brushTile";
    tile.dataset.brushTextureId = entry.id;
    tile.setAttribute("aria-pressed", String(entry.id === drawingController.settings.textureId));
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
    if (entry.id === drawingController.settings.textureId) syncCurrentTexture();
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
window.addEventListener("resize", () => { drawMirrorWedgeGuides(); renderer.requestRender(); });
persistenceEnabled=false; const hadSavedSettings=restoreWorkspaceSettings(); populateWallpaperModes(); syncAllControls(); syncTimelineControls(); syncDrawingControls(); syncReferenceControls(); syncGeneratorControls(); refreshDrawingHistoryControls(); persistenceEnabled=true;
setPersistenceStatus(hadSavedSettings?"Settings restored. Restoring source image...":"Local workspace save enabled."); renderer.start();
if (globalThis.__KALEIDOSCOPE_TEST_HOOKS__ === true) globalThis.__KALEIDOSCOPE_TEST_HOOKS__ = { renderer, drawingSource, drawingController };
setTimeout(async()=>{try{const result=await bitmapSource.restore();if(result.restored){if(sourceMode==="bitmap")setSourceMode("bitmap");$("dropHint").style.display="none";setPersistenceStatus(result.migrated?"Previous workspace restored and image migrated to IndexedDB.":"Previous workspace restored.");}}catch(error){console.warn("Unable to restore source image",error);setPersistenceStatus("Settings restored; saved source image could not be decoded.");}},0);
saveWorkspaceSettingsNow();
