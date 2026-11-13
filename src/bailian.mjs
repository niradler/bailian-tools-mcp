import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_BASE_URL =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen3.8-flash";
const DEFAULT_TIMEOUT_MS = 180_000;

function readProfileKey() {
  const path = process.env.BAILIAN_CONFIG?.trim() || join(homedir(), ".bailian", "config.json");
  try {
    const profile = JSON.parse(readFileSync(path, "utf8"));
    const name = profile.active_config;
    const key = name ? profile[name]?.api_key : undefined;
    return typeof key === "string" && key.trim() ? { key: key.trim(), path, profile: name } : undefined;
  } catch {
    return undefined;
  }
}

export function readConfig() {
  const fromEnv = process.env.BAILIAN_API_KEY?.trim();
  const fromProfile = fromEnv ? undefined : readProfileKey();
  return {
    apiKey: fromEnv || fromProfile?.key || "",
    keySource: fromEnv ? "env" : fromProfile ? `bailian profile "${fromProfile.profile}"` : "missing",
    baseUrl: (process.env.BAILIAN_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: process.env.BAILIAN_MODEL?.trim() || DEFAULT_MODEL,
    timeoutMs: Number(process.env.BAILIAN_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    debug: process.env.BAILIAN_DEBUG === "1",
  };
}

export class BailianError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "BailianError";
    this.status = status;
    this.body = body;
  }
}

export async function createResponse({ input, tools, model, maxOutputTokens = 4096, instructions }) {
  const config = readConfig();
  if (!config.apiKey) {
    throw new BailianError(
      "No API key. Set BAILIAN_API_KEY, or run `bailian auth login --api-key <key>` so the active profile in ~/.bailian/config.json can be used.",
    );
  }

  const body = {
    model: model || config.model,
    input,
    tools,
    max_output_tokens: maxOutputTokens,
  };
  if (instructions) body.instructions = instructions;

  let response;
  try {
    response = await fetch(`${config.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    if (error?.name === "TimeoutError") {
      throw new BailianError(
        `Model Studio did not answer within ${config.timeoutMs} ms (${config.baseUrl}/responses).`,
      );
    }
    throw new BailianError(`Could not reach ${config.baseUrl}/responses: ${error?.message ?? error}`);
  }

  const raw = await response.text();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    throw new BailianError(`Model Studio returned a non-JSON body (HTTP ${response.status}).`, {
      status: response.status,
      body: raw.slice(0, 500),
    });
  }

  if (!response.ok) {
    throw new BailianError(explainHttpError(response.status, payload), {
      status: response.status,
      body: payload,
    });
  }
  if (payload.error) {
    throw new BailianError(payload.error.message || "Model Studio returned an error payload.", {
      status: response.status,
      body: payload,
    });
  }

  return config.debug ? { payload, raw } : payload;
}

function explainHttpError(status, payload) {
  const detail = payload?.error?.message || payload?.message || JSON.stringify(payload).slice(0, 400);
  if (status === 401 || status === 403) {
    return `Model Studio rejected the API key (HTTP ${status}): ${detail}. Token Plan keys work with /compatible-mode/v1 only; a workspace-scoped key is needed for /api/v1/mcps/*.`;
  }
  if (status === 400 && /web_extractor/i.test(detail)) {
    return `Model Studio rejected the request (HTTP 400): ${detail}. The web_extractor tool must be sent together with web_search.`;
  }
  return `Model Studio request failed (HTTP ${status}): ${detail}`;
}

const isUrl = (value) => typeof value === "string" && /^https?:\/\//i.test(value);

export function summarize(payload) {
  const texts = [];
  const sources = [];
  const traces = [];

  const addSource = (url, title) => {
    if (!isUrl(url)) return;
    if (sources.some((source) => source.url === url)) return;
    sources.push({ url, ...(title ? { title } : {}) });
  };

  for (const item of payload?.output ?? []) {
    switch (item?.type) {
      case "message":
        for (const part of item.content ?? []) {
          if (typeof part?.text === "string") texts.push(part.text);
          for (const annotation of part?.annotations ?? []) {
            if (annotation?.type === "url_citation") addSource(annotation.url, annotation.title);
          }
        }
        break;
      case "web_search_call":
        if (item.action?.query) traces.push({ kind: "web_search", detail: item.action.query });
        for (const source of item.action?.sources ?? []) addSource(source.url, source.title);
        break;
      case "web_extractor_call":
        traces.push({
          kind: "web_extractor",
          detail: item.action?.url ?? item.url ?? "extracted page content",
        });
        for (const source of item.action?.sources ?? []) addSource(source.url, source.title);
        break;
      case "code_interpreter_call": {
        const logs = (item.outputs ?? [])
          .map((output) => output?.logs)
          .filter((log) => typeof log === "string" && log.trim())
          .join("\n");
        traces.push({ kind: "code_interpreter", detail: item.code, logs });
        break;
      }
      default: {
        if (!String(item?.type ?? "").endsWith("_call")) break;
        traces.push({ kind: item.type, detail: describeCall(item) });
        collectUrls(item, addSource);
      }
    }
  }

  return { text: texts.join("\n\n").trim(), sources, traces, usage: payload?.usage };
}

function describeCall(item) {
  const query = item.action?.query ?? item.query ?? item.action?.text;
  if (typeof query === "string" && query) return query;
  const urls = [];
  collectUrls(item, (url) => urls.push(url));
  return urls.length ? urls.join(", ") : item.type;
}

function collectUrls(value, onUrl) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectUrls(entry, onUrl);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (isUrl(entry) && (key === "url" || key === "image_url" || key === "source")) {
      onUrl(entry);
    } else if (entry && typeof entry === "object") {
      collectUrls(entry, onUrl);
    }
  }
}

export function formatResult(summary, { title = "Result" } = {}) {
  const lines = [];
  lines.push(summary.text || "_The model returned no text._");

  const traceLines = [];
  for (const trace of summary.traces) {
    if (trace.kind === "web_search") {
      traceLines.push(`- web search: ${trace.detail}`);
    } else if (trace.kind === "code_interpreter") {
      traceLines.push(`- python: ${String(trace.detail).replace(/\s*\n\s*/g, "; ")}`);
      if (trace.logs) {
        const logs = trace.logs.trim().replace(/^```[a-z]*\n?|```$/g, "").trim();
        if (logs) traceLines.push(`  output: ${logs.split("\n").join("\n          ")}`);
      }
    } else {
      traceLines.push(`- ${trace.kind.replace(/_/g, " ")}: ${trace.detail}`);
    }
  }

  if (traceLines.length) {
    lines.push("", "## Tool trace", ...traceLines);
  }
  if (summary.sources.length) {
    lines.push("", "## Sources");
    for (const source of summary.sources) {
      lines.push(`- ${source.title ? `[${source.title}](${source.url})` : source.url}`);
    }
  }
  if (summary.usage?.x_tools) {
    const counts = Object.entries(summary.usage.x_tools)
      .map(([name, value]) => `${name}=${value?.count ?? 0}`)
      .join(", ");
    if (counts) lines.push("", `_Tool calls: ${counts} · ${title}_`);
  }

  return lines.join("\n");
}