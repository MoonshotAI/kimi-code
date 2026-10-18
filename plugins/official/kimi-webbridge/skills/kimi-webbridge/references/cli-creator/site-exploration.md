# Site Exploration Protocol

Run this for each planned feature **before** writing any implementation code. It ends with an `evaluate` call that returns the feature's data inside the user's browser session — that call is what the CLI command will wrap.

Every step is a tool from SKILL.md, sent in its Call Format. Use one `session` for the whole exploration — the platform name the CLI will use.

## Steps

1. **`navigate`** `{url: "<target-url>", newTab: true}` — open the page the feature lives on.

2. **`snapshot`** — read the page structure. If the feature is purely DOM-based (the text is already on the page, or the action is one visible button), note the `@e` refs and go to step 7.

3. **`network`** `{cmd: "start"}` — begin capturing.

4. **Trigger the feature** so the page makes its API call — `navigate` to the same URL without `newTab` (it reloads the tab; with `newTab` the capture would stay behind on the old tab), scroll, or `click`. For an action with side effects (posting, liking), ask the user to do it once in the tab you opened instead — capture is per tab.

5. **`network`** `{cmd: "list", filter: "<url-substring>"}` — find the XHR/GraphQL/REST call behind the feature; skip static assets. Then, **while capture is still on**:
   - **`network`** `{cmd: "detail", requestId: "<id>"}` — full URL with query params, method, status, `requestHeaders`, `requestBody`, and the response `body`. Note the response's field names, nesting, and any pagination cursor. In `requestHeaders`, note the ones the page set itself — `authorization`, a CSRF token, a language header, other `x-…` headers: the replay in step 7 has to send them.

   The response body can only be fetched while capture is on.

6. **`network`** `{cmd: "stop"}`

7. **`evaluate`** — replay the call from inside the page. On a same-origin call the browser attaches the user's cookies on its own; when the API is on another host than the page, add `credentials: "include"`:

   ```js
   (async () => {
     const r = await fetch("<api-path>", {
       method: "POST",
       headers: {"Content-Type": "application/json", <headers the page set, from step 5>},
       body: JSON.stringify(<request-body>),
     });
     return JSON.stringify({status: r.status, body: await r.text()});
   })()
   ```

   `evaluate` runs the code as a plain script, so `await` needs the async wrapper.

   For a DOM-based feature (you came here from step 2) there is no call to replay: use `evaluate` to read the content or perform the click, and check the result against what the snapshot showed.

   **Compare the result with the response body captured in step 5** — same items, same count. A replay can return 200 with different data (another language, a shorter list) when it lacks a header the page sends, so "looks plausible" is not the test.

   If the site rejects the replay or the data differs, the replay is missing a header the page sends — compare it against `requestHeaders` from step 5, add what is missing, and retry. The browser attaches `cookie`, `user-agent`, `accept-encoding` and the `sec-…` headers on its own. For a token (`authorization`, a CSRF header), the captured value tells you what to look for: find where the page keeps it — cookies, `<meta>` tags, `localStorage` / `sessionStorage` — then read it from there inside the same `evaluate` call and use it there. It never needs to leave the page, and the CLI must not hardcode it.

## Common patterns

| Pattern | What it means | How to handle |
|---------|---------------|---------------|
| CSRF token header | Token read from a cookie or `<meta>` tag | Read it in the same `evaluate` and set the header |
| Bearer token in web storage | `authorization: Bearer …` in `requestHeaders`; the same token sits in `localStorage` / `sessionStorage` | Read it in the same `evaluate` and send it as the `Authorization` header |
| Cursor pagination | `cursor` / `after` field in the response | Pass the cursor back as a request arg |

## Exploration summary

Write the findings down in the CLI project before writing code:

```
Feature: [home feed / search / post / ...]
Request: [GET/POST] <full URL>   (or "DOM read")
Auth: [cookies only / token header from <where>]
Request params: [query, cursor, limit]
Response shape: {data: [{id, text, author: {name}, created_at}], next_cursor}
Evaluate call: [the working JS]
```
