#!/usr/bin/env node
// Protocol smoke test. Runs offline by default; add a key and drop --offline to hit the live API.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "..", "bin", "bailian-tools-mcp.mjs");
const offline = process.argv.includes("--offline");

const child = spawn(process.execPath, [bin], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});

const pending = new Map();
let nextId = 1;
let buffer = "";

child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      throw new Error(`Server wrote a non-JSON line: ${line.slice(0, 200)}`);
    }
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter.resolve(message);
    }
  }
});

function request(method, params, timeoutMs = 30_000) {
  const id = nextId++;
  const message = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
  child.stdin.write(`${JSON.stringify(message)}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
    });
  });
}

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`ok   ${message}`);
}

try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  assert(init.result?.serverInfo?.name === "bailian-tools-mcp", "initialize handshake");

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const list = await request("tools/list", {});
  const names = list.result.tools.map((tool) => tool.name);
  assert(names.length === 5, `tools/list exposes 5 tools (${names.join(", ")})`);
  assert(
    ["web_search", "web_extract", "code_interpreter", "image_search", "text_to_image_search"].every(
      (name) => names.includes(name),
    ),
    "all expected tool names are present",
  );

  if (!offline) {
    const call = await request(
      "tools/call",
      { name: "web_search", arguments: { query: "What is the latest Node.js LTS version?" } },
      120_000,
    );
    const text = call.result?.content?.[0]?.text ?? "";
    assert(!call.result?.isError, `live web_search call is not an error (${text.slice(0, 160)})`);
    assert(text.length > 40, "live web_search returns text");
    console.log("\n--- live result ---\n" + text.slice(0, 800));
  } else {
    console.log("offline mode: skipped live tool call");
  }
} finally {
  child.stdin.end();
  child.kill();
}