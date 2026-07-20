---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": patch
"@moonshot-ai/agent-core": patch
---

Speed up resuming long sessions by letting callers bound the resumed history to the most recent user turns; the CLI now resumes with only the tail of long histories instead of transferring the full history.
