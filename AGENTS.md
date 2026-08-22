# Kaleidoscope architecture

The application is intentionally split into three layers:

- `render.js` exports `Renderer` and exclusively owns WebGL2: shaders, GPU
  resources, source texture uploads, resizing, feedback, bloom, animation,
  timeline state, and the render loop. It must not query the DOM or use
  browser persistence APIs.
- `bitmap-source.js` exports `BitmapSource` and owns image validation,
  decoding, frame revisions, resolution, IndexedDB persistence, and legacy
  migration. It must never receive a WebGL context or texture.
- `app.js` is orchestration only: DOM event wiring, UI synchronization,
  persistence status, and recording/download UI.

Sources use a WebGL-free contract. `getFrame()` returns the current
`{ pixels, width, height, revision }` snapshot, or `null`. Sources own their
pixels, dimensions, and monotonic revision; `Renderer` owns GPU upload state
and uploads again when either the source identity or revision changes.
Activating a source resets feedback; incremental updates (such as drawing
strokes) must retain feedback history and must not emit renderer state or
trigger app persistence. Future sources must use this contract instead of
adding source-type branches to the renderer.

Use `Renderer` public methods to modify rendering behavior: `setSource`,
`getState`, `restoreState`, `updateState`, `updateMotion`, `seekToTime`,
`panBy`, `zoomBy`, `beginInteraction`, and `endInteraction`. Persist a
serializable `getState()` snapshot; do not persist renderer internals.

Keep the app as native ES modules and preserve existing DOM IDs unless a
feature requires an HTML change. Add Node unit tests for source and renderer
behavior, then run the browser smoke checks for loading/restoration, canvas
gestures, feedback/timeline, bloom, PNG export, and recording.
