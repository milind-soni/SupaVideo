#!/usr/bin/env node
/**
 * Generate a synthetic cua-driver recording directory for testing SupaVideo
 * without cua-driver installed. Produces the exact on-disk shape SupaVideo's
 * trajectory reader expects:
 *
 *   <dir>/session.json
 *   <dir>/recording.mp4      cursorless "screen" with 3 colored buttons
 *   <dir>/cursor.jsonl       cursor gliding start → A → B → C, ~30Hz
 *   <dir>/turn-0000N/action.json   a click on each button
 *
 * Usage:  node scripts/synth-recording.mjs <out-dir>
 */

import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const exec = promisify(execFile);

const W = 1280;
const H = 720;
const DURATION = 6; // seconds
const SCALE = 1; // display_scale_factor (points == pixels for a clean fixture)

// Button centers (screen points). Cursor visits these and clicks each.
const BUTTONS = [
  { name: "A", cx: 250, cy: 180, color: 0x2d6cdf },
  { name: "B", cx: 1000, cy: 200, color: 0x27ae60 },
  { name: "C", cx: 640, cy: 560, color: 0xe67e22 },
];

// Cursor waypoints over time (ms → point). Linear between waypoints.
const START = { x: 90, y: 90 };
const WAYPOINTS = [
  { t: 0, x: START.x, y: START.y },
  { t: 1000, x: BUTTONS[0].cx, y: BUTTONS[0].cy },
  { t: 1500, x: BUTTONS[0].cx, y: BUTTONS[0].cy }, // dwell
  { t: 2600, x: BUTTONS[1].cx, y: BUTTONS[1].cy },
  { t: 3100, x: BUTTONS[1].cx, y: BUTTONS[1].cy },
  { t: 4200, x: BUTTONS[2].cx, y: BUTTONS[2].cy },
  { t: 4700, x: BUTTONS[2].cx, y: BUTTONS[2].cy },
  { t: 6000, x: BUTTONS[2].cx, y: BUTTONS[2].cy },
];
// Click times (ms), aligned to each button's dwell.
const CLICKS = [
  { t: 1200, button: 0 },
  { t: 2800, button: 1 },
  { t: 4400, button: 2 },
];

function lerp(a, b, f) {
  return a + (b - a) * f;
}

function cursorAt(tMs) {
  if (tMs <= WAYPOINTS[0].t) return { x: WAYPOINTS[0].x, y: WAYPOINTS[0].y };
  for (let i = 0; i < WAYPOINTS.length - 1; i++) {
    const a = WAYPOINTS[i];
    const b = WAYPOINTS[i + 1];
    if (tMs >= a.t && tMs <= b.t) {
      const f = (tMs - a.t) / (b.t - a.t || 1);
      return { x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f) };
    }
  }
  const last = WAYPOINTS[WAYPOINTS.length - 1];
  return { x: last.x, y: last.y };
}

function hex(n) {
  return `0x${n.toString(16).padStart(6, "0")}`;
}

async function makeVideo(outPath) {
  // Dark "desktop" with three filled buttons drawn as boxes.
  const boxes = BUTTONS.map((b) => {
    const w = 220;
    const h = 90;
    const x = Math.round(b.cx - w / 2);
    const y = Math.round(b.cy - h / 2);
    return `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${hex(b.color)}:t=fill`;
  }).join(",");
  const vf = `${boxes},format=yuv420p`;
  await exec("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x0f1216:s=${W}x${H}:d=${DURATION}:r=30`,
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "22",
    outPath,
  ]);
}

async function main() {
  const dir = path.resolve(process.argv[2] || "synth-rec");
  await mkdir(dir, { recursive: true });

  // 1. recording.mp4
  await makeVideo(path.join(dir, "recording.mp4"));

  // 2. cursor.jsonl at ~30Hz
  const lines = [];
  let count = 0;
  for (let tMs = 0; tMs <= DURATION * 1000; tMs += 33) {
    const p = cursorAt(tMs);
    lines.push(JSON.stringify({ t_ms: tMs, x: Math.round(p.x), y: Math.round(p.y) }));
    count++;
  }
  await writeFile(path.join(dir, "cursor.jsonl"), lines.join("\n") + "\n");

  // 3. turn-*/action.json — one click per button
  let turn = 1;
  for (const c of CLICKS) {
    const b = BUTTONS[c.button];
    const turnDir = path.join(dir, `turn-${String(turn).padStart(5, "0")}`);
    await mkdir(turnDir, { recursive: true });
    await writeFile(
      path.join(turnDir, "action.json"),
      JSON.stringify(
        {
          tool: "click",
          arguments: { x: b.cx, y: b.cy },
          click_point: { x: b.cx, y: b.cy },
          window_bounds: { x: 0, y: 0, width: W, height: H },
          t_start_ms_from_session_start: c.t - 300,
          t_ms_from_session_start: c.t,
        },
        null,
        2,
      ),
    );
    turn++;
  }

  // 4. session.json
  await writeFile(
    path.join(dir, "session.json"),
    JSON.stringify(
      {
        video: { width: W, height: H, fps: 30 },
        cursor: { sample_count: count },
        display_scale_factor: SCALE,
        duration_ms: DURATION * 1000,
      },
      null,
      2,
    ),
  );

  console.log(`Synthetic recording written to ${dir}`);
  console.log(`  recording.mp4  ${W}x${H} ${DURATION}s`);
  console.log(`  cursor.jsonl   ${count} samples`);
  console.log(`  turns          ${CLICKS.length} clicks`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
