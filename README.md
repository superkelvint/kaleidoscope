# Kaleidoscope

Beautiful animated kaleidoscopes from your own images.

Drop in a photo, painting, texture, whatever. Kaleidoscope mirrors it into a continuously evolving pattern you can explore, scrub through, and record.

No backend. No upload. Just WebGL in the browser.

## Development and repository layout

- `apps/web/`: working JavaScript/Canvas2D/WebGL application and tests.
- `apps/flutter/`: reserved for a future Flutter Canvas prototype.
- `graphics-spec/`: shared document and rendering contracts.
- `fixtures/`: cross-platform inputs and reference renders.
- `tooling/parity/`: reserved comparison tooling.

With Node.js 22 or newer:

```sh
npm ci --prefix apps/web
npm test
npx --prefix apps/web playwright install chromium
npm run test:browser
npm run serve:web
```

Open `http://127.0.0.1:4173/`. For a deployable static artifact, run
`npm run build:web`; output goes to `apps/web/dist/`. The Pages workflow checks
the artifact under `/kaleidoscope/` before publishing it. Only runtime files
and assets are published; tests and dependencies are excluded.

Production: [Kaleidoscope](https://superkelvint.github.io/kaleidoscope/).
Deployment is handled by `.github/workflows/web.yml` after web checks pass on
`main`. Pull requests run the checks without deploying.

## Features

- Use any image as the source
- Real-time WebGL2 rendering
- 2–32 kaleidoscope segments
- Eleven symmetry geometries, including half-turn, quarter-turn and glide kaleidoscopes
- Independent grid layouts: p6m, p4m, p3m1 and p31m
- Twistable spiral mandalas, including animated twist modulation
- Drag to pan, scroll to zoom
- Rotation, drift and zoom animation
- Linear, oscillating, orbital and smooth-random drift
- Recursive feedback trails
- Flower, Crystal and Tunnel presets
- Scrubbable timeline — go backwards and find that beautiful thing you just saw
- PNG export
- 30 / 60 fps video recording
- MP4/H.264 where the browser supports it, WebM otherwise
- Automatically remembers your settings and last image

## The fun part

Kaleidoscope is deliberately more exploratory than precise.

Load an image, give it a little movement, and see where it goes.

A boring photograph can suddenly produce flowers, stained glass, crystals, tunnels, strange organic things, and occasionally something ridiculously beautiful.

When that happens, you can pause and scrub backwards through the timeline instead of losing it forever.

## Local motifs and grid layouts

The **Local Motif Symmetry** control shapes one kaleidoscope motif around its
own centre. **Grid** is a separate layer that places many
of those motifs across the canvas and sets their neighbour relationships.

For example, select Mirror radial locally and Hex Flower (p6m) globally to
make a triangular field of mirrored radial rosettes. Changing the local motif
does not change the global lattice; changing the wallpaper layout does not
replace the chosen local motif. Use **Grid spacing**, **Grid rotation** and
**Grid X/Y** to place the lattice without changing the local motif settings.

## Motion

There are four ways to move through the source image:

**Linear**  
Just keeps drifting in one direction.

**Oscillate**  
Back and forth.

**Orbit**  
Moves around an elliptical path.

**Smooth random**  
Slow wandering without abrupt jumps.

Combine these with rotation and pulse for much more interesting motion.

Small values are usually better than large ones.

## Feedback

This is where things get weird.

Each frame can be fed back into the next one, with a tiny zoom and/or rotation applied along the way.

Three controls:

- Feedback amount
- Feedback zoom
- Feedback rotation

Tiny changes here can completely change the character of the animation.

## Timeline

The animation is tied to a timeline, so you can move backwards and forwards through it.

That means when you see something great and then immediately lose it, you can actually go back and find it again.

Use:

- the timeline scrubber
- `◀ 1s` / `1s ▶`
- left/right arrow keys
- an exact timestamp

Press `Space` to play/pause.

## Recording

Hit **Start recording** and Kaleidoscope records the canvas directly in the browser.

Choose either:

- 30 fps
- 60 fps

It prefers MP4/H.264 if your browser can record it, otherwise it falls back to WebM.

You can also save the current frame as a PNG.

## Privacy

Images stay in your browser.

There is no server component and nothing gets uploaded anywhere.

Your settings and last source image are saved locally so reloading the page doesn't wipe out your workspace.

## Status

Very much a work in progress.

Things I'd like to play with next:

- more interesting motion curves
- more feedback modes
- color shifting
- multiple source images
- fullscreen / performance mode
- shareable presets
- deterministic seeds
- audio-reactive animation
- MIDI control
- better high-resolution rendering

PRs and experiments welcome.
