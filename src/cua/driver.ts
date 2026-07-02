/**
 * Thin wrapper around the `cua-driver` CLI so the orchestrator can start/stop
 * background recording without hand-crafting MCP JSON.
 *
 * Recording state lives in-process in the cua-driver *daemon*, so recording
 * start/stop must talk to a running `cua-driver serve`. We ensure one is up.
 *
 * Reference: libs/cua-driver/swift/Sources/CuaDriverCLI/RecordingCommand.swift
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export interface CuaDriverOptions {
  /** Path to the cua-driver binary. Auto-resolved if omitted. */
  bin?: string;
}

const CANDIDATE_BINS = [
  "cua-driver",
  `${process.env.HOME}/.local/bin/cua-driver`,
  "/usr/local/bin/cua-driver",
  "/opt/homebrew/bin/cua-driver",
];

export function resolveCuaDriverBin(explicit?: string): string {
  if (explicit) return explicit;
  for (const c of CANDIDATE_BINS.slice(1)) if (existsSync(c)) return c;
  return "cua-driver"; // rely on PATH
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[], opts: { detached?: boolean } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: opts.detached ? "ignore" : ["ignore", "pipe", "pipe"],
      detached: opts.detached,
    });
    if (opts.detached) {
      child.unref();
      resolve({ code: 0, stdout: "", stderr: "" });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

export class CuaDriver {
  readonly bin: string;

  constructor(opts: CuaDriverOptions = {}) {
    this.bin = resolveCuaDriverBin(opts.bin);
  }

  /** True if `cua-driver` resolves and reports a version. */
  async available(): Promise<boolean> {
    try {
      const r = await run(this.bin, ["--version"]);
      return r.code === 0;
    } catch {
      return false;
    }
  }

  /** Start `cua-driver serve` in the background if not already listening. */
  async ensureDaemon(): Promise<void> {
    const status = await run(this.bin, ["recording", "status"]);
    // `recording status` fails only when the daemon is unreachable.
    if (status.code === 0) return;
    await run(this.bin, ["serve"], { detached: true });
    for (let i = 0; i < 20; i++) {
      await delay(250);
      const s = await run(this.bin, ["recording", "status"]);
      if (s.code === 0) return;
    }
    throw new Error("cua-driver daemon did not come up (`cua-driver serve`)");
  }

  /** Begin recording to `outputDir`, capturing the display to recording.mp4. */
  async startRecording(outputDir: string): Promise<void> {
    const r = await run(this.bin, ["recording", "start", outputDir, "--video-experimental"]);
    if (r.code !== 0) {
      throw new Error(`cua-driver recording start failed: ${r.stderr || r.stdout}`);
    }
  }

  /** Stop recording. Returns the number of captured turns when reported. */
  async stopRecording(): Promise<{ raw: string }> {
    const r = await run(this.bin, ["recording", "stop"]);
    if (r.code !== 0) {
      throw new Error(`cua-driver recording stop failed: ${r.stderr || r.stdout}`);
    }
    return { raw: r.stdout.trim() };
  }

  /**
   * Fallback native renderer (used only when the OpenScreen path is disabled):
   * cua's own zoom-on-click AVFoundation render. No wallpaper / smooth cursor.
   */
  async nativeRender(inputDir: string, outputPath: string, scale = 2.0): Promise<void> {
    const r = await run(this.bin, [
      "recording",
      "render",
      inputDir,
      "--output",
      outputPath,
      "--scale",
      String(scale),
    ]);
    if (r.code !== 0) {
      throw new Error(`cua-driver recording render failed: ${r.stderr || r.stdout}`);
    }
  }
}
