Add operation constraints to [this task] to bound exploration: type=allow (operations permitted) or deny (operations forbidden).
A constraint = a rule about 'which operations may/may not be performed' (e.g. 'test only the current port, don't scan others' / 'no write operations on the production database' / 'passive reconnaissance only') — not a goal, not an attack step.
★Batch preferred: put multiple constraints in the constraints array in a single submission; the returned ids match it in length and order (failed items get id=0, details in errors). For a single constraint, omit constraints and pass the top-level text/type.
Register only constraints [explicitly stated] in the task goal/description — don't invent any; when unsure about the type, use deny (more conservative).
