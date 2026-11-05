![License](https://img.shields.io/badge/license-AGPL--3.0-blue)
![Node](https://img.shields.io/badge/node-22+-339933)
![React](https://img.shields.io/badge/react-18-61DAFB)

# hush-web

React web client for [Hush](https://gethush.live) - an end-to-end encrypted communication platform. The client runs OpenMLS compiled to WASM (`@gethush/hush-crypto`) directly in the browser. All encryption happens here, before any data reaches the server.

---

## Modification notice (AGPL-3.0 section 5(a))

**This is a modified version of hush-web by hushhq, modified by Rituals on 2026-11-05** (branch `rituals`, based on upstream `8da7e00`). It is served as "Rituals Space" at `https://space.rit.al`, together with a modified `hush-server` (branch `rituals`) and the unmodified `hush-crypto`. It remains free software under the GNU Affero General Public License v3 (see [LICENSE](LICENSE)), with no warranty. The Corresponding Source of every deployed build is offered at `https://space.rit.al/source/` and linked from the app's About dialog.

What the modification changes:

- Rebranding: the product shows as "Rituals Space" with the Rituals mark, palette, type, icons, manifest and page metadata; the upstream name appears only in the legal/source notice.
- `/space#t=<ticket>` entry: a signed Rituals ticket (taken from the URL fragment, never a path or query) creates this device's identity with no input (client-side recovery phrase, the ticket as invite code, no PIN, `never` vault timeout on the existing non-extractable session key), or unlocks the existing one, then claims the seat with `POST /api/rituals/spaces/claim` and opens the space. Settings gain "Recovery phrase" to save the auto-generated words, with a reminder until they are saved.
- Rituals owns each space's lifecycle: no server creation, discovery, invites, join-by-invite, leaving, deleting or ownership transfer in the UI; no instance picker, roadmap, self-host footer, change announcements, upstream bug reports, desktop update prompts or download links; no GIF entry.
- A native host bridge for the Rituals iOS and Mac apps (`window.webkit.messageHandlers.ritualsSpace`: `{type:"ready"}`, `{type:"title", title}`, and `{type:"error", reason}` for an error screen).
- An About dialog with the AGPL notice and source links (`VITE_RITUALS_SOURCE_WEB`, `_SERVER`, `_CRYPTO` at build time; `envPrefix` also allows `VITE_RITUALS_`), and a Docker build that accepts them as build args.

---

## Prerequisites

- [Node.js](https://nodejs.org/) 22 or later

The `@gethush/hush-crypto` WASM package is published on [npmjs.com](https://www.npmjs.com/package/@gethush/hush-crypto). No extra authentication is needed.

---

## Setup

**1. Clone and install:**

```bash
git clone https://github.com/hushhq/hush-web
cd hush-web
npm ci
```

**3. Configure environment variables:**

```bash
cp .env.example .env.local
# Edit .env.local
```

See [Environment Variables](#environment-variables) below for required vars.

---

## Development

```bash
npm run dev
```

Starts Vite on `http://localhost:5173`. Vite proxies `/api`, `/ws`, and `/livekit` to the Go API (expected at `http://localhost:8080` by default, behind Caddy).

You need a running `hush-server` instance for the client to function. See the [hush-server](https://github.com/hushhq/hush-server) repository.

### Rebuilding the WASM crate

The WASM binary is shipped as part of the `@gethush/hush-crypto` npm package. You do not need to rebuild it for normal development. If you are working on `hush-crypto` locally:

```bash
# Force rebuild from local source
npm run build:wasm:force
```

---

## Testing

```bash
# Run all tests (Vitest, single run)
npm run test:run

# Run in watch mode
npm run test

# Run a specific test file
npx vitest run src/lib/mlsGroup
```

Tests cover MLS group operations, the vault (PIN-based key storage), authentication flows, and WebSocket reconnect behavior. All tests run in Vitest with a simulated WASM environment.

---

## Building for Production

```bash
npm run build
```

Output is in `dist/`. The build includes the WASM binary bundled via Vite's WASM plugin. Serve `dist/` as a static site behind the Go API / Caddy reverse proxy.

To build the Docker image:

```bash
docker build -t hush-web .
```

### Admin UI

`/admin` is **not** part of the hush-web client. The admin dashboard is embedded in `hush-server` and is served by the Go binary at `/admin/`. Do not include admin assets in a hush-web deploy.

---

## Hosted Deploy

`scripts/deploy.sh` publishes the built client using a timestamped release directory and an atomic symlink swap:

```bash
./scripts/deploy.sh --target /path/to/document-root
./scripts/deploy.sh --target /path/to/document-root --keep 10   # retain 10 releases
./scripts/deploy.sh --target /path/to/document-root --no-build  # skip build step
```

After a successful deploy the document root contains:

```
releases/
  20260413220000-abc1234/   <- this release
  20260412190000-def5678/   <- previous release
current -> releases/20260413220000-abc1234/   <- symlink; serve from here
```

Configure the web server to serve from `<target>/current`.

**Branch and revision discipline:** deploy only from a stable, intentional revision — a tagged release or a designated stable branch. Verify before deploying:

```bash
git log --oneline -1
git status
```

---

## Environment Variables

Variables prefixed with `VITE_` are embedded in the client bundle at build time.

| Variable | Required | Description |
|-|-|-|
| `VITE_API_BASE_URL` | Self-host only | Go API base URL (e.g., `https://chat.example.com`) |
| `VITE_WS_URL` | Self-host only | WebSocket URL (e.g., `wss://chat.example.com/ws`) |
| `VITE_LIVEKIT_URL` | Legacy/manual override only | LiveKit WebSocket URL (e.g., `wss://rtc.example.com/`) |
| `VITE_INSTANCE_NAME` | No | Display name shown in the client title |
| `VITE_RITUALS_SOURCE_WEB`, `VITE_RITUALS_SOURCE_SERVER`, `VITE_RITUALS_SOURCE_CRYPTO` | No (Rituals fork) | Public Corresponding Source links in the About dialog; default `https://space.rit.al/source/`. Docker build args of the same names. |
| `VITE_RITUALS_SOURCE_COMMIT` | No (Rituals fork) | Source commit shown next to the version in the About dialog |

**Hosted topology:** when the SPA is served from the same origin as the API (via a reverse proxy such as `hush-server/caddy/Caddyfile.prod`), no `VITE_*` variables are needed. Vite builds with relative-path defaults (`/api`, `/ws`, `/livekit`) that route correctly through the proxy.

**Self-hosted instances** where the SPA lives on a different domain than the API must set `VITE_API_BASE_URL` and `VITE_WS_URL`. Modern `hush-server` instances return their per-instance LiveKit signaling URL from `/api/livekit/token`; use `VITE_LIVEKIT_URL` only for legacy/manual deployments that cannot return that value.

**Never put private keys, bootstrap secrets, session secrets, or any other server-side secrets in `.env.local`** — Vite embeds these values in the JavaScript bundle.

---

## Project Structure

```
hush-web/
├── src/
│   ├── App.jsx              # Router (guild/channel layout)
│   ├── hooks/               # useAuth, useMLS, useRoom, useKeyPackageMaintenance
│   ├── lib/                 # API client, BIP39 identity, MLS group ops, vault, WebSocket client
│   ├── pages/               # TextChannel, VoiceChannel, ServerLayout, Home
│   └── components/          # Chat, ChannelList, MemberList, ServerList, Controls
├── public/                  # Static assets
├── vite.config.js           # Vite config (WASM plugin, API proxy)
└── vitest.config.js         # Vitest config
```

---

## Browser Support

| Browser | Chat E2EE | Media E2EE |
|-|-|-|
| Chromium (Chrome, Edge, Brave, Arc) | Full | Full |
| Firefox | Full | Partial |
| Safari | Full | Limited |

Full media E2EE requires Insertable Streams. See [SECURITY.md](https://github.com/hushhq/hush-server/blob/main/SECURITY.md) for details.

**WebCrypto is required.** The app will not load in environments where `window.crypto.subtle` is unavailable (non-HTTPS origins, some enterprise configurations). There is no fallback to unencrypted operation.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

[AGPL-3.0](LICENSE). If you modify and deploy this client, you must publish your changes under the same license.
