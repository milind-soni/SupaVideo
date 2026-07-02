#!/usr/bin/env node
/**
 * SupaVideo MCP server (stdio).
 *
 * Exposes the record→video loop as tools so any harness — Claude Code, OpenClaw,
 * Hermes, Codex — can produce a demo video of an agent-driven task. The agent
 * drives the desktop with cua-driver's own MCP tools; SupaVideo brackets that
 * with recording + polished render.
 *
 * Tools:
 *   supavideo_start_demo   { recordingDir? }            → { sessionId, recordingDir }
 *     Begin recording. The agent then drives via cua-driver.
 *   supavideo_finish_demo  { sessionId, out, backend?, openscreenDir? } → { outputPath }
 *     Stop recording, adapt the trajectory, render the demo video.
 *   supavideo_render_recording { dir, out, backend?, openscreenDir? }  → { outputPath }
 *     Adapt + render an already-captured cua recording directory.
 *
 * Register (Claude Code):
 *   claude mcp add --transport stdio supavideo -- node <abs>/src/mcp/server.ts
 *
 * Requires `@modelcontextprotocol/sdk` and `zod` (see package.json).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  beginSession,
  endSession,
  renderExisting,
  type DemoSession,
  type RenderBackend,
} from "../orchestrator.ts";

const sessions = new Map<string, DemoSession>();

const server = new McpServer({ name: "supavideo", version: "0.1.0" });

function backend(v: unknown): RenderBackend {
  if (v === "cua-native" || v === "ffmpeg") return v;
  return "openscreen";
}

server.registerTool(
  "supavideo_start_demo",
  {
    description:
      "Start recording a demo. After this returns, drive the desktop with cua-driver's " +
      "tools to perform the task, then call supavideo_finish_demo with the sessionId.",
    inputSchema: { recordingDir: z.string().optional() },
  },
  async ({ recordingDir }) => {
    const session = await beginSession({ recordingDir });
    const sessionId = randomUUID();
    sessions.set(sessionId, session);
    return {
      content: [
        {
          type: "text",
          text: `Recording started (session ${sessionId}) → ${session.recordingDir}. Drive the task via cua-driver, then call supavideo_finish_demo.`,
        },
      ],
      structuredContent: { sessionId, recordingDir: session.recordingDir },
    };
  },
);

server.registerTool(
  "supavideo_finish_demo",
  {
    description:
      "Stop recording for a session, then adapt + render the polished demo video. " +
      "Returns the output MP4 path.",
    inputSchema: {
      sessionId: z.string(),
      out: z.string().describe("Output MP4 path"),
      backend: z.enum(["openscreen", "cua-native", "ffmpeg"]).optional(),
      openscreenDir: z.string().optional(),
      noZoom: z.boolean().optional(),
    },
  },
  async ({ sessionId, out, backend: be, openscreenDir, noZoom }) => {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`unknown sessionId ${sessionId}`);
    const { outputPath } = await endSession(session, {
      outputPath: path.resolve(out),
      backend: backend(be),
      openscreenDir,
      noZoom,
    });
    sessions.delete(sessionId);
    return {
      content: [{ type: "text", text: `Demo rendered → ${outputPath}` }],
      structuredContent: { outputPath },
    };
  },
);

server.registerTool(
  "supavideo_render_recording",
  {
    description:
      "Adapt + render an already-captured cua-driver recording directory " +
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

const transport = new StdioServerTransport();
await server.connect(transport);
