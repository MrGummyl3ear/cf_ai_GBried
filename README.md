# cf_ai_GBried

A Cloudflare Workers chat application that uses Durable Objects to manage chat rooms and WebSockets to relay real‑time messages between connected users. Chat history is persisted in Durable Object storage as a history/augmentation layer, while real‑time messages are broadcast between connected clients directly. An optional AI summarizer (Cloudflare AI model `@cf/meta/llama-3-8b-instruct`) generates succinct bullet‑point summaries of chat text (noted reference: 77.92).

This repository contains the Worker code and configuration needed to run the chat service with Durable Objects and the built‑in AI summarizer.

Highlights
- Per‑room Durable Object controlling connections and state
- WebSocket endpoints for real‑time messaging
- Durable storage for chat history (used only for replay/history)
- AI summarizer that produces bullet points using `@cf/meta/llama-3-8b-instruct`

---

## Table of contents
- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Configuration](#configuration)
- [Deploy](#deploy)
- [Local development](#local-development)
- [How it works](#how-it-works)
- [AI summarizer](#ai-summarizer)
- [Security and privacy](#security-and-privacy)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

---

## Quick start

1. If you haven't already, enable Durable Objects:
   - Visit the Cloudflare dashboard → Workers → Durable Objects and enable Durable Objects for your account.

2. Install Wrangler (Cloudflare Workers CLI). Version 3.30.1 or newer is recommended:
   - See: https://developers.cloudflare.com/workers/cli-wrangler/install-update

3. Authenticate Wrangler with your Cloudflare account:
   - Run:
     ```bash
     wrangler login
     ```

4. Configure your `wrangler.toml` (see [Configuration](#configuration) below).

5. Deploy the Worker:
   ```bash
   wrangler deploy
   ```

---

## Prerequisites
- A Cloudflare account with Durable Objects enabled
- Node.js (LTS recommended) for local dev / builds (if the repo includes a build step)
- Wrangler CLI v3.30.1 or newer
- (Optional) Any secrets/keys required to access Cloudflare AI features if your Cloudflare plan or setup requires explicit credentials

---

## Configuration

A minimal example `wrangler.toml` you can adapt:

```
name = "cf_ai_gbried"
main = "src/index.js" # or the path to your built entry
compatibility_date = "2025-12-24"
account_id = "YOUR_ACCOUNT_ID"
workers_dev = true

[durable_objects]
bindings = [
  { name = "CHAT_ROOM", class_name = "ChatRoom" }
]

[vars]
# Model identifier used by the in-worker AI summarizer
AI_MODEL = "@cf/meta/llama-3-8b-instruct"
# Optional score/reference you wanted to record
AI_MODEL_REFERENCE_SCORE = "77.92"
```

Notes:
- Replace `YOUR_ACCOUNT_ID` with your Cloudflare account ID.
- Ensure the `class_name` matches the Durable Object class exported in your Worker code (e.g., `ChatRoom`).
- If your project uses an environment section (production/staging), add the durable object bindings under each env as appropriate.

If your Worker needs any secrets or API keys for the AI calls, add them via Wrangler:
```bash
wrangler secret put AI_KEY
```
(Only do this if your Worker is explicitly designed to need a separate key — Cloudflare's internal AI models may not require an externally supplied key depending on your account and usage.)

---

## Deploy

Once Wrangler is authenticated and `wrangler.toml` is configured:

1. Build the project (if it has a build step):
   ```bash
   npm install
   npm run build  # if applicable
   ```

2. Deploy to Cloudflare:
   ```bash
   wrangler deploy
   ```

Notes:
- The first deploy may create Durable Object classes and bindings, so ensure the `wrangler.toml` is correct before deploying.
- If you want to deploy to a named environment, use:
  ```bash
  wrangler deploy --env production
  ```

---

## Local development

You can use Wrangler's dev server to run and iterate locally:

```bash
wrangler dev
```

- `wrangler dev` provides a local preview and logs.
- Testing WebSocket + Durable Objects locally can be limited compared to the deployed environment. If your chat’s WebSocket behavior depends on Cloudflare infrastructure, test on a deployed environment (or use `wrangler dev --remote` if needed).

---

## How it works
- At the start of the session there are two button - "Create/join room" and "Generate room's name". Depending on whether the room exists or not it will create room or join the other room.
<img width="1908" height="915" alt="image" src="https://github.com/user-attachments/assets/462cba3e-47d6-4d0a-aeb6-c269e21fe501" />

- Each chat room is represented by a Durable Object instance. The Durable Object:
  - Manages an in‑memory list of currently connected WebSocket clients.
  - Broadcasts messages from one client to all other connected clients in the same room.
  - Stores chat history in durable storage for replay and history display, but does not use storage to relay real-time messages (messages are relayed directly over WebSockets).
- Clients connect over WebSocket to the Worker endpoint. The Worker routes the socket to the appropriate Durable Object instance (room).
- The Worker may trigger the AI summarizer to produce a short bullet‑point summary of the room’s chat history or recent messages.
  <img width="1908" height="897" alt="image" src="https://github.com/user-attachments/assets/c70e44db-45e1-44a7-99aa-890341d2493b" />


---

## AI summarizer

This project includes an AI summarizer configured to use Cloudflare’s model identifier:
- Model: `@cf/meta/llama-3-8b-instruct`
- Reference score (informational): `77.92` (this repository stores this reference; the number has no automatic effect on behavior)

Behavior:
- Summaries are generated from chat text and returned as a short bullet list describing key points.
- Summaries can be requested manually (endpoint or UI control) or invoked automatically, depending on repository implementation.

Configuration tips:
- Use the `AI_MODEL` environment variable (see `wrangler.toml`) to change the model used by the summarizer.
- If your account requires explicit keys or quotas, ensure the Worker has access to the necessary credentials (set with `wrangler secret put`).

---

## Security and privacy

- Chat history is stored persistently in Durable Object storage. Consider retention policies and data minimization depending on the sensitivity of chat content.
- Do not commit secrets or API keys to the repository. Use `wrangler secret put` or your CI secrets store.
- Ensure appropriate CORS / authentication patterns for your front end if the Worker is public.

---

## Troubleshooting

- Error: "Durable Objects not enabled" — Confirm Durable Objects are enabled on your Cloudflare dashboard for the account used with Wrangler.
- Error: "Missing account_id" — Add `account_id` to `wrangler.toml` or set it via environment variables used by Wrangler.
- WebSocket connection issues locally — Some WebSocket behaviors differ locally; deploy to a development environment (workers_dev or a preview route) to fully test.
- AI summarizer not responding — Confirm your Worker has permission/credentials needed to call Cloudflare AI model endpoints (if applicable).

---

## Contributing

Contributions, bug reports, and improvements are welcome. When submitting issues or PRs, please include:
- A clear description of the problem or enhancement
- Steps to reproduce (if a bug)
- Any relevant logs or error messages

---
