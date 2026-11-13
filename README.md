# bailian-tools-mcp

MCP server that puts **Alibaba Cloud Model Studio's built-in tools** into coding agents — web search, web extractor, Python code interpreter, reverse image search and text-to-image search — using **Token Plan** (or pay-as-you-go) API keys.

Works with OpenCode, Claude Code, Codex, and any MCP client that speaks stdio.

## Why this exists

Model Studio's built-in tools are only reachable through the **Responses API** (`POST /compatible-mode/v1/responses` with `tools: [...]`). Coding agents do not call it:

- `enable_search: true` on `/chat/completions` is accepted with HTTP 200 and **silently ignored** — the model still answers that it cannot browse.
- The official MCP gateways (`https://ws-<workspace>.<region>.maas.aliyuncs.com/api/v1/mcps/EnhancedSearch/mcp`) reject Token Plan keys with `401 InvalidApiKey`; they need a workspace-scoped pay-as-you-go key.
- `bailian` CLI's `search web` refuses the `token-plan` profile, and it is a client, not an MCP server.
- OpenCode's native `websearch` tool only supports Exa, Firecrawl, Parallel, Tavily and TinyFish.

So this server does the one missing hop: MCP tools → Responses API built-in tools, on the key you already pay for.

## Requirements

- Node.js 18.17 or newer (no dependencies, no build step)
- A Model Studio API key. Token Plan keys work as-is; the key needs only the model-inference scope.

## Run

```bash
export BAILIAN_API_KEY=sk-...      # PowerShell: $env:BAILIAN_API_KEY = "sk-..."
npx -y github:niradler/bailian-tools-mcp
```

The process speaks MCP over stdio and logs to stderr. Nothing is written to disk.

If you already use the `bailian` CLI, you can skip the env var: with `BAILIAN_API_KEY` unset, the server uses the active profile in `~/.bailian/config.json`.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `BAILIAN_API_KEY` | — (required unless a CLI profile exists) | Model Studio API key |
| `BAILIAN_CONFIG` | `~/.bailian/config.json` | Path to a `bailian` CLI config; when `BAILIAN_API_KEY` is unset, the active profile's `api_key` is used |
| `BAILIAN_BASE_URL` | `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` | OpenAI-compatible endpoint; set this for another region or a workspace URL |
| `BAILIAN_MODEL` | `qwen3.8-flash` | Model that executes the tool call. Must support the Responses API |
| `BAILIAN_TIMEOUT_MS` | `180000` | Per-request timeout |
| `BAILIAN_DEBUG` | unset | `1` includes the raw response in the result |

Any model that supports the Responses API works (`qwen3.8-flash`, `qwen3.8-max`, `qwen4-max-preview`, `deepseek-v4.1-flash-1017`, …). Tool availability varies by model; check the [built-in tools docs](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/token-plan-harness-tool).

## Tools

| Tool | What it does | Upstream |
| --- | --- | --- |
| `web_search` | Live web search with a synthesized answer and source links | `web_search` |
| `web_extract` | Reads one or more URLs for a stated goal | `web_extractor` + `web_search` |
| `code_interpreter` | Runs Python in Alibaba's sandbox, returns answer, code and output | `code_interpreter` |
| `image_search` | Reverse image search from an image URL | `image_search` |
| `text_to_image_search` | Finds images on the web from a description | `web_search_image` |

`web_extract` always sends `web_search` alongside, because the API rejects `web_extractor` on its own (`The web_extractor tool must be executed with web_search tool`).

## OpenCode

### 1.x (`mcp` is a map)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "bailian-tools": {
      "type": "local",
      "command": ["npx", "-y", "github:niradler/bailian-tools-mcp"],
      "environment": {
        "BAILIAN_API_KEY": "{env:BAILIAN_API_KEY}"
      }
    }
  }
}
```

### 2.x (`mcp.servers`)

```jsonc
{
  "mcp": {
    "servers": {
      "bailian-tools": {
        "type": "local",
        "command": ["npx", "-y", "github:niradler/bailian-tools-mcp"],
        "environment": {
          "BAILIAN_API_KEY": "{env:BAILIAN_API_KEY}"
        }
      }
    }
  }
}
```

Or from the CLI:

```bash
opencode mcp add bailian-tools --env BAILIAN_API_KEY={env:BAILIAN_API_KEY} -- npx -y github:niradler/bailian-tools-mcp
opencode mcp list
```

Set `BAILIAN_API_KEY` in your shell profile (`setx BAILIAN_API_KEY "sk-..."` on Windows) — keep the key out of the config file. Start a new session after adding the server so the tools are offered to the model.

## Claude Code

```bash
claude mcp add bailian-tools -e BAILIAN_API_KEY=sk-... -- npx -y github:niradler/bailian-tools-mcp
```

## Codex

```toml
# ~/.codex/config.toml
[mcp_servers.bailian-tools]
command = "npx"
args = ["-y", "bailian-tools-mcp"]
env = { BAILIAN_API_KEY = "sk-..." }

[mcp_servers.bailian-tools.env]
BAILIAN_TIMEOUT_MS = "180000"
```

## Cost

Each tool call is a model request plus the upstream tool fee, billed to your plan Credits or pay-as-you-go account. Web search is the expensive one: the agent policy is **$10 per 1,000 calls in Singapore** versus **$0.573411 in Frankfurt, Virginia, Hong Kong and Tokyo**. Keep `web_search` for questions that need current data; local file reads are free. Set `max_output_tokens` when you only need a short answer.

The server states this in its MCP instructions and appends a footer to every result, so the agent asks before bulk work instead of quietly burning Credits. Set `BAILIAN_COST_NOTICE=off` to silence the footer if your client already enforces its own budget.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `BAILIAN_API_KEY is not set` | Export the key in the environment OpenCode starts from, then restart the session |
| `401` / `InvalidApiKey` | Key is wrong, revoked, or from another region. Token Plan keys only work on the `token-plan.*` endpoint |
| `The web_extractor tool must be executed with web_search tool` | Use this server's `web_extract`, which always pairs them |
| `429` | Plan rate limit or Credits exhausted — check `bailian usage token-plan` |
| Tools listed but the model never calls them | The model needs tool calling; `qwen3.8-flash` and up support it. Also check the client's permission prompt |

## Security

No credentials in this repository. Keys come from the environment, the server keeps no state, and tool output is untrusted web content — see [SECURITY.md](SECURITY.md).

## License

MIT