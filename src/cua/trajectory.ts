/**
 * Read-only reader for a `cua-driver recording start … --video-experimental`
 * output directory.
 *
 * A recording directory produced by cua-driver looks like:
 *
 *   <dir>/
 *     session.json          { video:{width,height}, cursor:{sample_count}, display_scale_factor, … }
 *     recording.mp4         H.264, 30fps, OS-cursor hidden
 *     cursor.jsonl          one {t_ms, x, y} per line — screen points, top-left origin, ~60Hz
 *     turn-00001/action.json  { tool, arguments:{x,y}?, click_point:{x,y}?, window_bounds:{…}?,
 *                               t_ms_from_session_start, t_start_ms_from_session_start? }
 *     turn-00002/action.json
 *     …
 *
 * These shapes are mirrored from cua's own `TrajectoryLoader.swift`
 * (libs/cua-driver/swift/Sources/CuaDriverCore/Recording/Render/TrajectoryLoader.swift).
 * If cua changes the on-disk format, this file is the one place to update.
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const exec = promisify(execFile);

/** Minimum session metadata the adapter needs to size the project. */
export interface SessionMetadata {
  videoWidth: number; // pixels
  videoHeight: number; // pixels
  cursorSampleCount: number;
  /** Backing scale of the display at capture time (1.0 non-Retina, 2.0 Retina). */
  displayScaleFactor: number;
}

/** One cursor position sample. Screen points, top-left origin. */
export interface CursorSample {
  tMs: number;
  x: number;
  y: number;
}

export type ClickTool = "click" | "double_click" | "right_click";
export type TypeTool = "type_text" | "type_text_chars";
export type ActionTool = ClickTool | TypeTool | string;

/** A single agent action, projected onto the video timeline. */
export interface ActionEvent {
  tool: ActionTool;
  /** When the action completed, ms from session start. */
  tMs: number;
  /** When the action began, ms from session start (falls back to tMs). */
  tStartMs: number;
  /** Screen-point click location (top-left origin), when the action has one. */
  clickPoint?: { x: number; y: number };
  /** Target window bounds in screen points, when known. */
  windowBounds?: { x: number; y: number; width: number; height: number };
}

export interface Trajectory {
  dir: string;
  videoPath: string;
  metadata: SessionMetadata;
  cursorSamples: CursorSample[];
  actions: ActionEvent[];
}

const CLICK_TOOLS = new Set<string>(["click", "double_click", "right_click"]);
const TYPE_TOOLS = new Set<string>(["type_text", "type_text_chars"]);

export function isClickTool(tool: string): boolean {
  return CLICK_TOOLS.has(tool);
}

export function isActionTool(tool: string): boolean {
  return CLICK_TOOLS.has(tool) || TYPE_TOOLS.has(tool);
}

/** Coerce a JSON value (number | numeric-string) to a finite number, else undefined. */
function num(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export async function loadSessionMetadata(sessionPath: string): Promise<SessionMetadata> {
  const raw = JSON.parse(await readFile(sessionPath, "utf-8"));
  const video = raw?.video ?? {};
  // The Swift backend writes video.width/height + display_scale_factor here.
  // The Rust backend (0.6.x) omits both — dimensions live in the mp4 (recovered
  // via ffprobe in loadTrajectory) and there is no scale factor, so default 1.
  return {
    videoWidth: num(video.width) ?? 0,
    videoHeight: num(video.height) ?? 0,
    cursorSampleCount: num(raw?.cursor?.sample_count) ?? 0,
    displayScaleFactor: num(raw?.display_scale_factor) ?? 1,
  };
}

/** ffprobe the video's pixel dimensions. Used when session.json omits them. */
export async function probeVideoDimensions(
  videoPath: string,
): Promise<{ width: number; height: number }> {
  const { stdout } = await exec("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    videoPath,
  ]);
  const stream = JSON.parse(stdout)?.streams?.[0] ?? {};
  return { width: Number(stream.width) || 0, height: Number(stream.height) || 0 };
}

/** Parse `cursor.jsonl`. Missing file → empty array. Bad lines skipped. */
export async function loadCursorSamples(cursorPath: string): Promise<CursorSample[]> {
  if (!existsSync(cursorPath)) return [];
  const text = await readFile(cursorPath, "utf-8");
  const out: CursorSample[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const x = num(obj.x);
    const y = num(obj.y);
    if (x === undefined || y === undefined) continue;
    out.push({ tMs: num(obj.t_ms) ?? 0, x, y });
  }
  out.sort((a, b) => a.tMs - b.tMs);
  return out;
}

/** Parse every `turn-NNNNN/action.json` into ActionEvents, sorted by time. */
export async function loadActions(dir: string): Promise<ActionEvent[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const actions: ActionEvent[] = [];
  for (const name of entries) {
    if (!name.startsWith("turn-")) continue;
    const actionPath = path.join(dir, name, "action.json");
    if (!existsSync(actionPath)) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(await readFile(actionPath, "utf-8"));
    } catch {
      continue;
    }
    const tool = typeof raw.tool === "string" ? raw.tool : undefined;
    if (!tool) continue;

    const tMs = num(raw.t_ms_from_session_start);
    if (tMs === undefined) continue; // can't place it on the timeline
    const tStartMs = num(raw.t_start_ms_from_session_start) ?? tMs;

    // Click coordinate: prefer arguments.{x,y} (pixel-addressed clicks),
    // fall back to click_point.{x,y} (always written at dispatch time).
    let clickPoint: { x: number; y: number } | undefined;
    const args = raw.arguments as Record<string, unknown> | undefined;
    const ax = num(args?.x);
    const ay = num(args?.y);
    if (ax !== undefined && ay !== undefined) {
      clickPoint = { x: ax, y: ay };
    } else {
      const cp = raw.click_point as Record<string, unknown> | undefined;
      const cx = num(cp?.x);
      const cy = num(cp?.y);
      if (cx !== undefined && cy !== undefined) clickPoint = { x: cx, y: cy };
    }

    let windowBounds: ActionEvent["windowBounds"];
    const wb = raw.window_bounds as Record<string, unknown> | undefined;
    const wx = num(wb?.x);
    const wy = num(wb?.y);
    const ww = num(wb?.width);
    const wh = num(wb?.height);
    if (wx !== undefined && wy !== undefined && ww && wh && ww > 0 && wh > 0) {
      windowBounds = { x: wx, y: wy, width: ww, height: wh };
    }

    actions.push({ tool, tMs, tStartMs, clickPoint, windowBounds });
  }
  actions.sort((a, b) => a.tMs - b.tMs);
  return actions;
}

/** Load a full recording directory. Throws if session.json / recording.mp4 are absent. */
export async function loadTrajectory(dir: string): Promise<Trajectory> {
  const sessionPath = path.join(dir, "session.json");
  const videoPath = path.join(dir, "recording.mp4");
  if (!existsSync(sessionPath)) throw new Error(`session.json not found in ${dir}`);
  if (!existsSync(videoPath)) throw new Error(`recording.mp4 not found in ${dir}`);

  const metadata = await loadSessionMetadata(sessionPath);
  // Rust recordings omit video dimensions from session.json — recover them
  // from the mp4 itself so the adapter can normalize coordinates.
  if (metadata.videoWidth <= 0 || metadata.videoHeight <= 0) {
    const dims = await probeVideoDimensions(videoPath);
    metadata.videoWidth = dims.width;
    metadata.videoHeight = dims.height;
  }
  if (metadata.videoWidth <= 0 || metadata.videoHeight <= 0) {
    throw new Error(`could not determine video dimensions for ${dir}`);
  }

  const [cursorSamples, actions] = await Promise.all([
    loadCursorSamples(path.join(dir, "cursor.jsonl")),
    loadActions(dir),
  ]);

  return { dir, videoPath, metadata, cursorSamples, actions };
}
