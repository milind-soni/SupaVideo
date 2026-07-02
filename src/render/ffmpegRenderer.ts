/**
 * Self-contained reference renderer (backend "ffmpeg").
 *
 * Draws the animated cursor + click pulses from the adapted cursor sidecar
 * straight onto the cursorless recording.mp4 — no cua-driver, no Electron, just
 * ffmpeg. It exists to (a) prove the adapter's cursor/zoom data renders into a
 * real video and (b) be a zero-heavy-dependency fallback. The polished
 * "openscreen" backend produces nicer output (wallpaper, smoothing, eased zoom);
 * this one is intentionally simple and dependency-light.
 *
 * The cursor position over time is a piecewise-linear ffmpeg overlay expression
 * built from the cursor samples, so ffmpeg re-evaluates x(t)/y(t) every frame.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RenderRequest } from "./render.ts";
import type { CursorRecordingSample } from "../adapter/openscreenTypes.ts";

const exec = promisify(execFile);

const CURSOR_SIZE = 32; // px, cursor.png is CURSOR_SIZE×CURSOR_SIZE
const RING_SIZE = 72; // px, click pulse ring
const CLICK_PULSE_MS = 350;
const MAX_KEYFRAMES = 48; // cap the overlay expression size

interface Key {
  t: number; // seconds
  v: number; // pixels
}

/** Piecewise-linear ffmpeg expression over `t` (seconds) from keyframes. */
function pieceWiseLinear(keys: Key[]): string {
  if (keys.length === 0) return "0";
  if (keys.length === 1) return String(round(keys[0].v));
  let expr = String(round(keys[keys.length - 1].v)); // hold last value
  for (let i = keys.length - 2; i >= 0; i--) {
    const t0 = keys[i].t;
    const t1 = keys[i + 1].t;
    const v0 = keys[i].v;
    const v1 = keys[i + 1].v;
    const dt = t1 - t0 || 1e-6;
    const seg = `(${round(v0)}+(${round(v1 - v0)})*(t-${round(t0)})/${round(dt)})`;
    expr = `if(lt(t,${round(t1)}),${seg},${expr})`;
  }
  // Hold first value before the first keyframe.
  return `if(lt(t,${round(keys[0].t)}),${round(keys[0].v)},${expr})`;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Evenly downsample move samples to <= MAX_KEYFRAMES, always keeping clicks.
 * Cursor samples are normalized 0-1; multiply by video dims to get pixels. */
function toKeyframes(
  samples: CursorRecordingSample[],
  vw: number,
  vh: number,
): {
  xExpr: string;
  yExpr: string;
  clicks: Array<{ t: number; x: number; y: number }>;
} {
  const px = (s: CursorRecordingSample) => ({ x: s.cx * vw, y: s.cy * vh });
  const moves = samples.filter((s) => s.interactionType !== "mouseup");
  const clickSamples = samples.filter((s) => s.interactionType === "click");

  const stride = Math.max(1, Math.ceil(moves.length / MAX_KEYFRAMES));
  const kept: CursorRecordingSample[] = [];
  for (let i = 0; i < moves.length; i += stride) kept.push(moves[i]);
  if (moves.length && kept[kept.length - 1] !== moves[moves.length - 1]) {
    kept.push(moves[moves.length - 1]);
  }
  // Ensure click points are exact keyframes so the cursor lands on the target.
  for (const c of clickSamples) kept.push(c);
  kept.sort((a, b) => a.timeMs - b.timeMs);

  const xKeys: Key[] = kept.map((s) => ({ t: s.timeMs / 1000, v: px(s).x - CURSOR_SIZE / 2 }));
  const yKeys: Key[] = kept.map((s) => ({ t: s.timeMs / 1000, v: px(s).y - CURSOR_SIZE / 2 }));

  return {
    xExpr: pieceWiseLinear(xKeys),
    yExpr: pieceWiseLinear(yKeys),
    clicks: clickSamples.map((s) => ({ t: s.timeMs / 1000, x: px(s).x, y: px(s).y })),
  };
}

/** Generate the cursor and click-ring PNGs into `dir` via ffmpeg lavfi. */
async function makeSprites(dir: string): Promise<{ cursor: string; ring: string }> {
  const cursor = path.join(dir, "cursor.png");
  const ring = path.join(dir, "ring.png");
  const c = CURSOR_SIZE / 2;
  // White dot (r<7) with a dark accent ring at r≈11.
  await exec("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=black@0.0:s=${CURSOR_SIZE}x${CURSOR_SIZE}:d=1,format=rgba,` +
      `geq=r='255':g='255':b='255':` +
      `a='if(lt(hypot(X-${c},Y-${c}),7),255,if(lt(abs(hypot(X-${c},Y-${c})-11),2),160,0))'`,
    "-frames:v",
    "1",
    cursor,
  ]);
  const rc = RING_SIZE / 2;
  // Bright yellow expanding-look ring for the click pulse.
  await exec("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=black@0.0:s=${RING_SIZE}x${RING_SIZE}:d=1,format=rgba,` +
      `geq=r='255':g='214':b='10':` +
      `a='if(lt(abs(hypot(X-${rc},Y-${rc})-${rc - 6}),3),230,0)'`,
    "-frames:v",
    "1",
    ring,
  ]);
  return { cursor, ring };
}

export async function renderFfmpeg(req: RenderRequest): Promise<string> {
  const { cursorRecording, videoPath } = req.adaptation;
  const work = await mkdtemp(path.join(tmpdir(), "supavideo-ff-"));
  const { cursor, ring } = await makeSprites(work);

  const { xExpr, yExpr, clicks } = toKeyframes(
    cursorRecording.samples,
    req.adaptation.videoWidth,
    req.adaptation.videoHeight,
  );

  // Build the filtergraph:
  //   [0:v] (screen)  ← base
  //   [1:v] (cursor)  ← overlaid, following x(t)/y(t) every frame
  //   [2:v] (ring)    ← pulsed at each click for CLICK_PULSE_MS
  const parts: string[] = [];
  parts.push(`[0:v]setpts=PTS-STARTPTS,format=rgba[base]`);
  parts.push(
    `[base][1:v]overlay=x='${xExpr}':y='${yExpr}':eval=frame:format=auto[cur]`,
  );

  let last = "cur";
  clicks.forEach((clk, i) => {
    const label = `p${i}`;
    const x = Math.round(clk.x - RING_SIZE / 2);
    const y = Math.round(clk.y - RING_SIZE / 2);
    const t0 = round(clk.t);
    const t1 = round(clk.t + CLICK_PULSE_MS / 1000);
    parts.push(
      `[${last}][2:v]overlay=x=${x}:y=${y}:enable='between(t,${t0},${t1})':format=auto[${label}]`,
    );
    last = label;
  });

  parts.push(`[${last}]format=yuv420p[out]`);
  const filter = parts.join(";");

  const args = [
    "-y",
    "-i",
    videoPath,
    "-i",
    cursor,
    "-i",
    ring,
    "-filter_complex",
    filter,
    "-map",
    "[out]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-movflags",
    "+faststart",
    req.outputPath,
  ];

  await exec("ffmpeg", args, { maxBuffer: 1024 * 1024 * 64 });
  return req.outputPath;
}
