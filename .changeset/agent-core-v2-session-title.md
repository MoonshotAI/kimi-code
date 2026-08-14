---
"@moonshot-ai/agent-core-v2": minor
---

Add the Session-scoped `ISessionTitleService` for managed AI session titles: composes the excerpt sent to the platform chat_title tool from the main agent's conversation (the first user prompts, the strict `first_turn` pair, or the head+tail `digest` for multi-turn sessions; assistant segments keep only final text), persists the result with a `titleKind` (`replaceable` / `generated` / `custom`) that never overwrites a user-renamed title unless explicitly forced, and rebroadcasts `session.meta.updated`. Gated by the new experimental `auto_session_title` flag and a managed OAuth login.
