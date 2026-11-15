Generate [exploration directions] into the frontier and link them into the exploration graph. An intent is an open exploration direction, not a fixed type — describe freely in one summary sentence what to explore/verify/exploit.

Batch preferred: put multiple new directions from one round into the `intents` array in a single submission (saves round trips versus one call per item). Returns an `ids` array, same length and order as `intents` (failed items get id=0, details in `errors`). For a single intent, omit `intents` and pass the top-level `summary`.

- `asset_ids`: the target asset ids this direction tests/attacks (0/1/many; asset ids from list_assets, not exploration node ids). Pass them whenever the direction revolves around concrete assets — it is the structured marker of which targets an exploration hits, used for coverage dedup and asset lineage. Leave empty only for pure global recon with no concrete target.
- `parent_ids`: upstream anchor ids (0/1/many). Only existing [fact/finding] node ids may be passed — not intents/goals/hints. An intent must anchor on confirmed knowledge, finding-driven rather than planned out of thin air. Leave empty for a top-level brand-new recon direction (it is automatically attached to the task's origin fact).
- `priority`: 0-10, default 5.
