#!/usr/bin/env node
// Prints what an MCP client actually receives: serverInfo, instructions and tool descriptions.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(here, "..", "bin", "bailian-tools-mcp.mjs")], {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});

let buffer = "";
const waiters = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    waiters.get(message.id)?.(message);
    waiters.delete(message.id);
  }
});

function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve) => waiters.set(id, resolve));
}

const init = await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "describe", version: "0" },
});
const list = await request("tools/list", {});

console.log("serverInfo:\n" + JSON.stringify(init.result.serverInfo, null, 2));
console.log("\ninstructions:\n" + init.result.instructions);
console.log("\ntools:");
for (const tool of list.result.tools) {
  console.log(`\n  ${tool.name} — ${tool.title}`);
  console.log(`    ${tool.description.slice(0, 220)}...`);
}

child.stdin.end();
child.kill();