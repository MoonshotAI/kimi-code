# Login Handling

## Manual login + a status check

**Do not automate login forms.** Login flows involve CAPTCHA, 2FA and anti-bot checks, and they are different on every site. The CLI works in the user's real browser: the user logs in once by hand, and every later CLI call reuses that session.

## Implementation

### 1. `login-status` is the first command

It must:

- Check the user's identity — call a lightweight authenticated endpoint, or read it from the DOM
- Print `{"ok": true, "data": {"logged_in": true, "user": "<username>"}}` when authenticated
- Print `{"ok": false, "error": {"code": "not_logged_in", "message": "..."}}` and exit 1 when not — an expired session is the same case. The message tells the user to log in to the site in their browser, then run the command again

### 2. Find the auth check endpoint

Run the protocol in `references/cli-creator/site-exploration.md` on the site's home page: start network capture, reload, and look for a call that returns the user's identity (`user_id`, `username`, `is_guest`, …) — typically named like `/me`, `/user/profile`, `/session` or `/auth/status`.

### 3. The command

Open the site's tab (see the CLI contract in `references/cli-creator/workflow.md`), then `evaluate` the call found in step 2 and map its response to `logged_in` / `user`. Take the field names from the exploration findings; a guest response and a failed request both mean "not logged in".
