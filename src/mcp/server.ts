#!/usr/bin/env node
/**
 * SupaVideo MCP server (stdio).
 *
 * Lets an agent (Claude Code / OpenClaw / Hermes / Codex) produce a polished
 * demo video of itself driving a macOS app. The live-session tools wrap the
 * validated pipeline (src/session.ts): OpenScreen's SCK helper captures the
 * target window only (Retina, cursor hidden), every click the agent issues is
 * both delivered via cua-driver AND logged as the cursor path, and OpenScreen's
 * headless renderer draws the gliding cursor + zoom + wallpaper.
 *
 * Live-session tools (primary):
 *   supavideo_start_demo   { app }                      → { sessionId, window }
 *   supavideo_screenshot   { sessionId }                → window PNG (grounding)
 *   supavideo_click        { sessionId, x, y, label? }  → click + log (window points)
 *   supavideo_finish_demo  { sessionId, out, width? }   → { outputPath }
 *   supavideo_abort_demo   { sessionId }                → stop without rendering
 *
 * Legacy tool (renders an existing cua-driver recording directory):
 *   supavideo_render_recording { dir, out, backend? }
 *
 * Register (Claude Code):
 *   claude mcp add --transport stdio supavideo -- node <abs>/src/mcp/server.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DemoSession } from "../session.ts";
import { renderExisting, type RenderBackend } from "../orchestrator.ts";

const sessions = new Map<string, DemoSession>();

const server = new McpServer({ name: "supavideo", version: "0.2.0" });

function getSession(sessionId: string): DemoSession {
  const s = sessions.get(sessionId);
  if (!s) throw new Error(`unknown sessionId ${sessionId} (active: ${[...sessions.keys()].join(", ") || "none"})`);
  return s;
}

function backend(v: unknown): RenderBackend {
  if (v === "cua-native" || v === "ffmpeg") return v;
  return "openscreen";
}

server.registerTool(
  "supavideo_start_demo",
  {
    description:
      "Start recording a demo of a macOS app. Captures ONLY that app's window " +
      "(Retina, cursor hidden). After this, ground your clicks with " +
      "supavideo_screenshot, drive with supavideo_click (window-local points), " +
      "then supavideo_finish_demo. Keep the app frontmost while clicking.",
    inputSchema: {
      app: z.string().describe("App process name, e.g. 'Music', 'Safari', 'Notes'"),
      openscreenDir: z.string().optional(),
      fps: z.number().optional(),
    },
  },
  async ({ app, openscreenDir, fps }) => {
    const session = await DemoSession.start(app, { openscreenDir, fps });
    const sessionId = randomUUID();
    sessions.set(sessionId, session);
    const { width, height } = session.target.bounds;
    return {
      content: [
        {
          type: "text",
          text:
            `Recording ${app} window (${width}x${height} points), session ${sessionId}. ` +
            `Click coordinates are window-local points, origin at the window's top-left ` +
            `(title bar included). Call supavideo_screenshot to see the window, ` +
            `supavideo_click for each action, then supavideo_finish_demo.`,
        },
      ],
      structuredContent: { sessionId, window: { width, height } },
    };
  },
);

server.registerTool(
  "supavideo_screenshot",
  {
    description:
      "Screenshot the recorded window (downscaled). Use it to decide where to click. " +
      "Coordinates in the image map 1:1 to window-local points when the image width " +
      "equals the window's point width (it does by default).",
    inputSchema: { sessionId: z.string() },
  },
  async ({ sessionId }) => {
    const session = getSession(sessionId);
    const file = await session.screenshot(session.target.bounds.width);
    const data = await readFile(file);
    return {
      content: [{ type: "image", data: data.toString("base64"), mimeType: "image/png" }],
    };
  },
);

server.registerTool(
  "supavideo_click",
  {
    description:
      "Click the recorded window at window-local points (x right, y down from the " +
      "window's top-left). The click is delivered to the app AND becomes part of the " +
      "rendered cursor path — the demo cursor glides here and zooms in.",
    inputSchema: {
      sessionId: z.string(),
      x: z.number(),
      y: z.number(),
      label: z.string().optional().describe("What is being clicked (for logs)"),
    },
  },
  async ({ sessionId, x, y, label }) => {
    const session = getSession(sessionId);
    const rec = await session.click(x, y, label);
    return {
      content: [
        {
          type: "text",
          text: `clicked ${label ?? ""}(${x},${y}) at t=${rec.tMs}ms — ${session.clicks.length} click(s) so far`,
        },
      ],
      structuredContent: { tMs: rec.tMs, clicks: session.clicks.length },
    };
  },
);

server.registerTool(
  "supavideo_finish_demo",
  {
    description:
      "Stop recording and render the polished demo video (wallpaper, gliding cursor, " +
      "zoom-on-click). Takes a few minutes for a ~20s demo. Returns the MP4 path.",
    inputSchema: {
      sessionId: z.string(),
      out: z.string().describe("Output MP4 path"),
      width: z.number().optional().describe("Output width px (default 1920)"),
      noZoom: z.boolean().optional(),
      wallpaper: z.string().optional().describe("CSS gradient/color or OpenScreen wallpaper id"),
    },
  },
  async ({ sessionId, out, width, noZoom, wallpaper }) => {
    const session = getSession(sessionId);
    const { outputPath } = await session.finish({ out, width, noZoom, wallpaper });
    sessions.delete(sessionId);
    return {
      content: [{ type: "text", text: `Demo rendered → ${outputPath}` }],
      structuredContent: { outputPath },
    };
  },
);

server.registerTool(
  "supavideo_abort_demo",
  {
    description: "Abort a demo session without rendering (stops the capture).",
    inputSchema: { sessionId: z.string() },
  },
  async ({ sessionId }) => {
    getSession(sessionId).abort();
    sessions.delete(sessionId);
    return { content: [{ type: "text", text: "aborted" }] };
  },
);

server.registerTool(
  "supavideo_render_recording",
  {
    description:
      "Legacy: adapt + render an already-captured cua-driver recording directory " +
      "(session.json + recording.mp4 + cursor.jsonl + turn-*/) into a demo MP4.",
    inputSchema: {
      dir: z.string(),
      out: z.string(),
      backend: z.enum(["openscreen", "cua-native", "ffmpeg"]).optional(),
      openscreenDir: z.string().optional(),
      noZoom: z.boolean().optional(),
    },
  },
  async ({ dir, out, backend: be, openscreenDir, noZoom }) => {
    const { outputPath } = await renderExisting(path.resolve(dir), {
      outputPath: path.resolve(out),
      backend: backend(be),
      openscreenDir,
      noZoom,
    });
    return {
      content: [{ type: "text", text: `Demo rendered → ${outputPath}` }],
      structuredContent: { outputPath },
    };
  },
);

// Abort any live captures if the client disconnects us.
process.on("SIGTERM", () => {
  for (const s of sessions.values()) s.abort();
  process.exit(0);
});

const transport = new StdioServerTransport();
await server.connect(transport);
