---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kosong": patch
"@moonshot-ai/kimi-code": patch
---

Fix sessions getting permanently stuck after a provider-filtered response: an assistant message holding only an empty thinking part could persist in the conversation history and was then rejected by the provider ("the message ... with role 'assistant' must not be empty") on every later request. Such wholly-empty messages are now dropped from outgoing requests — thinking content is still round-tripped verbatim — so affected sessions resume normally instead of failing on every turn.
