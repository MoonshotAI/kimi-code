# kimi-web vs kimigram Feature Matrix

This document maps the capabilities exposed by the browser UI (`apps/kimi-web`) against the
capabilities currently available through the Telegram bridge (`apps/kimigram`). The goal is to
identify which `kimi-web` features can and should be surfaced in Telegram, and in what order.

**Scope:** `apps/kimi-web` as the reference surface, `apps/kimigram` as the target consumer.
**Matrix date:** 2026-07-07
**Source baseline:** `apps/kimi-web` and `apps/kimigram` as of the commit this branch was created from.

---

## Telegram Constraints

Any feature exposed through Telegram must fit these constraints:

- **Message length:** 4096 characters max per text message.
- **Formatting:** Telegram `MarkdownV2` only; reserved characters must be escaped.
- **Interaction patterns:** text commands (`/<command>`), inline keyboards with callback queries,
  reply threads, and deep links.
- **No native rendering for rich agent output:** diffs, terminals, and complex tool-call cards
  cannot be rendered natively; they must be summarized, attached as files, or deferred to an
  "Open in web" link. Photos and simple images can be sent as Telegram photo/file messages.
- **Pairing model:** `kimigram` pairs one Telegram chat to one `kimi-code` session via a one-time
  code. Multi-session management must be explicit.

---

## Feature Matrix

| Feature Area | kimi-web Capability | kimigram Status | Telegram Feasibility | Priority |
|---|---|---|---|---|
| **Chat / Prompts** | Full composer with streaming, prompt queue, `/steer`, abort, slash commands, `@` mentions, attachments. | **Partial** | Plain-text prompts and replies already work. Queue/steer/abort can be commands; attachments limited; tool-call cards must be summarized. | P1 |
| **Sessions** | List, create, fork, archive, undo, compact, update profile/status, child sessions, BTW side chat. | **Missing** | Commands such as `/status`, `/new`, `/fork`, `/archive`, `/compact` are feasible with confirmation prompts. | P2 |
| **Messages / History** | Paginated history, snapshot, conversation TOC. | **Missing** | `/history` with pagination is feasible, but long output must be chunked or linked. | P2 |
| **Approvals** | Approve/reject/cancel cards with summary and context. | **Partial** | Event already notified as plain text. **High-value:** inline keyboard with **Approve** / **Reject** / **Cancel** buttons. | P0 |
| **Questions** | Single-choice, multi-choice, text, and dismissible question cards. | **Missing** | Inline keyboard or reply-thread answers fit Telegram well. | P1 |
| **Tasks** | List, view output, cancel background tasks; progress streaming. | **Partial** | `task.completed` already notified. Add `/tasks` and streaming progress summaries. | P1 |
| **Terminals** | Attach, input, resize, and stream terminal I/O via WebSocket. | **Missing** | Limited value in Telegram; can create/close and tail text output, but interactive input is poor. | P3 |
| **Skills** | List and activate session/workspace skills. | **Missing** | `/skills` and `/skill <name>` commands are feasible; activation can forward to REST endpoint. | P2 |
| **File System** | List, read, search, grep, git status, diff, download, open in editor. | **Missing** | `/ls`, `/read`, `/search`, `/grep`, `/git_status` commands feasible. Diffs and large files should be summarized or sent as files. | P2 |
| **Workspaces** | Register, rename, delete, browse folders. | **Missing** | Low value in Telegram chat context; browse path could be exposed but rarely used. | P3 |
| **Models / Providers** | List models, manage providers, refresh catalogs. | **Missing** | Read-only `/models` and `/providers` are feasible. OAuth login is not suitable inside Telegram. | P3 |
| **Config** | Get/patch global daemon configuration. | **Missing** | Read-only `/config` is possible; editing config via chat is risky and low value. | P3 |
| **Auth / OAuth** | Server auth dialog, managed OAuth device flow. | **Missing** | Token remains server-side in `kimigram`. OAuth device flow should stay in `kimi-web`. | P3 |
| **Notifications** | Browser notifications, sounds, unread badges. | **Partial** | Telegram messages already act as notifications for milestone events and assistant messages. Expand to more event types (task progress, question, approval). | P2 |

### Cross-Cutting Capabilities

| Capability | Status | Notes |
|---|---|---|
| Reply threading | **Supported** | Telegram → `kimi-code` and `kimi-code` → Telegram thread mappings are persisted in SQLite. |
| Update deduplication | **Supported** | In-memory `update_id` window; lost on restart. |
| WebSocket event stream | **Supported** | Auto-reconnect with exponential backoff. |
| Media / file uploads | **Missing** | Telegram supports file downloads; upload from Telegram to `kimi-code` is feasible but not implemented. |

---

## Prioritized Backlog

### P0 — Highest value, lowest risk

1. **Approval inline keyboards** (`apps/kimigram/src/bot.ts`, `apps/kimigram/src/kimi/events.ts`,
   `apps/kimigram/src/kimi/client.ts`)
   - Turn `event.approval.requested` notifications into inline keyboards:
     `[Approve] [Reject] [Cancel]`.
   - Map callback queries to `POST /api/v1/sessions/{id}/approvals/{approvalId}`.
   - Preserve reply thread so the resolution is threaded under the request.

### P1 — Core user value, moderate effort

2. **Question handling** (`apps/kimigram/src/bot.ts`, `apps/kimigram/src/kimi/events.ts`,
   `apps/kimigram/src/kimi/client.ts`)
   - Listen for `event.question.requested`.
   - Render single/multi-choice questions as inline keyboards; text questions via reply thread.
   - POST answers to `/api/v1/sessions/{id}/questions/{qid}`.

3. **Task list command** (`apps/kimigram/src/bot.ts`, `apps/kimigram/src/kimi/client.ts`)
   - Add `/tasks` command listing active tasks for the paired session.
   - Add `/cancel <taskId>` mapping to `POST /api/v1/sessions/{id}/tasks/{tid}:cancel`.

4. **Prompt lifecycle commands** (`apps/kimigram/src/bot.ts`, `apps/kimigram/src/kimi/client.ts`)
   - Add `/abort` → `POST /api/v1/sessions/{id}:abort`.

5. **Expanded milestone notifications** (`apps/kimigram/src/kimi/events.ts`)
   - Surface `event.question.requested`, `event.task.created`, `event.task.progress`, and
     `event.approval.resolved` as Telegram notifications.

6. **Media / file upload from Telegram** (`apps/kimigram/src/bot.ts`, `apps/kimigram/src/kimi/client.ts`)
   - Forward documents/photos uploaded to the Telegram bot to `POST /api/v1/files`.
   - Attach the returned file ID to the next user prompt.

### P2 — Useful but secondary

7. **Session status command** (`/status`) using `GET /api/v1/sessions/{id}/status`.
8. **File system commands** (`/ls`, `/read`, `/search`, `/grep`, `/git_status`) with chunked or linked output.
9. **Message history command** (`/history`) with pagination and deep links.
10. **Skill listing and activation** (`/skills`, `/skill <name>`).
11. **Session management commands** (`/new`, `/fork`, `/archive`, `/undo`, `/compact`).

### P3 — Low Telegram value or high complexity

12. **Read-only model/provider/config commands** (`/models`, `/providers`, `/config`).
13. **Terminal tail** (`/terminal` create/tail) — limited interactive value.
14. **Workspace management** — defer unless a strong use case emerges.
15. **OAuth / auth flows** — remain in `kimi-web`.

---

## Suggested Interaction Patterns

| Pattern | When to use | Example |
|---|---|---|
| **Text command** | Stateless actions or read-only queries. | `/status`, `/tasks`, `/ls src` |
| **Inline keyboard** | Binary/choice decisions that must not rely on free-form text. | Approval buttons, multiple-choice questions |
| **Reply thread** | Continuing a conversation about a specific message. | Replying to an assistant message to send a follow-up prompt |
| **Deep link** | Rich output that cannot fit Telegram constraints. | "View diff in kimi-web" link |
| **File attachment** | Large output such as logs or diffs. | Send a task log as `.txt` |

---

## Sources

- `apps/kimigram/src/bot.ts` — Telegram command and message handlers.
- `apps/kimigram/src/kimi/events.ts` — WebSocket events surfaced to Telegram.
- `apps/kimigram/src/kimi/client.ts` — REST calls from `kimigram` to the `kimi-code` server.
- `apps/kimi-web/src/api/daemon/client.ts` — REST surface consumed by the browser UI.
- `apps/kimi-web/src/api/daemon/agentEventProjector.ts` and `eventReducer.ts` — event types that drive the web UI.
- Telegram Bot API documentation — message limits, `MarkdownV2`, inline keyboards.
