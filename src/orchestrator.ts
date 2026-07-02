/**
 * SupaVideo orchestrator — the "task → demo video" loop.
 *
 * The agent (Claude Code / OpenClaw / Hermes) drives the desktop through
 * cua-driver's own MCP tools. SupaVideo brackets that driving with recording and
 * turns the captured trajectory into a polished demo. Two shapes:
 *
 *   beginSession() → agent drives via cua-driver → endSession() → mp4
 *   renderExisting(dir) → mp4        (adapt+render an already-captured recording)
 *
 * This split is deliberate: SupaVideo does not itself decide the clicks — the
 * harness does, using cua-driver. SupaVideo owns record-bracketing + post.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CuaDriver } from "./cua/driver.ts";
import { loadTrajectory } from "./cua/trajectory.ts";
import { writeAdaptation, type AdapterOptions } from "./adapter/toOpenScreenProject.ts";
import { render, type RenderBackend } from "./render/render.ts";

export interface SessionOptions extends AdapterOptions {
  /** Where cua-driver writes the recording. Auto-created under tmp if omitted. */
  recordingDir?: string;
  driverBin?: string;
}

export interface RenderOptions extends AdapterOptions {
  outputPath: string;
  backend?: RenderBackend;
  openscreenDir?: string;
  driverBin?: string;
}

export interface DemoSession {
  recordingDir: string;
  driver: CuaDriver;
}

function defaultRecordingDir(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(os.tmpdir(), "supavideo", `rec-${stamp}`);
}

/** Ensure cua-driver + daemon, then start recording. Returns a session handle. */
export async function beginSession(opts: SessionOptions = {}): Promise<DemoSession> {
  const driver = new CuaDriver({ bin: opts.driverBin });
  if (!(await driver.available())) {
    throw new Error(
      "cua-driver not found. Install it: " +
        'bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh)"',
    );
  }
  const recordingDir = opts.recordingDir ?? defaultRecordingDir();
  await mkdir(recordingDir, { recursive: true });
  await driver.ensureDaemon();
  await driver.startRecording(recordingDir);
  return { recordingDir, driver };
}

/** Stop recording, adapt the trajectory, render the demo. Returns mp4 path. */
export async function endSession(
  session: DemoSession,
  opts: RenderOptions,
): Promise<{ outputPath: string; recordingDir: string }> {
  await session.driver.stopRecording();
  return renderRecordingDir(session.recordingDir, session.driver, opts);
}

/** Adapt + render an already-captured cua recording directory. */
export async function renderExisting(dir: string, opts: RenderOptions) {
  const driver = new CuaDriver({ bin: opts.driverBin });
  return renderRecordingDir(dir, driver, opts);
}

async function renderRecordingDir(
  recordingDir: string,
  driver: CuaDriver,
  opts: RenderOptions,
): Promise<{ outputPath: string; recordingDir: string }> {
  const backend: RenderBackend = opts.backend ?? "openscreen";

  const traj = await loadTrajectory(recordingDir);
  const projectPath = path.join(recordingDir, "supavideo.project.json");
  const adaptation = await writeAdaptation(traj, { ...opts, projectPath });

  const outputPath = await render({
    adaptation,
    recordingDir,
    outputPath: opts.outputPath,
    backend,
    openscreenDir: opts.openscreenDir,
    driver,
  });

  return { outputPath, recordingDir };
}
