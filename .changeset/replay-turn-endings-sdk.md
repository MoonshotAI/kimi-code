---
"@moonshot-ai/kimi-code-sdk": minor
---

Resume replay records gain a `turn_ended` variant with the turn id, the end reason and the error of a failed turn, in full replay and in replay limited by `replayTurnLimit`. The replay record type now takes every record that resume passes through unchanged from the engine's definition, so the declared type matches what resume returns; only `message` and `config_updated` keep SDK-specific shapes. Code that handles every replay record type needs a case for `turn_ended`.
