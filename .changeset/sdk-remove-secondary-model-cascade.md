---
"@moonshot-ai/kimi-code-sdk": minor
---

Remove the `cascadeSubagentModelPool` re-export and the `secondaryModel` cascade in `removeProvider` / `planProviderRemoval` (`ProviderRemovalPlan.secondaryModel` is dropped): the `[secondary_model]` section is no longer rewritten when providers or models change, and an entry whose model no longer resolves fails pool validation on the next session create.
