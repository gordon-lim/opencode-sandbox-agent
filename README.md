# sandboxed-coding-agent

Node + Hono service that exposes:

- `POST /chat` (streaming SSE proxy to an opencode session)
- `GET /chat/options` (provider/model catalog from the connected opencode server)
- `GET /workspace/tree` (authenticated file tree for the sandbox root)
- `GET /workspace/file` (authenticated text file preview)
- Browser UI at `/` with two panels (left: workspace explorer, right: `/chat` client)

## Quickstart

1. Install dependencies:

```bash
yarn install
```

2. Create your env file:

```bash
cp .env.example .env
```

3. Update `.env` with at least:

```dotenv
AGENT_API_KEY=your-secret-key-here
OPENCODE_BASE_URL=http://localhost:54321
PORT=3000
WORKSPACE_ROOT=sandbox_workspace
WORKSPACE_MAX_TREE_ENTRIES=2000
WORKSPACE_MAX_TREE_DEPTH=8
WORKSPACE_MAX_FILE_BYTES=1000000
```

4. Install the `opencode` runtime (required, separate process):

```bash
brew install anomalyco/tap/opencode
# or
npm i -g opencode-ai@latest
```

5. Configure provider keys for the opencode server process.

```bash
cp .env.opencode.example .env.opencode
```

Then fill provider keys in `.env.opencode`.
If you set `OPENCODE_SERVER_PASSWORD`, this app will automatically send opencode Basic Auth headers.

6. Run in development mode (starts both opencode server and this app):

```bash
yarn dev
```

7. Open the app:

- `http://localhost:3000` (or your configured `PORT`)
- Paste `AGENT_API_KEY` into the UI’s "Agent API Key" field and click "Connect"
- Provider/model dropdowns are loaded from your running opencode server (no hardcoded model list)
- Optional: set `Username` in the chat form to include user context in each `/chat` request
- Use the left panel to browse files and the right panel to chat

## Run Modes

### `yarn dev` (recommended for local development)

- Starts `opencode serve` using `OPENCODE_BASE_URL` host/port.
- Starts opencode with `WORKSPACE_ROOT` as its working directory (defaults to `sandbox_workspace`).
- Starts this app in watch mode.
- If either process exits, both are stopped.

### `yarn start` (app only)

If you use `yarn start`, run opencode server separately:

```bash
(cd sandbox_workspace && \
  OPENAI_API_KEY=your_provider_key_here \
  opencode serve --hostname=127.0.0.1 --port=54321)

yarn start
```

`yarn start`, `yarn dev`, and `yarn dev:app` auto-load env files from the project root in this priority order:
`.env.local`, `.env.opencode.local`, `.env.opencode`, `.env`, `.env.example`, `.env.opencode.example`.

## SDK + Runtime Notes

- This app uses `@opencode-ai/sdk/v2` APIs (`session.prompt()`, `event.subscribe()`) via `@opencode-ai/sdk`.
- In this repo the dependency points at a local v2-capable SDK source (`file:../opencode/packages/sdk/js`).
- SDK 1.x exports server helpers in both root and v2 (`createOpencodeServer()`, `createOpencode()`).
- These helpers do not embed opencode server code in-process. They spawn external `opencode serve` as a child process, so the `opencode` binary/runtime still must be installed.

## API Quick Use

All API routes require:

```http
Authorization: Bearer <AGENT_API_KEY>
```

### Health check

```bash
curl http://localhost:3000/health
```

### Workspace tree

```bash
curl -H "Authorization: Bearer $AGENT_API_KEY" \
  "http://localhost:3000/workspace/tree"
```

### Workspace file preview

```bash
curl -H "Authorization: Bearer $AGENT_API_KEY" \
  "http://localhost:3000/workspace/file?path=src/index.ts"
```

### Chat options (provider/model catalog)

```bash
curl -H "Authorization: Bearer $AGENT_API_KEY" \
  "http://localhost:3000/chat/options"
```

### Chat (SSE stream)

```bash
curl -N \
  -H "Authorization: Bearer $AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message":"hello","modelID":"<model-id-from-/chat/options>","providerID":"<provider-id-from-/chat/options>","username":"alice"}' \
  http://localhost:3000/chat
```

## Notes

- `AGENT_API_KEY` is required at startup.
- If your port is busy, change `PORT` and restart.
- Chat streaming depends on a reachable `OPENCODE_BASE_URL`.
