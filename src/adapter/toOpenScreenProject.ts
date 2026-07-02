/**
 * THE CORE GLUE.
 *
 * Converts a cua-driver recording directory into the two artifacts
 * OpenScreen's exporter consumes:
 *
 *   1. `<videoPath>.cursor.json`  — a CursorRecordingData sidecar with a smooth
 *      "move" sample stream (from cursor.jsonl) plus "click"/"mouseup" samples
 *      injected at each click action. OpenScreen reads this at export time
 *      (electron/ipc/handlers.ts:readCursorRecordingFile) and re-draws a smooth
 *      animated cursor with click-bounce — the "pointer glides to the button".
 *
 *   2. an EditorProjectData object — video path + auto zoom-on-click regions +
 *      wallpaper/appearance defaults. This is what OpenScreen's VideoExporter
 *      turns into the final MP4.
 *
 * Both CUA and OpenScreen already store the cursor as *data* separate from the
 * cursorless video, so this is a field-mapping + coordinate-space transform —
 * not a re-invention.
 *
 * COORDINATE SPACES
 * -----------------
 * cua-driver writes cursor.jsonl x/y and action click_point in *screen points*
 * (top-left origin). recording.mp4 is `videoWidth × videoHeight` *pixels*, where
 * pixels = points × displayScaleFactor. OpenScreen's cursor cx/cy and zoom focus
 * are in video-pixel space, so we scale points → pixels by displayScaleFactor.
 *
 * NOTE: the exact points↔pixels convention (and whether cua already flips Y to
 * top-left — it does, per CursorSampler.swift) should be validated against one
 * real Retina recording; `POINTS_TO_PIXELS` is the single knob to adjust.
 */

import { writeFile } from "node:fs/promises";
import type {
  ActionEvent,
  CursorSample,
  SessionMetadata,
  Trajectory,
} from "../cua/trajectory.ts";
import { isClickTool } from "../cua/trajectory.ts";
import type {
  CursorRecordingData,
  CursorRecordingSample,
  EditorProjectData,
  ProjectEditorState,
  ZoomDepth,
  ZoomRegion,
} from "./openscreenTypes.ts";

/** OpenScreen's current on-disk project version. */
export const OPENSCREEN_PROJECT_VERSION = 2;
export const CURSOR_TELEMETRY_VERSION = 1;

export interface AdapterOptions {
  /** Zoom depth applied to each click region (1–6). Default 2. */
  zoomDepth?: ZoomDepth;
  /** Wallpaper id/path OpenScreen understands. Default: OpenScreen's own default. */
  wallpaper?: string;
  /** Output aspect ratio. Default "16:9". */
  aspectRatio?: EditorProjectData["editor"]["aspectRatio"];
  /** Padding (px of background border) around the recording. Default 50. */
  padding?: number;
  /** ms of lead-in before a click where the zoom begins. Default 500. */
  zoomLeadMs?: number;
  /** ms of hold after a click before the zoom releases. Default 900. */
  zoomHoldMs?: number;
  /** Skip generating auto zoom regions entirely. Default false. */
  noZoom?: boolean;
  /**
   * Override the display scale factor (points→pixels). Needed when the video is
   * an external HD capture (e.g. ffmpeg at Retina 3024) whose pixels are N× the
   * point-space cursor.jsonl. e.g. 3024px / 1512pt = 2.
   */
  displayScaleFactor?: number;
  /** Crop the recording to this normalized (0-1) rect — e.g. isolate one window. */
  cropRegion?: { x: number; y: number; width: number; height: number };
}

const DEFAULTS = {
  zoomDepth: 2 as ZoomDepth,
  // A gradient (not an image path) so the OpenScreen headless render needs no
  // bundled wallpaper assets — classifyWallpaper() treats this as a gradient.
  // Override with any OpenScreen wallpaper id (e.g. "/wallpapers/wallpaper1.jpg").
  wallpaper: "linear-gradient(135deg, #2b5876, #4e4376)",
  aspectRatio: "16:9" as const,
  padding: 50,
  zoomLeadMs: 500,
  zoomHoldMs: 900,
};

/** points → video pixels. Flip to 1 if a recording proves cua already writes pixels. */
function pointsToPixels(displayScaleFactor: number): number {
  return displayScaleFactor > 0 ? displayScaleFactor : 1;
}

/** Interpolate the cursor position (screen points) at time `tMs`. */
function cursorAtTime(samples: CursorSample[], tMs: number): { x: number; y: number } | null {
  if (samples.length === 0) return null;
  if (tMs <= samples[0].tMs) return { x: samples[0].x, y: samples[0].y };
  const last = samples[samples.length - 1];
  if (tMs >= last.tMs) return { x: last.x, y: last.y };
  // linear scan is fine (few actions); samples are sorted ascending.
  for (let i = 1; i < samples.length; i++) {
    const b = samples[i];
    if (tMs <= b.tMs) {
      const a = samples[i - 1];
      const f = (tMs - a.tMs) / (b.tMs - a.tMs || 1);
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
  }
  return { x: last.x, y: last.y };
}

/**
 * Screen-space click location in video pixels. cua's pixel-addressed clicks warp
 * the real cursor, so the cursor position at the click's timestamp is the most
 * reliable screen-space location — and it sidesteps the Rust backend writing
 * `click_point` in window-local coordinates. Falls back to `click_point` when no
 * cursor track is present (e.g. Swift-only or synthetic recordings).
 */
function clickLocationPx(
  action: ActionEvent,
  cursorSamples: CursorSample[],
  k: number,
): { cx: number; cy: number } | null {
  const fromCursor = cursorAtTime(cursorSamples, action.tMs);
  if (fromCursor) return { cx: fromCursor.x * k, cy: fromCursor.y * k };
  if (action.clickPoint) return { cx: action.clickPoint.x * k, cy: action.clickPoint.y * k };
  return null;
}

/**
 * Build the cursor sidecar: every cursor.jsonl sample becomes a "move" sample;
 * every click action injects a "click" sample (and a "mouseup" ~90ms later) at
 * the click point so OpenScreen's click-bounce animation fires.
 */
export function buildCursorRecording(
  cursorSamples: CursorSample[],
  actions: ActionEvent[],
  metadata: SessionMetadata,
): CursorRecordingData {
  const k = pointsToPixels(metadata.displayScaleFactor);
  const W = metadata.videoWidth;
  const H = metadata.videoHeight;
  // OpenScreen cursor samples are NORMALIZED 0-1 of the video (getCroppedCursorPosition
  // divides by cropRegion and clamps to [0,1]). Convert screen points → video pixels
  // (× scale) → normalized (÷ dimension).
  const nx = (px: number) => (W > 0 ? clamp01(px / W) : 0);
  const ny = (py: number) => (H > 0 ? clamp01(py / H) : 0);

  const samples: CursorRecordingSample[] = cursorSamples.map((s) => ({
    timeMs: s.tMs,
    cx: nx(s.x * k),
    cy: ny(s.y * k),
    interactionType: "move",
    cursorType: "arrow",
    visible: true,
  }));

  for (const a of actions) {
    if (!isClickTool(a.tool)) continue;
    const loc = clickLocationPx(a, cursorSamples, k);
    if (!loc) continue;
    const cx = nx(loc.cx);
    const cy = ny(loc.cy);
    samples.push({
      timeMs: a.tMs,
      cx,
      cy,
      interactionType: "click",
      cursorType: "pointer",
      visible: true,
    });
    samples.push({
      timeMs: a.tMs + 90,
      cx,
      cy,
      interactionType: "mouseup",
      cursorType: "pointer",
      visible: true,
    });
  }

  samples.sort((p, q) => p.timeMs - q.timeMs);

  return {
    version: CURSOR_TELEMETRY_VERSION,
    // "none" tells OpenScreen to fall back to its bundled cursor SVGs keyed by
    // cursorType, so we don't have to ship platform cursor bitmaps here.
    provider: "none",
    samples,
    assets: [],
  };
}

/**
 * Generate one zoom-on-click region per click action, focused on the click
 * point (normalized 0-1). Overlapping/adjacent regions are merged so a burst of
 * clicks in the same area reads as one sustained zoom rather than a jitter.
 */
export function buildZoomRegions(
  actions: ActionEvent[],
  metadata: SessionMetadata,
  opts: Required<Pick<AdapterOptions, "zoomDepth" | "zoomLeadMs" | "zoomHoldMs">>,
  cursorSamples: CursorSample[] = [],
): ZoomRegion[] {
  const k = pointsToPixels(metadata.displayScaleFactor);
  const wPx = metadata.videoWidth;
  const hPx = metadata.videoHeight;

  const raw = actions
    .filter((a) => isClickTool(a.tool))
    .map((a) => {
      const loc = clickLocationPx(a, cursorSamples, k);
      if (!loc) return null;
      return {
        startMs: Math.max(0, a.tStartMs - opts.zoomLeadMs),
        endMs: a.tMs + opts.zoomHoldMs,
        cx: clamp01(loc.cx / wPx),
        cy: clamp01(loc.cy / hPx),
      };
    })
    .filter((r): r is { startMs: number; endMs: number; cx: number; cy: number } => r !== null)
    .sort((a, b) => a.startMs - b.startMs);

  // Merge regions that overlap in time AND target roughly the same spot.
  const merged: typeof raw = [];
  for (const r of raw) {
    const prev = merged[merged.length - 1];
    const sameSpot =
      prev && Math.hypot(prev.cx - r.cx, prev.cy - r.cy) < 0.12 && r.startMs <= prev.endMs;
    if (sameSpot) {
      prev.endMs = Math.max(prev.endMs, r.endMs);
      prev.cx = (prev.cx + r.cx) / 2;
      prev.cy = (prev.cy + r.cy) / 2;
    } else {
      merged.push({ ...r });
    }
  }

  return merged.map((r, i) => ({
    id: `zoom-${i + 1}`,
    startMs: Math.round(r.startMs),
    endMs: Math.round(r.endMs),
    depth: opts.zoomDepth,
    focus: { cx: r.cx, cy: r.cy },
    focusMode: "auto",
  }));
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function defaultEditorState(): ProjectEditorState {
  return {
    wallpaper: DEFAULTS.wallpaper,
    shadowIntensity: 0,
    showBlur: false,
    showTrimWaveform: false,
    motionBlurAmount: 0,
    borderRadius: 0,
    padding: DEFAULTS.padding,
    cropRegion: { x: 0, y: 0, width: 1, height: 1 },
    zoomRegions: [],
    trimRegions: [],
    speedRegions: [],
    annotationRegions: [],
    aspectRatio: DEFAULTS.aspectRatio,
    webcamLayoutPreset: "no-webcam",
    webcamMaskShape: "rectangle",
    webcamSizePreset: 25,
    webcamPosition: null,
    exportQuality: "good",
    exportFormat: "mp4",
    gifFrameRate: 15,
    gifLoop: true,
    gifSizePreset: "medium",
  };
}

export interface AdaptResult {
  project: EditorProjectData;
  cursorRecording: CursorRecordingData;
  /** Path where the cursor sidecar should be written for OpenScreen to find it. */
  cursorSidecarPath: string;
  videoPath: string;
  /** Source video dimensions in pixels — the OpenScreen export config needs these. */
  videoWidth: number;
  videoHeight: number;
}

/** Pure transform: trajectory → OpenScreen project + cursor sidecar (no I/O). */
export function adaptTrajectory(traj: Trajectory, options: AdapterOptions = {}): AdaptResult {
  const zoomDepth = options.zoomDepth ?? DEFAULTS.zoomDepth;
  const zoomLeadMs = options.zoomLeadMs ?? DEFAULTS.zoomLeadMs;
  const zoomHoldMs = options.zoomHoldMs ?? DEFAULTS.zoomHoldMs;

  // Override the scale factor when the video is an external HD capture whose
  // pixel space differs from the point-space cursor telemetry.
  if (options.displayScaleFactor !== undefined) {
    traj.metadata.displayScaleFactor = options.displayScaleFactor;
  }

  const cursorRecording = buildCursorRecording(traj.cursorSamples, traj.actions, traj.metadata);

  const editor = defaultEditorState();
  if (options.wallpaper) editor.wallpaper = options.wallpaper;
  if (options.aspectRatio) editor.aspectRatio = options.aspectRatio;
  if (options.padding !== undefined) editor.padding = options.padding;
  if (options.cropRegion) editor.cropRegion = options.cropRegion;
  editor.zoomRegions = options.noZoom
    ? []
    : buildZoomRegions(
        traj.actions,
        traj.metadata,
        { zoomDepth, zoomLeadMs, zoomHoldMs },
        traj.cursorSamples,
      );

  const project: EditorProjectData = {
    version: OPENSCREEN_PROJECT_VERSION,
    videoPath: traj.videoPath,
    editor,
  };

  return {
    project,
    cursorRecording,
    cursorSidecarPath: `${traj.videoPath}.cursor.json`,
    videoPath: traj.videoPath,
    videoWidth: traj.metadata.videoWidth,
    videoHeight: traj.metadata.videoHeight,
  };
}

/** Adapt and write the cursor sidecar (and optionally the project file) to disk. */
export async function writeAdaptation(
  traj: Trajectory,
  options: AdapterOptions & { projectPath?: string } = {},
): Promise<AdaptResult> {
  const result = adaptTrajectory(traj, options);
  await writeFile(result.cursorSidecarPath, JSON.stringify(result.cursorRecording));
  if (options.projectPath) {
    await writeFile(options.projectPath, JSON.stringify(result.project, null, 2));
  }
  return result;
}
