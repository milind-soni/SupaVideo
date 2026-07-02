# SupaVideo

**Give an agent a task, get a polished demo video of it doing the task.**

SupaVideo is an MCP server (plus a CLI) that brackets an agent's desktop work
with recording and turns the captured trajectory into a Screen-Studio-style demo
video — background wallpaper, a smooth animated cursor that glides to each
button, click bounce, and eased zoom-on-click.

It's glue between two existing systems that already did the hard parts:

| Half | Project | Role |
| --- | --- | --- |
| Capture + drive | [`cua-driver`](../cua/libs/cua-driver) | Background computer-use over MCP (clicks/types **without stealing focus**), and records a cursorless `recording.mp4` + `cursor.jsonl` + per-turn `action.json`. |
| Polish + render | [`openscreen`](../openscreen) | Re-draws a smooth animated cursor from telemetry and composites wallpaper + eased zoom, exports MP4/GIF. |

The key reason this works: **both tools store the cursor as *data* separate from
a cursorless video, and composite it at render time.** SupaVideo maps one to the
other. It is not re-inventing capture or rendering.

## Working pipeline (window capture + drive + render)

The validated path drives a real app window and renders a polished demo. It
avoids the earlier telemetry-recovery mess with two rules: **one coordinate
space** (clicks are window-local points; the capture frame *is* the window, so
`video_px = pt × videoWidth/windowWidth`) and **one clock** (OpenScreen's SCK
helper emits `recording-started`; every click is stamped against it).

```bash
# Full loop: capture the app window only (Retina, cursor hidden, occlusion-proof),
# drive it with cua-driver, render the polished demo.
node scripts/record-cua-demo.mjs --app Music --out demo.mp4 \
    --openscreen-dir /path/to/openscreen
```

Two reusable pieces:

- **`openscreen/scripts/render-demo.mjs`** — an OpenScreen enhancement: turn any
  screen video + a flat clicks list into a polished demo (cursor auto-glides
  between clicks, clustered zoom-on-click, wallpaper). Fully testable with a
  synthetic video — no agent, no telemetry:
  ```bash
  node scripts/render-demo.mjs --video screen.mp4 --clicks clicks.json --out demo.mp4 --width 1920
  ```
  ```json
  [ { "tMs": 1000, "x": 340, "y": 210 }, { "tMs": 2500, "x": 620, "y": 480 } ]
  ```
- **`scripts/record-cua-demo.mjs`** — the capture + drive + render orchestrator.

Prereqs in the OpenScreen checkout (once): `npm install`,
`npm run build:headless`, `npm run build:native:mac`.

---

Below is the alternative MCP/adapter path (renders an existing cua-driver
recording directory via `src/`).

## The loop

```
Claude Code / OpenClaw / Hermes
        │  MCP: supavideo_start_demo
        ▼
   cua-driver recording start --video-experimental
        │  agent drives the app via cua-driver's own MCP tools (background)
        ▼
   cua-driver recording stop        (MCP: supavideo_finish_demo)
        │
        ▼
   recording dir:  recording.mp4 + cursor.jsonl + turn-*/action.json + session.json
        │
        ▼  adapter (src/adapter/toOpenScreenProject.ts)
   <video>.cursor.json sidecar  +  OpenScreen project (zoom-on-click regions)
        │
        ▼  render (src/render/render.ts)
   backend "openscreen"  → headless offscreen-Electron VideoExporter  (polished; wired)
   backend "ffmpeg"      → self-contained cursor+click overlay render  (zero extra deps)
   backend "cua-native"  → cua-driver's own AVFoundation render        (needs cua-driver)
        ▼
   demo.mp4  → returned to the agent (as a path, never an embedded blob)
```

## MCP tools

- `supavideo_start_demo { recordingDir? }` → `{ sessionId, recordingDir }`
  Begin recording. The agent then drives the desktop with cua-driver.
- `supavideo_finish_demo { sessionId, out, backend?, openscreenDir? }` → `{ outputPath }`
  Stop, adapt, render.
- `supavideo_render_recording { dir, out, backend?, openscreenDir? }` → `{ outputPath }`
  Adapt + render an already-captured recording directory.

### Register the MCP server

Claude Code:
```bash
claude mcp add --transport stdio supavideo -- node /Users/milindsoni/Documents/mywork/SupaVideo/src/mcp/server.ts
```
OpenClaw / Codex / Hermes: point their MCP config at the same stdio command.

The agent also needs cua-driver registered so it can actually drive the desktop:
```bash
claude mcp add --transport stdio cua-driver -- cua-driver mcp
```

## CLI

```bash
# Render an already-captured cua recording directory (works today):
node src/cli.ts render <recording-dir> --out demo.mp4 --backend cua-native

# Record interactively: starts recording, you drive via your agent, Enter to finish:
node src/cli.ts record --out demo.mp4
```

## Status

- ✅ CUA trajectory reader (`src/cua/trajectory.ts`) — session.json / cursor.jsonl / turn-NNNNN/action.json
- ✅ Adapter (`src/adapter/toOpenScreenProject.ts`) — cursor sidecar + zoom-on-click regions, **8/8 unit tests**
- ✅ cua-driver wrapper (`src/cua/driver.ts`) — daemon + recording start/stop, native render
- ✅ Orchestrator + CLI + MCP server (start_demo / finish_demo / render_recording)
- ✅ Render backend `ffmpeg` — self-contained; **verified end-to-end producing a real MP4**
  (cursor glides to each button + click pulse, zoom regions computed). No cua-driver / Electron needed.
- ✅ Render backend `openscreen` — **wired**: `src/render/render.ts` writes the export config and runs
  the harness (`openscreen/headless/electron-main.mjs`) in a hidden Electron BrowserWindow.
  Prereq in the OpenScreen checkout: `npm install && npm run build:headless`.
- ✅ Render backend `cua-native` — delegates to `cua-driver recording render` (needs cua-driver installed).

### Verify locally (no cua-driver, no Electron)

```bash
node scripts/synth-recording.mjs /tmp/rec          # fake a cua recording (needs ffmpeg)
node src/cli.ts render /tmp/rec --out /tmp/demo.mp4 --backend ffmpeg
node --test 'src/**/*.test.ts'                     # adapter unit tests
```

## Requirements

- Node ≥ 22.6 (runs the TypeScript sources directly via native type-stripping)
- [`cua-driver`](https://github.com/trycua/cua) installed and on PATH
- macOS for capture (SCStream). Windows/Linux capture tracks cua-driver's support.
- For the polished path: a local OpenScreen checkout (`--openscreen-dir`)

## Dev

```bash
npm install          # @modelcontextprotocol/sdk + zod (only the MCP server needs these)
npm test             # runs the adapter unit tests
```
