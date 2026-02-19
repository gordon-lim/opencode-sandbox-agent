# AGENTS.md

## Cloud-specific instructions

### Overview

**sandboxed-coding-agent** is a Node.js + Hono web service that provides a sandboxed AI coding assistant UI. It proxies chat requests to an external `opencode` runtime via SSE streaming and exposes authenticated workspace file browsing APIs. See `README.md` for full API docs and quickstart.

### SDK dependency

`package.json` references `@opencode-ai/sdk` as `file:../opencode-sdk-js`. This sibling directory does not exist in the repo and must be populated from npm before `yarn install`. The update script handles this automatically by running `npm pack @opencode-ai/sdk@0.1.0-alpha.21` and extracting it to `/opencode-sdk-js`.

### Running the app

- **App only** (no opencode server): `yarn start` or `yarn dev:app` (watch mode). Requires `AGENT_API_KEY` in `.env`.
- **Full stack** (app + opencode server): `yarn dev`. Requires the `opencode` binary installed and at least one LLM provider key in `.env.opencode`.
- The app starts on port 3000 by default (configurable via `PORT` in `.env`).

### Type checking

There is no separate lint script. Use `yarn typecheck` (`tsc --noEmit`) as the primary static analysis check.

### No automated tests

The project has no test suite or test framework configured. Validation is done via type checking and manual API/UI testing.

### Environment files

Copy `.env.example` to `.env` and set `AGENT_API_KEY` to a real value (the app throws at startup if unset). The `.env.example` fallback provides defaults for other values. For the opencode server, copy `.env.opencode.example` to `.env.opencode` and fill in provider API keys.

### Workspace sandbox

A `sandbox_workspace/` directory is auto-created at runtime. The workspace API endpoints (`/workspace/tree`, `/workspace/file`) serve files from this directory.
