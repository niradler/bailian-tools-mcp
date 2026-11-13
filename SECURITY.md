# Security

## Secrets

This repository contains no credentials, and pull requests must not add any.

- The server reads the API key from `BAILIAN_API_KEY` (or another environment variable you choose) at runtime.
- Never commit `.env` files, shell history, logs, or captured API responses that contain an `Authorization` header or an `sk-` token. `.gitignore` covers `.env` and log files; that is a safety net, not a licence to paste keys.
- If a key is ever committed, revoke it in the Model Studio console first, then rewrite history. Deleting the commit is not enough once it is pushed.
- Use a dedicated API key per machine or per agent so one leak is cheap to rotate.

## What leaves the machine

When a tool runs, the prompt you pass (query, URLs, task, image URL) and the tool configuration are sent to the Model Studio endpoint in `BAILIAN_BASE_URL`. Nothing else from your machine is included: no files, no environment dump, no repository contents unless you put that text in the tool arguments.

Model Studio executes the tool server-side. `web_search` and `web_extractor` send the query to the search backend; `code_interpreter` runs your task in Alibaba's sandbox, not locally.

## Trust boundary for tool output

Tool output is untrusted web content. Treat retrieved pages and model answers as data, not instructions. An agent that reads a page can be steered by text on that page; keep destructive or publishing actions behind human approval regardless of what a search result claims.

## Reporting

Open a private security advisory on this repository (Security → Report a vulnerability) rather than a public issue. Include the version and a reproduction; expect an answer within a few days.