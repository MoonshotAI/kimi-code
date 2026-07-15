# Developing Against an External kimi-code Server

Run the `kimi-code` server directly from a working clone (where changes can be
edited and restarted freely), and point the code-app desktop or web frontend at
it via one environment variable — no submodule round-trips.

## Workflow

```bash
# 1. In a kimi-code clone (e.g. ~/code/kimi-code-5), start the server with
#    the desktop renderer origin allowlisted (needed only for desktop; the
#    web dev server proxies same-origin and needs no CORS):
KIMI_CODE_CORS_ORIGINS=app://renderer pnpm dev:server

# 2a. Desktop against that server (embedded server is NOT started):
KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm dev:desktop

# 2b. Or web against that server:
KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm dev:web
```

## Notes

- **Token is shared via `KIMI_CODE_HOME`.** Both sides default to
  `~/.kimi-code`, so the desktop's token lookup reads the same token file the
  external server writes — no token plumbing. If the server is started with a
  custom `KIMI_CODE_HOME`, pass the same `KIMI_CODE_HOME` to
  `pnpm dev:desktop`.
- The external server uses the CLI's host identity (not `kimi-desktop`), which
  is fine for development.
- `pnpm dev:desktop` without `KIMI_SERVER_URL` keeps the current embedded
  behavior.
