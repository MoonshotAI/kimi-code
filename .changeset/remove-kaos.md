---
"@moonshot-ai/kimi-code-sdk": minor
---

Remove the `kaos` / `persistenceKaos` session options and the `createSessionWithKaos` / `resumeSessionWithKaos` client methods. They were already ignored at runtime; hosts should drop these arguments. The internal `@moonshot-ai/kaos` package has been removed from the repository.
