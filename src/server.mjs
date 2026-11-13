#!/usr/bin/env node
import { createInterface } from "node:readline";
import { TOOLS, callTool } from "./tools.mjs";
import { readConfig } from "./bailian.mjs";

const SERVER_INFO = {
  name: "bailian-tools-mcp",
  title: "Alibaba Cloud Model Studio tools",
  version: "0.1.0",
  description:
    "Web search, web extraction, Python code interpreter and image search executed server-side by Alibaba Cloud Model Studio. Every tool call is billed to your Model Studio plan (Credits or pay-as-you-go), so ask the user before bulk or repeated use.",
};
const SUPPORTED_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

const INSTRUCTIONS = [
  "Alibaba Cloud Model Studio built-in tools, executed server-side on your Token Plan or pay-as-you-go key.",
  "Use web_search for anything time-sensitive, web_extract to read a specific page, code_interpreter for Python,",
  "image_search for reverse image lookup, text_to_image_search to find images from a description.",
  "Cost: every call consumes plan Credits. Web search is billed at about $10 per 1,000 searches in Singapore",
  "(about $0.57 per 1,000 in Frankfurt, Virginia, Hong Kong and Tokyo) plus the model tokens it reads, and one call",
  "may run several searches internally. Web extraction is free for now; the code interpreter bills per invocation.",
  "Prefer one well-scoped call over many, never retry in a loop, and confirm with the user before bulk fetching,",
  "crawling, repeated searches or large extractions.",
].join(" ");

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