/**
 * Tests for the CUA → OpenScreen adapter. Run with:  node --test src/adapter
 * (Node 22.6+ / 25 strips the TypeScript types natively — no build step.)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Trajectory } from "../cua/trajectory.ts";
import {
  adaptTrajectory,
  buildCursorRecording,
  buildZoomRegions,
  OPENSCREEN_PROJECT_VERSION,
} from "./toOpenScreenProject.ts";

function fixture(overrides: Partial<Trajectory> = {}): Trajectory {
  return {
    dir: "/tmp/rec",
    videoPath: "/tmp/rec/recording.mp4",
    metadata: { videoWidth: 2560, videoHeight: 1440, cursorSampleCount: 3, displayScaleFactor: 2 },
    cursorSamples: [
      { tMs: 0, x: 100, y: 100 },
      { tMs: 16, x: 200, y: 150 },
      { tMs: 32, x: 300, y: 200 },
    ],
    actions: [
      {
        tool: "click",
        tMs: 1000,
        tStartMs: 700,
        clickPoint: { x: 300, y: 200 },
        windowBounds: { x: 0, y: 0, width: 1280, height: 720 },
      },
    ],
    ...overrides,
  };
}

test("cursor move samples are normalized 0-1 (points × scale ÷ video dims)", () => {
  const traj = fixture();
  const rec = buildCursorRecording(traj.cursorSamples, [], traj.metadata);
  const moves = rec.samples.filter((s) => s.interactionType === "move");
  assert.equal(moves.length, 3);
  // 100 points × 2.0 scale = 200 px; ÷ 2560 wide = 0.078125, ÷ 1440 tall = 0.13889
  assert.ok(Math.abs(moves[0].cx - 200 / 2560) < 1e-9);
  assert.ok(Math.abs(moves[0].cy - 200 / 1440) < 1e-9);
});

test("each click injects a normalized click + mouseup sample", () => {
  const traj = fixture();
  const rec = buildCursorRecording(traj.cursorSamples, traj.actions, traj.metadata);
  const clicks = rec.samples.filter((s) => s.interactionType === "click");
  const ups = rec.samples.filter((s) => s.interactionType === "mouseup");
  assert.equal(clicks.length, 1);
  assert.equal(ups.length, 1);
  // click derived from cursor-at-time (300,200) × 2 = (600,400) px, normalized
  assert.ok(Math.abs(clicks[0].cx - 600 / 2560) < 1e-9);
  assert.ok(Math.abs(clicks[0].cy - 400 / 1440) < 1e-9);
  assert.equal(clicks[0].timeMs, 1000);
  assert.equal(ups[0].timeMs, 1090);
});

test("samples are sorted by time so the renderer's binary search is safe", () => {
  const traj = fixture();
  const rec = buildCursorRecording(traj.cursorSamples, traj.actions, traj.metadata);
  for (let i = 1; i < rec.samples.length; i++) {
    assert.ok(rec.samples[i].timeMs >= rec.samples[i - 1].timeMs);
  }
});

test("a click becomes a normalized, time-padded zoom region", () => {
  const traj = fixture();
  const regions = buildZoomRegions(traj.actions, traj.metadata, {
    zoomDepth: 2,
    zoomLeadMs: 500,
    zoomHoldMs: 900,
  });
  assert.equal(regions.length, 1);
  const r = regions[0];
  assert.equal(r.startMs, 200); // 700 - 500
  assert.equal(r.endMs, 1900); // 1000 + 900
  // click at (300,200) points × 2 = (600,400) px / (2560,1440) = normalized
  assert.ok(Math.abs(r.focus.cx - 600 / 2560) < 1e-9);
  assert.ok(Math.abs(r.focus.cy - 400 / 1440) < 1e-9);
  assert.equal(r.focusMode, "auto");
});

test("clustered clicks in the same spot merge into one sustained zoom", () => {
  const traj = fixture({
    actions: [
      { tool: "click", tMs: 1000, tStartMs: 900, clickPoint: { x: 300, y: 200 } },
      { tool: "click", tMs: 1200, tStartMs: 1150, clickPoint: { x: 310, y: 205 } },
    ],
  });
  const regions = buildZoomRegions(traj.actions, traj.metadata, {
    zoomDepth: 2,
    zoomLeadMs: 500,
    zoomHoldMs: 900,
  });
  assert.equal(regions.length, 1, "two nearby clicks should merge");
  assert.equal(regions[0].endMs, 2100); // last click 1200 + 900
});

test("type actions do not create zoom regions (only clicks do)", () => {
  const traj = fixture({
    actions: [{ tool: "type_text", tMs: 1000, tStartMs: 800, clickPoint: { x: 300, y: 200 } }],
  });
  const regions = buildZoomRegions(traj.actions, traj.metadata, {
    zoomDepth: 2,
    zoomLeadMs: 500,
    zoomHoldMs: 900,
  });
  assert.equal(regions.length, 0);
});

test("adaptTrajectory emits a valid OpenScreen project + sidecar path", () => {
  const traj = fixture();
  const { project, cursorSidecarPath, cursorRecording } = adaptTrajectory(traj);
  assert.equal(project.version, OPENSCREEN_PROJECT_VERSION);
  assert.equal(project.videoPath, traj.videoPath);
  assert.equal(project.editor.zoomRegions.length, 1);
  assert.equal(project.editor.exportFormat, "mp4");
  assert.equal(cursorSidecarPath, "/tmp/rec/recording.mp4.cursor.json");
  assert.equal(cursorRecording.provider, "none");
  assert.ok(cursorRecording.samples.length > 0);
});

test("noZoom disables auto zoom regions", () => {
  const { project } = adaptTrajectory(fixture(), { noZoom: true });
  assert.equal(project.editor.zoomRegions.length, 0);
});
