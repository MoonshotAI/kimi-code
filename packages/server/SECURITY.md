# Server deployment security

Operational guide for exposing the `@moonshot-ai/server` HTTP/WebSocket API beyond
`127.0.0.1`. For reporting vulnerabilities, see the repo root `SECURITY.md`.

## Threat model

The server classifies the bind host into one of three tiers
(`services/auth/bindClassify.ts`):

| Tier | Bind host | Trust boundary | Primary threats | Mitigations |
|---|---|---|---|---|
| loopback | `127.0.0.0/8`, `::1`, `localhost` (default) | This host only; local process isolation | Same-host processes/users connecting to the port; malicious web pages hitting `localhost` (CSRF / DNS rebinding) | Persistent bearer token; Host/Origin checks; token file `0600` (this user only) |
| LAN | RFC1918 + `169.254/16`, `fe80::/10` (`--host 192.168.x.x`) | The local network is untrusted | Network-reachable attackers; brute force; CSRF; remote shell / shutdown | **Full hardening (same as public):** bearer token auth (password optional), TLS or explicit opt-out, auth-failure rate limiting, dangerous endpoints disabled, security headers |
| public | Everything else; `0.0.0.0` / `::` / empty | The whole internet is untrusted | Same as LAN, at internet scale | Same hardening as LAN; a TLS-terminating reverse proxy (or tunnel) is strongly recommended |

**Important:** the hardening gate in `start.ts` is `bindClass !== 'loopback'`. LAN and
public binds therefore receive the **same** hardening stack (TLS opt-out + rate-limit
+ endpoint downgrade + security headers). Authentication is the persistent bearer
token (printed in the startup banner); `KIMI_CODE_PASSWORD` is an optional additional
credential on every tier. The tier label only changes the banner and the automatic
Host allowlist entry. Treat LAN exposure with the same care as public exposure.

Not in scope (see PLAN §6): NAT traversal, untrusted relays, end-to-end encryption.

## Default (loopback) deployment

```
kimi server run          # or: kimi web
```

- Binds `127.0.0.1:58627` by default (`--host` / `--port` to override).
- Uses a persistent bearer token (`crypto.randomBytes(32)`, base64url) generated
  once on first boot and written to `<KIMI_CODE_HOME>/server.token` with mode
  `0600` (parent directory `0700`). The same token is reused across restarts; it
  is NOT deleted when the server exits. Rotate it explicitly with
  `kimi server rotate-token` (a running server picks up the new token without a
  restart).
- The local CLI reads that token file automatically and sends
  `Authorization: Bearer <token>` on every REST/WebSocket call — no setup required.
- Only loopback is reachable; nothing is exposed to the network.

## LAN deployment

Bind a specific LAN interface. Because the hardening gate is `bindClass !== 'loopback'`,
a LAN bind gets the same hardening stack as a public bind:

```
kimi server run --host 192.168.1.10 --insecure-no-tls
```

- Authentication is the persistent bearer token printed in the startup banner; send it
  as `Authorization: Bearer <token>`. `KIMI_CODE_PASSWORD` is optional and adds a
  second credential (it is never required).
- `--insecure-no-tls` is required unless TLS is terminated in front of the server
  (reverse proxy or tunnel). Use it only on a trusted network.
- `POST /api/v1/shutdown` and the PTY `/api/v1/terminals/*` routes are **404 by
  default** on LAN too. Re-enable only with `--allow-remote-shutdown` /
  `--allow-remote-terminals`.
- Auth-failure rate limiting and security response headers are active.

## Public deployment

A public bind is `0.0.0.0`, `::`, an empty host, or any non-RFC1918 address. Put the
server behind a TLS-terminating reverse proxy (or a tunnel); do not terminate TLS in
process.

```
kimi server run --host 0.0.0.0 --insecure-no-tls
```

- Authentication is the persistent bearer token printed in the startup banner;
  `KIMI_CODE_PASSWORD` is optional. `--insecure-no-tls` is mandatory here because
  the proxy terminates TLS; without it (and without app-level TLS) the server refuses
  to bind.
- The reverse proxy must pass through the `Authorization` header and the `Host`
  header, and must upgrade WebSocket connections (see examples below).
- `POST /api/v1/shutdown` and `/api/v1/terminals/*` are **404 by default**. Re-enable
  only with `--allow-remote-shutdown` / `--allow-remote-terminals`.
- Auth-failure rate limiting (10 failures / 60 s window / 60 s ban per source,
  response code `42901`) and security headers are active.
- Prefer a tunnel (`cloudflared`, `ssh -R`) over a raw public bind where possible.

## Reverse-proxy examples

The server listens on `127.0.0.1:58627`; the proxy terminates TLS and forwards to it.

**Caddy** (`Caddyfile`; automatic HTTPS):

```
kimi.example.com {
    reverse_proxy 127.0.0.1:58627
}
```

Caddy's `reverse_proxy` passes `Host`, `Authorization`, and the WebSocket upgrade
headers by default.

**nginx** (TLS terminated at nginx):

```
server {
    listen 443 ssl;
    server_name kimi.example.com;

    ssl_certificate     /etc/letsencrypt/live/kimi.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/kimi.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:58627;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

**Tunnel alternatives:**

- `cloudflared tunnel --url http://127.0.0.1:58627` (Cloudflare Tunnel; no inbound
  firewall rule).
- `ssh -R` (SSH remote port forwarding) to publish the loopback port via a host you
  control.

For both tunnels, keep the server on the default loopback bind; the tunnel provides
the remote reachability and TLS.

## Credential management

- **Token** — a persistent bearer token generated once on first boot, held in
  memory and written to `<KIMI_CODE_HOME>/server.token` (`0600`, directory
  `0700`). It survives restarts and is reused until explicitly rotated with
  `kimi server rotate-token`, which rewrites the file (the previous token stops
  working immediately, even for a running server). The CLI reads it
  automatically; treat the file as a secret.
- **Password** — set `KIMI_CODE_PASSWORD` in the environment. The server hashes it at
  boot with bcrypt (cost 12) and keeps only the hash in memory; verification uses
  `bcrypt.compare`. Password auth is accepted as `Authorization: Bearer <password>`.
- **Stored password hash** — the current path is env-only. There is **no**
  `set-password` subcommand and no config-file hash option yet. If a config-stored
  hash is needed later, generate one externally with cost 12, e.g.:

  ```
  node -e "require('bcryptjs').hash(process.env.KIMI_CODE_PASSWORD,12).then(h=>console.log(h))"
  ```

  (This is forward-looking; do not rely on it until config support lands.)

## Host / Origin allowlists

Host and Origin checks run on every request (HTTP and WebSocket upgrade) on all
tiers.

- **Default Host allowlist:** `localhost`, `*.localhost`, `127.0.0.1`, `::1`,
  `[::1]`, and the actual bind host/IP. Requests with any other `Host` get
  `403 Invalid Host header` (DNS-rebinding protection).
- **`KIMI_CODE_ALLOWED_HOSTS`** — comma-separated extra hosts. A leading dot matches
  a subdomain wildcard, e.g. `KIMI_CODE_ALLOWED_HOSTS=.example.com,kimi.local`.
- **`kimi server run --allowed-host <host...>`** — CLI equivalent for appending
  extra allowed hosts; repeatable or comma-separated.
- **`KIMI_CODE_CORS_ORIGINS`** — comma-separated list of allowed cross-origin values
  (full `scheme://host[:port]`). No `*` wildcard. Matched origins get
  `Access-Control-Allow-Origin` echoed; `OPTIONS` preflight short-circuits to `204`.
  The bundled Web UI is same-origin and needs no entry.
  Example: `KIMI_CODE_CORS_ORIGINS=https://kimi.example.com`.
- **`KIMI_CODE_DISABLE_HOST_CHECK=1`** — disables the Host check entirely on **all**
  tiers (loopback, LAN, and public). Test/controlled environments only; this removes
  the DNS-rebinding protection and must not be set in production.

## Authentication reference

- **HTTP:** `Authorization: Bearer <token|password>` on every route except
  `GET /api/v1/healthz`, `OPTIONS *`, and the static Web UI assets (`/`, `/*`).
  Failure returns `401` with code `40101`.
- **WebSocket:** send either an `Authorization: Bearer <token|password>` header or
  the subprotocol `Sec-WebSocket-Protocol: kimi-code.bearer.<token>` (for browsers
  that cannot set WS headers). The server echoes the matching subprotocol on accept;
  a failed check destroys the socket.

## CLI flags

The only server-exposure flags are:

| Flag | Purpose |
|---|---|
| `--host <host>` | Bind host (default `127.0.0.1`). |
| `--port <port>` | Bind port (default `58627`). |
| `--insecure-no-tls` | Allow a non-loopback bind without app-level TLS (i.e. TLS is terminated by a proxy/tunnel). |
| `--allow-remote-shutdown` | Re-enable `POST /api/v1/shutdown` on a non-loopback bind. |
| `--allow-remote-terminals` | Re-enable the PTY `/api/v1/terminals/*` routes on a non-loopback bind. |

There is no `--bind-class` flag and no `set-password` subcommand.
