import { Renderer } from "./render.js";
import { BitmapSource } from "./bitmap-source.js";
import { GLOBAL_WALLPAPER_MODES } from "./global-wallpaper.js";

const $ = id => document.getElementById(id);
const canvas = $("gl");
const bitmapSource = new BitmapSource();
let activeSource = bitmapSource;
let sourceMode = "bitmap";
const WORKSPACE_STORAGE_KEY = "kaleidoscope.workspace.v10";
const PLANAR_SYMMETRY_MODES = new Set(["tile", "p2", "p4", "pg", "hexagonal", "wallpaper"]);
const TIMELINE_HALF_WINDOW = 30;
let persistenceTimer = null;
let persistenceEnabled = false;
let lastTimelineTickSecond = null;

const renderer = new Renderer(canvas, {
  onStateChange: syncRendererState,
  onFrame: syncTimelineControls
});

function setPersistenceStatus(message) { $("persistenceStatus").textContent = message; }

// Future source controls call this with DrawingSource. Gesture routing remains
// here because panning is a renderer transform, not a bitmap-source concern.
function setSourceMode(mode, source) {
  if (mode !== "bitmap" && mode !== "drawing") {
    throw new Error(`Unsupported source mode: ${mode}`);
  }
  if (!source) throw new Error(`A ${mode} source is required.`);
  sourceMode = mode;
  activeSource = source;
  renderer.setSource(activeSource);
}

function workspaceSnapshot() {
  return { state: renderer.getState(), recordFps: Number($("recordFps").value) || 60 };
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
    renderer.restoreState(saved.state);
    if (saved.recordFps === 30 || saved.recordFps === 60) $("recordFps").value = String(saved.recordFps);
    return true;
  } catch (error) {
    console.warn("Unable to restore workspace settings", error);
    return false;
  }
}

function populateWallpaperModes() {
  const current = renderer.getState().wallpaperMode;
  const modes = GLOBAL_WALLPAPER_MODES.filter(mode => ["p6m", "p4m", "p3m1", "p31m"].includes(mode));
  $("wallpaperMode").replaceChildren(...modes.map(mode => Object.assign(document.createElement("option"), { value: mode, textContent: mode })));
  $("wallpaperMode").value = current;
}

function syncRendererState(state) {
  syncAllControls(state);
  syncTimelineControls(state);
  scheduleWorkspaceSave();
}

function syncAllControls(state = renderer.getState()) {
  const ids = {
    segments:"segments", wallpaperSize:"wallpaperSize", gridRotationDeg:"gridRotation", gridX:"gridX", gridY:"gridY", twist:"twist", zoom:"zoom", rotationDeg:"rotation", panX:"panX", panY:"panY", centerX:"centerX", centerY:"centerY", speedDeg:"speed", driftX:"driftX", driftY:"driftY", driftSpeed:"driftSpeed", pulseAmount:"pulseAmount", pulseSpeed:"pulseSpeed", feedbackAmount:"feedbackAmount", feedbackZoom:"feedbackZoom", feedbackRotateDeg:"feedbackRotate", hue:"hue", bloomStrength:"bloomStrength", bloomThreshold:"bloomThreshold", bloomRadius:"bloomRadius"
  };
  for (const [key, id] of Object.entries(ids)) setControl(id, state[key]);
  $("mirror").checked = state.mirror;
  $("symmetryMode").value = state.symmetryMode;
  $("wallpaperMode").value = state.wallpaperMode;
  $("animate").checked = state.animate;
  $("driftMode").value = state.driftMode;
  $("segmentsLabel").textContent = PLANAR_SYMMETRY_MODES.has(state.symmetryMode) ? "Pattern density" : "Segments";
  document.querySelectorAll(".motionButton").forEach(button => button.classList.toggle("active", state.motion[button.dataset.motion]?.source !== "none"));
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

async function loadSource(source, { persist = false } = {}) {
  try { await bitmapSource.load(source); if(persist) await bitmapSource.save(source); setSourceMode("bitmap", bitmapSource); $("dropHint").style.display="none"; setPersistenceStatus(persist?"Workspace and source image saved in this browser.":"Previous workspace restored."); }
  catch(error){console.warn("Unable to load source image",error);setPersistenceStatus("The source image could not be decoded.");}
}
$("file").addEventListener("change", event=>{const file=event.target.files?.[0];if(file)loadSource(file,{persist:true});});
for(const name of ["dragenter","dragover"])canvas.addEventListener(name,event=>event.preventDefault());
canvas.addEventListener("drop",event=>{event.preventDefault();const file=event.dataTransfer?.files?.[0];if(file)loadSource(file,{persist:true});});
let dragging=false,lastX=0,lastY=0;
canvas.addEventListener("pointerdown",event=>{
  if (sourceMode === "drawing") {
    activeSource.pointerDown?.(event);
    return;
  }
  dragging=true;lastX=event.clientX;lastY=event.clientY;renderer.beginInteraction();canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove",event=>{
  if (sourceMode === "drawing") {
    activeSource.pointerMove?.(event);
    return;
  }
  if(!dragging)return;const rect=canvas.getBoundingClientRect();renderer.panBy((event.clientX-lastX)/rect.width,(event.clientY-lastY)/rect.height);lastX=event.clientX;lastY=event.clientY;
});
for(const name of ["pointerup","pointercancel"])canvas.addEventListener(name,event=>{
  if (sourceMode === "drawing") {
    activeSource.pointerUp?.(event);
    return;
  }
  if(dragging){dragging=false;renderer.endInteraction();}
});
canvas.addEventListener("wheel",event=>{event.preventDefault();renderer.zoomBy(Math.exp(-event.deltaY*.001));},{passive:false});

const presets={flower:{segments:12,mirror:true,symmetryMode:"mirrorRadial",twist:0,zoom:1.35,rotationDeg:8,speedDeg:4,driftX:.01,driftY:.01,driftMode:"orbit",driftSpeed:.05,pulseAmount:.03,pulseSpeed:.2,feedbackAmount:.15,feedbackZoom:1.002,feedbackRotateDeg:.1},crystal:{segments:16,mirror:true,symmetryMode:"mirrorRadial",twist:0,zoom:1.05,rotationDeg:0,speedDeg:0,driftX:.02,driftY:.02,driftMode:"smoothRandom",driftSpeed:.35,pulseAmount:.01,pulseSpeed:.15,feedbackAmount:.35,feedbackZoom:1.003,feedbackRotateDeg:.18},tunnel:{segments:8,mirror:true,symmetryMode:"tunnel",twist:4,zoom:1.1,rotationDeg:0,speedDeg:0,driftX:.01,driftY:.01,driftMode:"linear",driftSpeed:.1,pulseAmount:.08,pulseSpeed:.3,feedbackAmount:.6,feedbackZoom:1.006,feedbackRotateDeg:.35}};
document.querySelectorAll(".preset").forEach(button=>button.addEventListener("click",()=>renderer.updateState(presets[button.dataset.preset],{preview:false})));

let mediaRecorder=null, recordedChunks=[], recordingTimer=null;
function pickRecordingFormat(){for(const f of [{mime:"video/mp4;codecs=avc1.42E01E",ext:"mp4"},{mime:"video/mp4",ext:"mp4"},{mime:"video/webm;codecs=vp9",ext:"webm"},{mime:"video/webm",ext:"webm"}])if(typeof MediaRecorder!=="undefined"&&MediaRecorder.isTypeSupported(f.mime))return f;return null;}
$("startRecording").addEventListener("click",()=>{const format=pickRecordingFormat();if(!canvas.captureStream||!format){$("recordingStatus").textContent="Canvas recording is not supported by this browser.";return;}const stream=canvas.captureStream(Number($("recordFps").value)||60);recordedChunks=[];mediaRecorder=new MediaRecorder(stream,{mimeType:format.mime,videoBitsPerSecond:12000000});mediaRecorder.ondataavailable=e=>{if(e.data.size)recordedChunks.push(e.data);};mediaRecorder.onstop=()=>{const a=document.createElement("a"),url=URL.createObjectURL(new Blob(recordedChunks,{type:format.mime}));a.href=url;a.download=`kaleidoscope.${format.ext}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);stream.getTracks().forEach(track=>track.stop());$("startRecording").disabled=false;$("stopRecording").disabled=true;};mediaRecorder.start(1000);$("startRecording").disabled=true;$("stopRecording").disabled=false;});
$("stopRecording").addEventListener("click",()=>{if(mediaRecorder?.state!=="inactive"){ $("recordingStatus").textContent="Finalizing recording...";mediaRecorder.stop();}});
$("save").addEventListener("click",()=>{const a=document.createElement("a");a.download="kaleidoscope.png";a.href=canvas.toDataURL("image/png");a.click();});

document.addEventListener("input",scheduleWorkspaceSave,true); document.addEventListener("change",scheduleWorkspaceSave,true); window.addEventListener("pagehide",saveWorkspaceSettingsNow);
persistenceEnabled=false; const hadSavedSettings=restoreWorkspaceSettings(); populateWallpaperModes(); syncAllControls(); syncTimelineControls(); persistenceEnabled=true;
setPersistenceStatus(hadSavedSettings?"Settings restored. Restoring source image...":"Local workspace save enabled."); renderer.start();
setTimeout(async()=>{try{const result=await bitmapSource.restore();if(result.restored){setSourceMode("bitmap", bitmapSource);$("dropHint").style.display="none";setPersistenceStatus(result.migrated?"Previous workspace restored and image migrated to IndexedDB.":"Previous workspace restored.");}}catch(error){console.warn("Unable to restore source image",error);setPersistenceStatus("Settings restored; saved source image could not be decoded.");}},0);
saveWorkspaceSettingsNow();
