---
'@moonshot-ai/kimi-code': patch
---

Fix ACP `session/new` rejecting API-key-only users with `auth_required`.

API-key login (open-platform path) writes `apiKey` into the config file but not the
OAuth credentials file, so the ACP session auth gate — which only checked for an OAuth
token — returned `auth_required` (`-32000`) for every `session/new`, `session/load`,
and `session/resume`, even though the API key was valid. `initialize` still succeeded
(it carries no credentials), so ACP clients saw init OK followed by an auth failure.

`KimiOAuthToolkit.status()` now also surfaces providers configured with a non-empty
`apiKey`, so the gate treats API-key users as authed.
