# kimigram

A Telegram bridge sidecar for [kimi-code](https://github.com/MoonshotAI/kimi-code). It runs next to a local kimi-code server, forwards text messages from Telegram as user prompts, and pushes completion and approval notifications back to Telegram.

## What it does

- Receives Telegram messages via long polling.
- Forwards text from a paired Telegram chat to a linked kimi-code session as a user prompt.
- Subscribes to the kimi-code WebSocket event stream and sends Telegram notifications for:
  - Turn completion
  - Task completion
  - Goal completion
  - Approval requests
  - Assistant messages (converted from Markdown to Telegram MarkdownV2)
- Preserves reply threads between Telegram and kimi-code.
- Auto-reconnects on network failures and deduplicates retried Telegram updates.

## Setup

1. Create a Telegram bot via [@BotFather](https://t.me/BotFather) and copy the bot token.
2. Ensure a kimi-code server is running locally (default `http://127.0.0.1:58627`).
3. Copy `.env.example` to `.env` and set:
   - `TELEGRAM_BOT_TOKEN` — required.
   - Either `KIMI_BEARER_TOKEN` or `KIMI_TOKEN_FILE` pointing to a file containing your kimi-code bearer token.
   - `KIMI_WS_AUTH_MODE` — `subprotocol` (default) or `query`. Prefer `subprotocol`; `query` places the bearer token in the URL and may expose it to proxies or server logs.
4. Install dependencies:
   ```bash
   npm install
   ```
5. Start the sidecar:
   ```bash
   npm run dev
   ```

The sidecar creates a SQLite database at `DATABASE_PATH` (default `./data/kimigram.db`) to store pairings and message-thread mappings.

## How to use

### 1. Pair Telegram with a kimi-code session

A Telegram chat must be paired with a kimi-code session before the bot will forward messages. The pairing is authorized by a one-time code generated inside the authenticated kimi-code session.

Find your active kimi-code session ID:

```bash
npm run sessions
```

Then generate a pairing code for that session:

```bash
npm run pair -- <session-id>
```

Then send the printed code to the bot in a private chat:

```
/start <code>
```

The bot replies with the linked session ID. One Telegram chat can be paired with one session at a time.

### 2. Send prompts from Telegram

Once paired, any plain text message you send to the bot is forwarded to the linked kimi-code session as a user prompt. The bot replies with "Prompt sent." when the REST call succeeds.

If the chat is not paired, the bot responds with setup instructions and does not forward the message.

### 3. Reply to keep threads

- To reply to a specific assistant message in Telegram, use Telegram's reply feature on that bot message. kimigram maps it back to the correct kimi-code `user_message_id` and includes it as `reply_to_message_id` in the prompt.
- When kimi-code emits a reply that references a parent message, kimigram links the Telegram notification to the original Telegram message using `reply_parameters`.

Thread mappings are stored in SQLite, so they survive sidecar restarts.

### 4. Get notifications

While paired, you receive Telegram notifications for session events:

| kimi-code event | Telegram notification |
|-----------------|------------------------|
| `turn.ended` | "Turn completed." |
| `task.completed` / `background.task.terminated` | "Task completed." |
| `goal.updated` with `status: completed` | "Goal completed." |
| `approval.requested` / `event.approval.requested` | "Approval requested." (with optional summary) |
| `assistant.message` | Converted Markdown → Telegram MarkdownV2, with plain-text fallback if conversion would produce invalid markup |

Milestone notifications are always sent as plain text. Events for unpaired or inactive sessions are ignored.

### 5. Unpair or switch sessions

To link the chat to a different session, generate a new pairing code from the new session and run `/start <new-code>`. The bot replaces the previous pairing with the new one.

## Reliability

- The sidecar auto-reconnects to both Telegram long polling and the kimi-code WebSocket after network failures.
- Reconnect delay for the WebSocket client backs off exponentially up to 30 seconds.
- Incoming Telegram updates are deduplicated by `update_id` using a bounded in-memory window, so retries or redelivered updates are not forwarded to kimi-code twice. The window is in-memory only, so duplicates may be re-processed after a process restart.

## Development

```bash
npm run dev      # Start with tsx
npm run build    # TypeScript compile
npm test         # Run tests
npm run lint     # Type check
```

## Architecture

- `src/config.ts` — Environment configuration and validation.
- `src/logger.ts` — Pino logger factory.
- `src/store.ts` — SQLite persistence for pairings and thread mappings.
- `src/pairing.ts` — One-time pairing code generation and validation.
- `src/bot.ts` — Telegram bot handlers (`/start`, text-message forwarding) and `createUpdateIdDedupMiddleware()` for `update_id` deduplication.
- `src/kimi/client.ts` — REST client for the running kimi-code server.
- `src/kimi/ws.ts` — WebSocket client for the kimi-code event stream.
- `src/kimi/events.ts` — Dispatcher that maps kimi-code events to Telegram notifications.
- `src/threads.ts` — Maps Telegram `message_id` ↔ kimi-code `user_message_id` for reply threading.
- `src/formatting/telegramMarkdown.ts` — Converts kimi-code Markdown to Telegram MarkdownV2 with plain-text fallback.
- `src/index.ts` — Service entrypoint.
