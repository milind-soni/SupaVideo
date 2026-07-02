#!/usr/bin/env node
/**
 * record-cua-demo — OpenScreen-quality, CUA-driven demo videos.
 *
 *   OpenScreen's ScreenCaptureKit helper captures the TARGET WINDOW ONLY
 *   (SCContentFilter desktopIndependentWindow: Retina pixels, cursor hidden,
 *   works even when the window is occluded — you can keep using the machine)
 *   + cua-driver clicks the window in the background (no focus steal)
 *   → OpenScreen's headless renderer draws the gliding cursor, zoom, wallpaper.
 *
 * Why this stays correct:
 *   - ONE coordinate space: clicks are window-local points; the capture frame
 *     IS the window. video_px = point × (videoWidth / windowWidth). No screen
 *     origins, no display scale guessing.
 *   - ONE clock: the helper emits `recording-started`; every click is stamped
 *     against that moment. The helper retimes frames to start at 0.
 *
 * Usage:
 *   node scripts/record-cua-demo.mjs --app Music [--actions demo.actions.json]
 *       [--out demo.mp4] [--openscreen-dir <dir>] [--fps 30] [--width 1920]
 *
 * actions JSON: [{ "wx": 108, "wy": 100, "label": "Home", "waitMs": 1500 }, ...]
 *   wx/wy are window-local points on the target app's main window.
 */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";

const exec = promisify(execFile);
const CUA = `${process.env.HOME}/.local/bin/cua-driver`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : def;
}

const APP = arg("app", "Music");
const OUT = path.resolve(arg("out", `${process.env.HOME}/${APP.toLowerCase()}-demo.mp4`));
const OPENSCREEN = arg("openscreen-dir", "/Users/milindsoni/Documents/mywork/openscreen");
const ACTIONS_FILE = arg("actions", null);
const FPS = Number(arg("fps", "30"));
const OUT_WIDTH = arg("width", "1920");

const HELPER = path.join(
  OPENSCREEN,
  "electron/native/screencapturekit/build/openscreen-screencapturekit-helper",
);

async function cua(tool, args) {
  const { stdout } = await exec(CUA, ["call", tool, JSON.stringify(args)], {
    maxBuffer: 16 * 1024 * 1024,
  });
  try {
    return JSON.parse(stdout);
  } catch {
    return { raw: stdout };
  }
}

/** pid + largest window of the app (its "main" window). */
async function resolveTarget(appName) {
  const { stdout: pidOut } = await exec("pgrep", ["-x", appName]);
  const pid = Number(pidOut.trim().split("\n")[0]);
  if (!pid) throw new Error(`${appName} is not running`);
  const wins = await cua("list_windows", { pid });
  const main = (wins.windows || [])
    .filter((w) => w.bounds.width > 400 && w.bounds.height > 300)
    .sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0];
  if (!main) throw new Error(`no main window for ${appName}`);
  return { pid, windowId: main.window_id, bounds: main.bounds };
}

/** Start the SCK helper capturing one window. Resolves once frames flow. */
function startWindowCapture(windowId, screenPath) {
  const request = {
    schemaVersion: 1,
    source: { type: "window", sourceId: `window:${windowId}`, windowId },
    // width/height are upper clamps — pass large values so the helper uses the
    // window's true Retina pixel size.
    video: { fps: FPS, width: 16384, height: 16384, hideSystemCursor: true },
    audio: { system: { enabled: false }, microphone: { enabled: false, gain: 1 } },
    webcam: { enabled: false, width: 0, height: 0, fps: 0 },
    cursor: { mode: "editable-overlay" },
    outputs: { screenPath },
  };
  const child = spawn(HELPER, [JSON.stringify(request)], { stdio: ["pipe", "pipe", "pipe"] });
  const rl = readline.createInterface({ input: child.stdout });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("capture start timed out")), 15000);
    rl.on("line", (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.event === "recording-started") {
        clearTimeout(timer);
        resolve({
          child,
          tStartWall: Date.now(),
          stop: () =>
            new Promise((res) => {
              rl.on("line", (l) => {
                try {
                  if (JSON.parse(l).event === "recording-stopped") res();
                } catch {}
              });
              child.stdin.write("stop\n");
              setTimeout(res, 8000); // fallback if event is missed
            }),
        });
      } else if (ev.event === "error") {
        clearTimeout(timer);
        reject(new Error(`helper: ${ev.message ?? JSON.stringify(ev)}`));
      }
    });
    child.on("error", reject);
    child.stderr.on("data", () => {});
  });
}

async function probeDims(video) {
  const { stdout } = await exec("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "json", video,
  ]);
  const s = JSON.parse(stdout).streams?.[0] ?? {};
  return { w: Number(s.width) || 0, h: Number(s.height) || 0 };
}

function defaultActions() {
  // Apple Music sidebar tour (window-local points, origin at window top-left
  // including title bar — same origin as the SCK window-capture frame).
  return [
    { wx: 108, wy: 100, label: "Home", waitMs: 1800 },
    { wx: 108, wy: 132, label: "New", waitMs: 1800 },
    { wx: 108, wy: 164, label: "Radio", waitMs: 1800 },
    { wx: 108, wy: 292, label: "Albums", waitMs: 1800 },
    { wx: 108, wy: 324, label: "Songs", waitMs: 1800 },
  ];
}

async function main() {
  if (!existsSync(HELPER)) {
    throw new Error(`SCK helper missing — run \`npm run build:native:mac\` in ${OPENSCREEN}`);
  }
  const target = await resolveTarget(APP);
  console.error(
    `● target ${APP} pid=${target.pid} window=${target.windowId} ` +
      `bounds=${target.bounds.width}x${target.bounds.height}pt`,
  );

  const actions = ACTIONS_FILE
    ? JSON.parse(await readFile(path.resolve(ACTIONS_FILE), "utf8"))
    : defaultActions();

  const work = await mkdtemp(path.join(tmpdir(), "cua-demo-"));
  const videoPath = path.join(work, "recording.mp4");
  const clicksPath = path.join(work, "clicks.json");

  // Bring the app forward so its controls accept the synthetic clicks. The
  // capture itself is window-isolated either way; this is for click delivery.
  await exec("osascript", ["-e", `tell application "${APP}" to activate`]).catch(() => {});
  await sleep(800);

  console.error("● window capture starting (window-isolated)…");
  const capture = await startWindowCapture(target.windowId, videoPath);
  await sleep(600); // small pre-roll before the first action

  // Drive. Clicks logged in window POINTS; converted to video px after probe.
  const clicksPt = [];
  for (const a of actions) {
    const tMs = Date.now() - capture.tStartWall;
    clicksPt.push({ tMs, wx: a.wx, wy: a.wy, label: a.label });
    console.error(`  click ${a.label ?? ""} @(${a.wx},${a.wy})pt t=${tMs}ms`);
    await cua("click", { pid: target.pid, window_id: target.windowId, x: a.wx, y: a.wy }).catch(
      (e) => console.error(`    click failed: ${e.message}`),
    );
    await sleep(a.waitMs ?? 1500);
  }
  await sleep(700);

  console.error("■ stopping capture…");
  await capture.stop();
  capture.child.kill();

  // Window points → video pixels using the video's own dimensions.
  const dims = await probeDims(videoPath);
  const k = dims.w / target.bounds.width;
  const clicks = clicksPt.map((c) => ({
    tMs: c.tMs,
    x: Math.round(c.wx * k),
    y: Math.round(c.wy * k),
    label: c.label,
  }));
  await writeFile(clicksPath, JSON.stringify(clicks, null, 2));
  console.error(`  video ${dims.w}x${dims.h}px, scale ${k.toFixed(2)}px/pt`);

  console.error("▶ rendering with OpenScreen (headless)…");
  await exec(
    "node",
    [
      path.join(OPENSCREEN, "scripts", "render-demo.mjs"),
      "--video", videoPath, "--clicks", clicksPath, "--out", OUT,
      "--fps", String(FPS), "--width", OUT_WIDTH,
    ],
    { maxBuffer: 256 * 1024 * 1024 },
  );

  console.log(`✓ ${OUT}`);
  await exec("open", [OUT]).catch(() => {});
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
