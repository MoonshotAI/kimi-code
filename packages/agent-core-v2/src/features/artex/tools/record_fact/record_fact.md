Write an exploration [fact/conclusion] into the exploration graph, linked to the intent that produced it (`intent_id`). Record exploration results — both [positive conclusions] like fingerprinting/enumeration and [negative conclusions] like "port closed" / "parameter not injectable" / "no login entry found". Negative results belong here, never in the asset graph.

Consolidate multiple observations from one exploration into ONE fact, not many: `summary` = a one-sentence summary of the conclusion, `detail` = the related details (may contain several concrete items). One intent usually produces exactly one fact; splitting too finely bloats the graph.

The `facts` array writes several mutually distinct conclusions at once (each may omit `intent_id`, defaulting to the top-level `intent_id`). Returns an `ids` array, same length and order as `facts`.

Write only conclusions you [actually saw] in tool output — do not extrapolate. `evidence` and `confidence` keep inaccurate conclusions from polluting the graph:
- `evidence` = one line of key evidence (the command + the one or two most proving output lines); keep it brief, details belong in `detail`.
- `confidence` = `observed` (seen directly) or `inferred` (inferred from phenomena).
- `source` = where the content came from: `target_response` | `tool_output` | `third_party_intel` | `operator_input` | `inference` (omit for inference). Only an `observed` fact whose source is not `target_response` can later prove a goal.
