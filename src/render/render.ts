/**
 * Render backends: turn an adapted recording into the final demo MP4.
 *
 *   - "openscreen" (primary, chosen render path): run OpenScreen's VideoExporter
 *     inside a headless (offscreen) Electron renderer. Produces the polished
 *     Screen-Studio-style output: wallpaper, smooth animated cursor, motion
 *     blur, eased zoom, aspect ratios, GIF.
 *
 *   - "cua-native" (fallback, works today with zero extra deps): cua-driver's
 *     own AVFoundation zoom-on-click render. No wallpaper / smooth cursor.
 *
 * WHY HEADLESS ELECTRON: OpenScreen's exporter (src/lib/exporter/videoExporter.ts)
 * is built on WebCodecs + Canvas + PixiJS — browser APIs. It cannot run in plain
 * Node. The bridge is a hidden BrowserWindow in an Electron main process that
 * loads OpenScreen's exporter bundle and is handed our VideoExporterConfig.
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AdaptResult } from "../adapter/toOpenScreenProject.ts";
import type { CuaDriver } from "../cua/driver.ts";

const exec = promisify(execFile);

export type RenderBackend = "openscreen" | "cua-native" | "ffmpeg";

export interface RenderRequest {
  adaptation: AdaptResult;
  /** cua recording dir — needed by the cua-native fallback. */
  recordingDir: string;
  outputPath: string;
  backend: RenderBackend;
  /** Path to a local OpenScreen checkout with the headless export harness. */
  openscreenDir?: string;
  driver: CuaDriver;
}

/**
 * The exact config the OpenScreen headless entry receives. Mirrors
 * OpenScreen's VideoExporterConfig (src/lib/exporter/videoExporter.ts).
 * VideoExporter takes cursorRecordingData + zoomRegions + wallpaper directly,
 * so no project-file round-trip is required — we pass the adapted values in.
 */
export interface OpenScreenExportConfig {
  videoUrl: string;
  outputPath: string;
  width: number;
  height: number;
  frameRate: number;
  bitrate: number;
  codec: string;
  wallpaper: string;
  zoomRegions: AdaptResult["project"]["editor"]["zoomRegions"];
  cropRegion: AdaptResult["project"]["editor"]["cropRegion"];
  padding: number;
  aspectRatio: string;
  cursorRecordingData: AdaptResult["cursorRecording"];
  cursorScale: number;
  cursorSmoothing: number;
  cursorMotionBlur: number;
  cursorClickBounce: number;
  showShadow: boolean;
  shadowIntensity: number;
  showBlur: boolean;
}

/** Conservative H.264 bitrate for a given resolution/fps (~0.08 bits/px/frame). */
function estimateBitrate(width: number, height: number, fps: number): number {
  return Math.round(width * height * fps * 0.08);
}

export function buildOpenScreenExportConfig(req: RenderRequest): OpenScreenExportConfig {
  const editor = req.adaptation.project.editor;
  const width = req.adaptation.videoWidth;
  const height = req.adaptation.videoHeight;
  const frameRate = 60;
  return {
    videoUrl: req.adaptation.videoPath,
    outputPath: req.outputPath,
    width,
    height,
    frameRate,
    bitrate: estimateBitrate(width, height, frameRate),
    codec: "avc1.640033",
    wallpaper: editor.wallpaper,
    zoomRegions: editor.zoomRegions,
    cropRegion: editor.cropRegion,
    padding: editor.padding,
    aspectRatio: editor.aspectRatio,
    cursorRecordingData: req.adaptation.cursorRecording,
    // OpenScreen defaults (editorDefaults.ts): size 3.0, smoothing 0.67,
    // motionBlur 0.35, clickBounce 2.5.
    cursorScale: 3.0,
    cursorSmoothing: 0.67,
    cursorMotionBlur: 0.35,
    cursorClickBounce: 2.5,
    showShadow: true,
    shadowIntensity: 0.35,
    showBlur: false,
  };
}

export async function render(req: RenderRequest): Promise<string> {
  if (req.backend === "cua-native") return renderCuaNative(req);
  if (req.backend === "ffmpeg") {
    const { renderFfmpeg } = await import("./ffmpegRenderer.ts");
    return renderFfmpeg(req);
  }
  return renderOpenScreen(req);
}

async function renderCuaNative(req: RenderRequest): Promise<string> {
  await req.driver.nativeRender(req.recordingDir, req.outputPath, 2.0);
  return req.outputPath;
}

/**
 * Drive OpenScreen's exporter headlessly.
 *
 * Writes the OpenScreenExportConfig to a temp JSON file and runs the harness
 * (openscreen/headless/electron-main.mjs) via the OpenScreen checkout's own
 * Electron binary. The harness loads dist-headless in a hidden BrowserWindow,
 * runs `VideoExporter.export()`, and writes the MP4 to `outputPath`.
 *
 * Prereqs in the OpenScreen checkout (one-time):
 *   npm install
 *   npm run build:headless
 */
async function renderOpenScreen(req: RenderRequest): Promise<string> {
  const dir = req.openscreenDir;
  if (!dir || !existsSync(dir)) {
    throw new Error(
      "OpenScreen render path needs --openscreen-dir pointing at a local OpenScreen checkout. " +
        "Use backend 'ffmpeg' (self-contained) or 'cua-native' if you don't have one.",
    );
  }
  const harness = path.join(dir, "headless", "electron-main.mjs");
  if (!existsSync(harness)) {
    throw new Error(`OpenScreen headless harness not found at ${harness} (expected in the checkout).`);
  }
  const distHeadless = path.join(dir, "dist-headless", "index.html");
  if (!existsSync(distHeadless)) {
    throw new Error(
      `OpenScreen headless bundle missing (${distHeadless}). ` +
        "Run `npm install && npm run build:headless` in the OpenScreen checkout first.",
    );
  }
  const electronBin = path.join(dir, "node_modules", ".bin", "electron");
  if (!existsSync(electronBin)) {
    throw new Error(
      `Electron not found at ${electronBin}. Run \`npm install\` in the OpenScreen checkout.`,
    );
  }

  const config = buildOpenScreenExportConfig(req);
  const work = await mkdtemp(path.join(tmpdir(), "supavideo-os-"));
  const configPath = path.join(work, "export-config.json");
  await writeFile(configPath, JSON.stringify(config));

  // ELECTRON_RUN_AS_NODE must be unset so the binary boots as Electron, not node.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  await exec(electronBin, [harness, "--config", configPath], {
    cwd: dir,
    env,
    maxBuffer: 1024 * 1024 * 64,
  });

  if (!existsSync(req.outputPath)) {
    throw new Error("OpenScreen export finished but produced no output file.");
  }
  return req.outputPath;
}
