# Privacy & offline use

SpaghettiAI is built to run **fully on your own machine**. The vision model is local
(Ollama), your webcam frames are analyzed locally, and **no image ever leaves the
machine** under any configuration. This document is the honest, exhaustive accounting
of every byte that *can* go out — and how to turn each one off for a fully offline or
**air-gapped** install.

## TL;DR

- **Images never leave the machine.** Frames are captured, preprocessed, and sent only
  to your local Ollama server. There is no code path that uploads a snapshot anywhere.
- **By default, exactly one feature makes an outbound request:** the printer **web
  lookup**, and it sends **only the short text the model read off the printer** (e.g.
  `ACE GEN2`) to a search engine — never an image, never your data.
- **Everything else that touches the network is opt-in** (alerts) or local-only
  (Ollama, the API, the MCP server).
- **One browser-side exception:** the `/docs` API page loads Swagger UI from a CDN.
  The API itself is fully local; only that one help page reaches out. See
  [Air-gapped checklist](#air-gapped-checklist) to remove it.

## Outbound connection inventory

Every place SpaghettiAI can open a network connection, what it sends, and the default:

| # | Connection | Where | What is sent | Default | Disable |
|---|------------|-------|--------------|---------|---------|
| 1 | **Ollama** `localhost:11434` | server | Your webcam frame + prompt | On (required) | — (local only; never leaves the host) |
| 2 | **Printer web lookup** (DuckDuckGo HTML endpoint) | server | **Text only** — the branding the model read off the machine | **On** | `printer.webLookup: false` |
| 3 | **Slack / Discord alerts** | server | Alert title + body text (e.g. "Print failure — Kobra X", the summary). **No image.** | **Off** | Don't configure a channel / `alerts.enabled: false` |
| 4 | **Swagger UI** (`unpkg.com`) | **browser** | Nothing about you — it fetches the JS/CSS for the `/docs` page | On (only when you open `/docs`) | Vendor locally (see below) or just don't open `/docs` |
| 5 | **Ollama install + model pull** | setup | Downloads the Ollama binary + model weights | One-time, manual (`npm run setup`) | Pre-install offline (see below) |

Notes:

- **#1 Ollama** is local inference. The frame goes to `http://localhost:11434` and stays
  on the host. If you point `ai.baseUrl` at a *remote* Ollama, then your frames go to
  that host — so for a private setup, keep Ollama local.
- **#2 Web lookup** is the only outbound call in the default configuration. It is
  text-only by construction: see [`src/web/search.ts`](../src/web/search.ts) — the query
  is the model's `visible_text`, and the response is parsed and discarded. It already
  **fails soft**: if the search is blocked or offline, printer detection falls back to a
  vision-only guess.
- **#3 Alerts** never send images — only the short text title/body of the alert. They are
  off until you configure a Slack/Discord channel. Secrets should come from environment
  variables, never the committed config (see [Secrets](#secrets)).
- **#4 Swagger UI** is a convenience for the interactive API explorer at `/docs`. It is a
  **browser** request (your browser → unpkg.com), not the server, and carries no
  SpaghettiAI data. The dashboard, monitor, and settings pages do **not** use any CDN.

## Going fully offline

For a normal private setup (not air-gapped), one line gets you zero outbound server
traffic:

```jsonc
// config.json
{
  "printer": { "webLookup": false },   // disable the only default outbound call
  "alerts":  { "enabled": false }      // already the default
}
```

With `webLookup: false`, printer detection still works — it just names the machine from
what the model can see, without grounding it in a web search.

## Air-gapped checklist

To run on a machine with **no internet at all**, do this once on a connected machine,
then move everything across:

1. **Install Ollama + pull the model offline.**
   - Install the Ollama binary from its offline installer.
   - `ollama pull gemma3:4b` (or your chosen model) on a connected box, then copy the
     model blobs from `~/.ollama/models` to the air-gapped machine's `~/.ollama/models`.
   - Verify with `ollama list` on the target.
2. **Install Node deps offline.** Run `npm ci` on a connected machine and copy the whole
   project folder (including `node_modules/`) across, or use an offline npm cache /
   `npm pack`. No dependency reaches the network at runtime.
3. **Turn off the web lookup:** `printer.webLookup: false` in `config.json`.
4. **Don't configure alerts** (or set `alerts.enabled: false`). Slack/Discord require the
   internet; for an air-gapped box use a future local channel (e.g. ntfy on the LAN) once
   available.
5. **Avoid the `/docs` page**, or vendor Swagger UI locally so it doesn't hit the CDN.
   The dashboard (`/`), monitor (`/monitor`), and settings (`/settings`) pages are fully
   self-contained and work offline as-is. (Vendoring Swagger UI is on the hardening
   roadmap; until then, the raw spec is always available at `/openapi.json`.)
6. **Bind to localhost** (the default `server.host: 127.0.0.1`) unless you deliberately
   need LAN access — see the security notes below.

After these steps, the only network traffic is the local loopback call to Ollama. You can
confirm with a packet capture or by simply pulling the network cable — every feature
except the web lookup keeps working.

## Where your data lives

All persisted data stays on the host, under the data directory
(`data/` by default, or `PW_DATA_DIR` for packaged builds):

- `data/store.json` — check / bed-state / detection / troubleshooting history (text + verdicts)
- `data/snapshots/*.jpg` — the captured frames the model analyzed

Nothing here is uploaded. To wipe history, stop the app and delete `data/`.

## Secrets

- Alert tokens and webhook URLs should be provided via **environment variables**
  (`PW_SLACK_WEBHOOK`, `PW_DISCORD_BOT_TOKEN`, …) so they never live in a committed file.
- The API and settings GUI **mask** stored secrets (`••••••`) and never echo them back.
- If you set a secret through the settings GUI it is written to `config.json` in
  plaintext on disk. Keep that file out of version control (it is not in the repo), or
  prefer the environment-variable path.

## Network exposure

By default the server binds to `127.0.0.1` (localhost only) and is not reachable from
other machines. The API has **no authentication** and permissive CORS, which is fine on
loopback but means: **if you change `server.host` to `0.0.0.0` or expose the port, anyone
who can reach it can trigger checks, read snapshots, and change config.** Only do that on
a trusted network, behind a reverse proxy with auth, or wait for the optional API-token
support on the hardening roadmap. See the project's security hardening plan for details.
</content>
</invoke>
