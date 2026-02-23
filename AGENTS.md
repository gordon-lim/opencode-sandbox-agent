# AGENTS.md

## Cloud-specific instructions

### Overview

**sandboxed-coding-agent** is a Node.js + Hono web service that provides a sandboxed AI coding assistant UI. It proxies chat requests to an external `opencode` runtime via SSE streaming and exposes authenticated workspace file browsing APIs. See `README.md` for full API docs and quickstart.

### SDK dependency

There are three branches with different SDK setups:
- **main**: references `@opencode-ai/sdk` as `file:../opencode-sdk-js` (legacy alpha SDK v0.1.0-alpha.21). The update script provisions this at `/opencode-sdk-js` via `npm pack`.
- **v1**: uses `@opencode-ai/sdk` (root export) from npm `^1.2.6`. Imports `createOpencodeClient` and uses the hey-api v1 call pattern (single options object with `path`/`body`).
- **v2**: uses `@opencode-ai/sdk/v2` from npm `^1.2.6`. Imports `createOpencodeClient` and uses the v2 call pattern (flattened parameters + options). Uses both `session.prompt` (sync) and `session.promptAsync` (fire-and-forget for SSE streaming).

On **v1** and **v2** branches, `yarn install` works directly. On **main**, the update script must provision the local SDK first.

### Running the app

- **App only** (no opencode server): `yarn start` or `yarn dev:app` (watch mode). Requires `AGENT_API_KEY` in `.env`.
- **Full stack** (app + opencode server): `yarn dev`. Requires the `opencode` binary installed and at least one LLM provider key in `.env.opencode`.
- The app starts on port 3000 by default (configurable via `PORT` in `.env`).

### Type checking

There is no separate lint script. Use `yarn typecheck` (`tsc --noEmit`) as the primary static analysis check.

### No automated tests

The project has no test suite or test framework configured. Validation is done via type checking and manual API/UI testing.

### Required secrets

- `OPENAI_API_KEY` — needed to test chat with OpenAI models (e.g. `gpt-4.1-mini`). Write it into `.env.opencode` so the opencode server picks it up.

The built-in `opencode` provider (model `big-pickle`) works without any secrets and is sufficient for basic chat testing.

### Environment files

Copy `.env.example` to `.env` and set `AGENT_API_KEY` to a real value (the app throws at startup if unset). The `.env.example` fallback provides defaults for other values. For the opencode server, copy `.env.opencode.example` to `.env.opencode` and fill in provider API keys (including `OPENAI_API_KEY` for OpenAI models).

### Workspace sandbox

A `sandbox_workspace/` directory is auto-created at runtime. The workspace API endpoints (`/workspace/tree`, `/workspace/file`) serve files from this directory.
