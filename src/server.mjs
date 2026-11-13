#!/usr/bin/env node
import { createInterface } from "node:readline";
import { TOOLS, callTool } from "./tools.mjs";
import { readConfig } from "./bailian.mjs";

const SERVER_INFO = {
  name: "bailian-tools-mcp",
  title: "Alibaba Cloud Model Studio tools",
  version: "0.1.0",
  description:
    "Alibaba Cloud Model Studio built-in tools: web search, page extraction, Python sandbox, image search. Every call is billed to your Model Studio plan.",
};
const SUPPORTED_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

const INSTRUCTIONS =
  "Model Studio built-in tools run server-side and bill your plan per call: web search ~$10 per 1,000 searches in Singapore (~$0.57 elsewhere), extraction free for now, code interpreter per run. Prefer one well-scoped call and ask the user before bulk or repeated use.";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function log(message) {
  process.stderr.write(`[bailian-tools-mcp] ${message}\n`);
}

async function handle(message) {
  const { id, method, params } = message ?? {};

  if (!method) {
    if (id !== undefined) fail(id, -32600, "Invalid request: missing method.");
    return;
  }

  if (id === undefined) {
    // Notifications carry no response. notifications/initialized is the only one we act on.
    return;
  }

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      reply(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.has(requested) ? requested : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
      return;
    }
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (!name) {
        reply(id, toolError("Missing tool name."));
        return;
      }
      try {
        const { text } = await callTool(name, args);
        reply(id, { content: [{ type: "text", text }] });
      } catch (error) {
        log(`${name} failed: ${error?.message ?? error}`);
        reply(id, toolError(error?.message ?? String(error)));
      }
      return;
    }
    case "resources/list":
      reply(id, { resources: [] });
      return;
    case "prompts/list":
      reply(id, { prompts: [] });
      return;
    default:
      fail(id, -32601, `Method not found: ${method}`);
  }
}

function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function run() {
  const config = readConfig();
  log(`ready · ${config.baseUrl} · model ${config.model} · key ${config.keySource}`);
  if (!config.apiKey) {
    log("No API key: set BAILIAN_API_KEY or log in with the bailian CLI. Tools will return an authentication error until then.");
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      fail(null, -32700, "Parse error: each line must be one JSON-RPC message.");
      return;
    }
    queue = queue.then(() => handle(message)).catch((error) => {
      log(`unhandled: ${error?.stack ?? error}`);
      if (message?.id !== undefined) fail(message.id, -32603, error?.message ?? "Internal error");
    });
  });

  rl.on("close", () => {
    process.exitCode = 0;
  });
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("server.mjs");
if (invokedDirectly) run();