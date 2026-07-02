#!/usr/bin/env node
/**
 * supavideo — turn an agent-driven desktop task into a polished demo video.
 *
 *   supavideo render <recording-dir> --out demo.mp4 [--backend openscreen|cua-native]
 *       Adapt + render a recording captured by `cua-driver recording start … --video-experimental`.
 *       Works today with --backend cua-native.
 *
 *   supavideo record --out demo.mp4 [--recording-dir <dir>]
 *       Start recording, print the cua-driver MCP hookup so your agent can drive,
 *       wait for you to press Enter, then stop + render.
 *
 * The MCP surface (src/mcp/server.ts) exposes the same primitives as tools so
 * Claude Code / OpenClaw / Hermes can call them directly.
 */

import { beginSession, endSession, renderExisting, type RenderBackend } from "./orchestrator.ts";
import { createInterface } from "node:readline/promises";
import path from "node:path";

interface Args {
  _: string[];
  [k: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      (args._ as string[]).push(a);
    }
  }
  return args;
}

function backendOf(args: Args): RenderBackend {
  if (args.backend === "cua-native") return "cua-native";
  if (args.backend === "ffmpeg") return "ffmpeg";
  return "openscreen";
}

function commonRenderOpts(args: Args) {
  return {
    outputPath: path.resolve(String(args.out ?? "demo.mp4")),
    backend: backendOf(args),
    openscreenDir: args["openscreen-dir"] ? String(args["openscreen-dir"]) : undefined,
    driverBin: args["driver-bin"] ? String(args["driver-bin"]) : undefined,
    wallpaper: args.wallpaper ? String(args.wallpaper) : undefined,
    aspectRatio: args.aspect ? (String(args.aspect) as never) : undefined,
    noZoom: args["no-zoom"] === true,
  };
}

async function cmdRender(args: Args): Promise<void> {
  const dir = (args._ as string[])[1];
  if (!dir) throw new Error("usage: supavideo render <recording-dir> --out demo.mp4");
  const { outputPath } = await renderExisting(path.resolve(dir), commonRenderOpts(args));
  console.log(`✓ demo written to ${outputPath}`);
}

async function cmdRecord(args: Args): Promise<void> {
  const session = await beginSession({
    recordingDir: args["recording-dir"] ? String(args["recording-dir"]) : undefined,
    driverBin: args["driver-bin"] ? String(args["driver-bin"]) : undefined,
  });
  console.log(`● recording → ${session.recordingDir}`);
  console.log(
    "\nDrive the desktop now via cua-driver (from your agent), e.g.:\n" +
      "  claude mcp add --transport stdio cua-driver -- cua-driver mcp\n" +
      "Then have the agent perform the task. Press Enter here when done.\n",
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("");
  rl.close();
  const { outputPath } = await endSession(session, commonRenderOpts(args));
  console.log(`✓ demo written to ${outputPath}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = (args._ as string[])[0];
  switch (cmd) {
    case "render":
      await cmdRender(args);
      break;
    case "record":
      await cmdRecord(args);
      break;
    default:
      console.log(
        "supavideo — agent task → demo video\n\n" +
          "  supavideo render <recording-dir> --out demo.mp4 [--backend openscreen|cua-native]\n" +
          "  supavideo record --out demo.mp4 [--recording-dir <dir>]\n\n" +
          "Options: --openscreen-dir <path> --wallpaper <id> --aspect 16:9|9:16|1:1 --no-zoom\n",
      );
      if (cmd) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
