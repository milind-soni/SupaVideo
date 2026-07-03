#!/usr/bin/env node
/**
 * End-to-end MCP verification: spawn the SupaVideo MCP server, drive a real
 * demo session over stdio JSON-RPC (start → screenshot → clicks → finish),
 * and assert a playable MP4 comes out.
 *
 *   node test/mcp-e2e.mjs [--app Music] [--out ~/mcp-demo.mp4] [--width 1280]
 *
 * Requires: the target app running, cua-driver installed, OpenScreen checkout
 * built (headless + native helper), Screen Recording permission.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import readline from "node:readline";

const exec = promisify(execFile);

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const APP = arg("app", "Music");
const OUT = path.resolve(arg("out", `${process.env.HOME}/mcp-demo.mp4`));
const WIDTH = Number(arg("width", "1280"));

const serverPath = new URL("../src/mcp/server.ts", import.meta.url).pathname;
const child = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "inherit"] });
const rl = readline.createInterface({ input: child.stdout });

let nextId = 1;
const pending = new Map();
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
});

function rpc(method, params, timeoutMs = 300000) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(t);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(t);
        reject(e);
      },
    });
  });
}

const callTool = async (name, args, timeoutMs) => {
  const res = await rpc("tools/call", { name, arguments: args }, timeoutMs);
  if (res.isError) throw new Error(`${name}: ${res.content?.[0]?.text ?? "tool error"}`);
  return res;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // MCP handshake
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "supavideo-e2e", version: "0.0.1" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const tools = await rpc("tools/list", {});
  const names = tools.tools.map((t) => t.name);
  console.log(`tools: ${names.join(", ")}`);
  for (const required of [
    "supavideo_start_demo",
    "supavideo_screenshot",
    "supavideo_click",
    "supavideo_finish_demo",
  ]) {
    if (!names.includes(required)) throw new Error(`missing tool ${required}`);
  }

  // Start a session on the target app
  const start = await callTool("supavideo_start_demo", { app: APP }, 60000);
  const { sessionId, window } = start.structuredContent;
  console.log(`session ${sessionId} — window ${window.width}x${window.height}pt`);

  // Screenshot for grounding (verify we get an image back)
  const shot = await callTool("supavideo_screenshot", { sessionId }, 30000);
  const img = shot.content.find((c) => c.type === "image");
  if (!img?.data || img.data.length < 10000) throw new Error("screenshot too small / missing");
  console.log(`screenshot: ${(img.data.length / 1024).toFixed(0)}kb base64 ✓`);

  // Drive a short sidebar tour (window-local points, Music fullscreen layout)
  for (const [x, y, label, wait] of [
    [108, 100, "Home", 1800],
    [108, 132, "New", 1800],
    [108, 292, "Albums", 1800],
  ]) {
    const r = await callTool("supavideo_click", { sessionId, x, y, label }, 30000);
    console.log(r.content[0].text);
    await sleep(wait);
  }

  // Finish → render (the slow part)
  console.log("rendering…");
  const fin = await callTool(
    "supavideo_finish_demo",
    { sessionId, out: OUT, width: WIDTH },
    600000,
  );
  console.log(fin.content[0].text);

  // Assert a real, playable video
  if (!existsSync(OUT)) throw new Error("no output file");
  const { stdout } = await exec("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,duration", "-of", "csv=p=0", OUT,
  ]);
  const [w, h, dur] = stdout.trim().split(",").map(Number);
  if (!(w > 0 && h > 0 && dur > 4)) throw new Error(`bad video: ${stdout}`);
  console.log(`✓ e2e OK — ${OUT} (${w}x${h}, ${dur.toFixed(1)}s)`);
  process.exitCode = 0;
} catch (e) {
  console.error(`✗ e2e FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  child.kill();
}
