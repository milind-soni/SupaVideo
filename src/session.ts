/**
 * Live demo session — the validated capture+drive+render loop as a library.
 *
 * Ported from scripts/record-cua-demo.mjs (the known-good reference). The same
 * two rules keep it correct:
 *   - ONE coordinate space: clicks are window-local POINTS; the capture frame
 *     is the window, so video_px = pt × (videoWidth / windowWidth).
 *   - ONE clock: OpenScreen's SCK helper emits `recording-started`; every click
 *     is stamped against that wall-clock moment.
 *
 * Flow: DemoSession.start(app) → session.click(x, y) …repeat… → session.finish(out).
 * The clicks the agent issues ARE the cursor path in the final render — nothing
 * is recovered from telemetry.
 */

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_OPENSCREEN = "/Users/milindsoni/Documents/mywork/openscreen";
const CUA = `${process.env.HOME}/.local/bin/cua-driver`;

export interface SessionOptions {
  /** OpenScreen checkout with headless + SCK helper builds. */
  openscreenDir?: string;
  /** Capture framerate. */
  fps?: number;
  /** cua-driver binary override. */
  cuaBin?: string;
}

export interface ClickRecord {
  tMs: number;
  /** Window-local points. */
  wx: number;
  wy: number;
  label?: string;
  /** "click" (default) draws a click + zoom; "move" is a cursor waypoint only. */
  kind?: "click" | "move";
}

export interface FinishOptions {
  /** Output MP4 path. */
  out: string;
  /** Output width in px (proportional height). Default 1920. */
  width?: number;
  /** Disable zoom-on-click regions. */
  noZoom?: boolean;
  /** Wallpaper CSS value or OpenScreen wallpaper id. */
  wallpaper?: string;
}

interface Target {
  pid: number;
  windowId: number;
  bounds: { x: number; y: number; width: number; height: number };
}

async function cua(bin: string, tool: string, args: unknown): Promise<Record<string, unknown>> {
  const { stdout } = await exec(bin, ["call", tool, JSON.stringify(args)], {
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    return JSON.parse(stdout);
  } catch {
    return { raw: stdout };
  }
}

async function resolveTarget(bin: string, appName: string): Promise<Target & { onScreen: boolean }> {
  const { stdout: pidOut } = await exec("pgrep", ["-x", appName]);
  const pid = Number(pidOut.trim().split("\n")[0]);
  if (!pid) throw new Error(`${appName} is not running`);
  const wins = (await cua(bin, "list_windows", { pid })) as {
    windows?: Array<{ window_id: number; bounds: Target["bounds"]; is_on_screen?: boolean }>;
  };
  const main = (wins.windows ?? [])
    .filter((w) => w.bounds.width > 400 && w.bounds.height > 300)
    .sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0];
  if (!main) throw new Error(`no main window for ${appName}`);
  return { pid, windowId: main.window_id, bounds: main.bounds, onScreen: main.is_on_screen !== false };
}

/**
 * Activate the app and wait until its main window is actually on screen.
 * A window on another Space (e.g. the app is fullscreen elsewhere) is invisible
 * to ScreenCaptureKit's shareable content; activation switches Spaces, which
 * takes a beat — poll until `is_on_screen` flips.
 */
async function ensureOnScreen(bin: string, appName: string): Promise<Target> {
  // `reopen` recreates/re-shows the main window when it was closed (the app
  // keeps running with a zombie CGWindow that SCK can't capture); `activate`
  // brings it frontmost / switches to its Space.
  await exec("osascript", [
    "-e", `tell application "${appName}" to reopen`,
    "-e", `tell application "${appName}" to activate`,
  ]).catch(() => {});
  let target = await resolveTarget(bin, appName);
  for (let i = 0; i < 20 && !target.onScreen; i++) {
    await sleep(400);
    target = await resolveTarget(bin, appName);
  }
  if (!target.onScreen) {
    throw new Error(
      `${appName}'s window never came on screen — is it minimized or on a locked Space?`,
    );
  }
  await sleep(600); // let the Space switch animation settle before capture
  return target;
}

async function probeDims(video: string): Promise<{ w: number; h: number }> {
  const { stdout } = await exec("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "json", video,
  ]);
  const s = JSON.parse(stdout).streams?.[0] ?? {};
  return { w: Number(s.width) || 0, h: Number(s.height) || 0 };
}

export class DemoSession {
  readonly app: string;
  readonly target: Target;
  readonly workDir: string;
  readonly videoPath: string;
  readonly clicks: ClickRecord[] = [];

  private readonly openscreenDir: string;
  private readonly fps: number;
  private readonly cuaBin: string;
  private helper: ChildProcess;
  private helperRl: readline.Interface;
  private tStartWall: number;
  private finished = false;

  private constructor(init: {
    app: string;
    target: Target;
    workDir: string;
    videoPath: string;
    openscreenDir: string;
    fps: number;
    cuaBin: string;
    helper: ChildProcess;
    helperRl: readline.Interface;
    tStartWall: number;
  }) {
    this.app = init.app;
    this.target = init.target;
    this.workDir = init.workDir;
    this.videoPath = init.videoPath;
    this.openscreenDir = init.openscreenDir;
    this.fps = init.fps;
    this.cuaBin = init.cuaBin;
    this.helper = init.helper;
    this.helperRl = init.helperRl;
    this.tStartWall = init.tStartWall;
  }

  /** Elapsed session time in ms (the clock every click is stamped with). */
  get elapsedMs(): number {
    return Date.now() - this.tStartWall;
  }

  /**
   * Resolve the app's main window, bring the app forward (background clicks
   * don't register when the app is fully occluded/inactive), start the
   * window-isolated SCK capture, and anchor the clock at `recording-started`.
   */
  static async start(app: string, opts: SessionOptions = {}): Promise<DemoSession> {
    const openscreenDir = opts.openscreenDir ?? DEFAULT_OPENSCREEN;
    const fps = opts.fps ?? 30;
    const cuaBin = opts.cuaBin ?? CUA;

    const helperBin = path.join(
      openscreenDir,
      "electron/native/screencapturekit/build/openscreen-screencapturekit-helper",
    );
    if (!existsSync(helperBin)) {
      throw new Error(`SCK helper missing — run \`npm run build:native:mac\` in ${openscreenDir}`);
    }

    // Activate + wait until the window is really on screen (SCK can't capture
    // windows on another Space, and occluded/inactive apps drop our clicks).
    const target = await ensureOnScreen(cuaBin, app);

    const workDir = await mkdtemp(path.join(tmpdir(), "supavideo-"));
    const videoPath = path.join(workDir, "recording.mp4");

    const request = {
      schemaVersion: 1,
      source: { type: "window", sourceId: `window:${target.windowId}`, windowId: target.windowId },
      video: { fps, width: 16384, height: 16384, hideSystemCursor: true },
      audio: { system: { enabled: false }, microphone: { enabled: false, gain: 1 } },
      webcam: { enabled: false, width: 0, height: 0, fps: 0 },
      cursor: { mode: "editable-overlay" },
      outputs: { screenPath: videoPath },
    };
    const helper = spawn(helperBin, [JSON.stringify(request)], { stdio: ["pipe", "pipe", "pipe"] });
    const helperRl = readline.createInterface({ input: helper.stdout! });
    helper.stderr?.on("data", () => {});

    const tStartWall = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        helper.kill();
        reject(new Error("capture start timed out (Screen Recording permission?)"));
      }, 15000);
      helperRl.on("line", (line) => {
        let ev: { event?: string; message?: string };
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev.event === "recording-started") {
          clearTimeout(timer);
          resolve(Date.now());
        } else if (ev.event === "error") {
          clearTimeout(timer);
          helper.kill();
          reject(new Error(`capture helper: ${ev.message ?? line}`));
        }
      });
      helper.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });

    // Pre-roll: give the demo a full-frame establishing shot. OpenScreen's
    // zoom-in ramp needs ~1.1s before the first zoom region starts.
    await sleep(1200);

    return new DemoSession({
      app, target, workDir, videoPath, openscreenDir, fps, cuaBin, helper, helperRl, tStartWall,
    });
  }

  /** Click the target window at window-local points; the click is logged as the cursor path. */
  async click(wx: number, wy: number, label?: string): Promise<ClickRecord> {
    if (this.finished) throw new Error("session already finished");
    const rec: ClickRecord = { tMs: this.elapsedMs, wx, wy, label, kind: "click" };
    this.clicks.push(rec);
    await cua(this.cuaBin, "click", {
      pid: this.target.pid,
      window_id: this.target.windowId,
      x: wx,
      y: wy,
    });
    return rec;
  }

  /**
   * Type text into the app (focused field). The cursor stays where it is; time
   * simply passes in the demo while the app shows the typing.
   */
  async type(text: string): Promise<void> {
    if (this.finished) throw new Error("session already finished");
    await cua(this.cuaBin, "type_text", { pid: this.target.pid, text });
  }

  /**
   * Scroll at a window-local point. Logged as a cursor MOVE waypoint (the demo
   * cursor glides there) without a click bounce or zoom region of its own.
   */
  async scroll(
    wx: number,
    wy: number,
    direction: "up" | "down" | "left" | "right",
    amount = 3,
  ): Promise<ClickRecord> {
    if (this.finished) throw new Error("session already finished");
    const rec: ClickRecord = { tMs: this.elapsedMs, wx, wy, label: `scroll-${direction}`, kind: "move" };
    this.clicks.push(rec);
    await cua(this.cuaBin, "scroll", {
      pid: this.target.pid,
      window_id: this.target.windowId,
      x: wx,
      y: wy,
      direction,
      amount,
    });
    return rec;
  }

  /**
   * Capture a downscaled screenshot of the target window (for click grounding).
   * Uses macOS `screencapture -l <CGWindowID>` — cua-driver-rs has no screenshot
   * tool. Downscaled to the window's point width so image px == window points.
   */
  async screenshot(maxWidth = 1512): Promise<string> {
    const file = path.join(this.workDir, `shot-${Date.now()}.png`);
    await exec("screencapture", ["-l", String(this.target.windowId), "-x", "-o", file]);
    if (!existsSync(file)) throw new Error("screenshot failed (Screen Recording permission?)");
    await exec("sips", ["--resampleWidth", String(maxWidth), file]).catch(() => {});
    return file;
  }

  /** Stop capture, convert clicks to video pixels, render the polished demo. */
  async finish(opts: FinishOptions): Promise<{ outputPath: string; videoPath: string }> {
    if (this.finished) throw new Error("session already finished");
    this.finished = true;

    await sleep(700); // trailing beat after the last action

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 8000); // fallback if the event is missed
      this.helperRl.on("line", (l) => {
        try {
          if (JSON.parse(l).event === "recording-stopped") {
            clearTimeout(timer);
            resolve();
          }
        } catch {}
      });
      this.helper.stdin?.write("stop\n");
    });
    this.helper.kill();

    const dims = await probeDims(this.videoPath);
    const k = dims.w / this.target.bounds.width;
    const clicksPx = this.clicks.map((c) => ({
      tMs: c.tMs,
      x: Math.round(c.wx * k),
      y: Math.round(c.wy * k),
      label: c.label,
      ...(c.kind === "move" ? { type: "move" } : {}),
    }));
    const clicksPath = path.join(this.workDir, "clicks.json");
    await writeFile(clicksPath, JSON.stringify(clicksPx, null, 2));

    const outputPath = path.resolve(opts.out);
    const args = [
      path.join(this.openscreenDir, "scripts", "render-demo.mjs"),
      "--video", this.videoPath,
      "--clicks", clicksPath,
      "--out", outputPath,
      "--fps", String(this.fps),
      // 2560 keeps the Retina capture crisp; 1920 was visibly soft.
      "--width", String(opts.width ?? 2560),
    ];
    if (opts.noZoom) args.push("--no-zoom");
    if (opts.wallpaper) args.push("--wallpaper", opts.wallpaper);
    await exec("node", args, { maxBuffer: 256 * 1024 * 1024 });

    if (!existsSync(outputPath)) throw new Error("render finished but produced no output");
    return { outputPath, videoPath: this.videoPath };
  }

  /** Abort without rendering (kills the capture helper). */
  abort(): void {
    this.finished = true;
    try {
      this.helper.stdin?.write("stop\n");
    } catch {}
    setTimeout(() => this.helper.kill(), 1500);
  }
}
