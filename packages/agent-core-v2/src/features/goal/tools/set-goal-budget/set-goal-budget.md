Set a hard budget limit for the current goal.

Use this only when the user clearly gives a runtime limit, such as:

- "stop after 20 turns"
- "use no more than 500k tokens"
- "finish within 30 minutes"

Do not invent limits. Do not call this for vague wording such as "spend some time" or
"try to be quick".

If the user gives a compound time, convert it to one supported unit before calling this tool.
For example, "2 hours and 3 minutes" can be set as `value: 123, unit: "minutes"`.

A time budget must be at least 1 second and convert to a finite number of milliseconds.
There is no upper duration limit. Turn and token budgets must be positive and are rounded
to the nearest whole number (minimum 1).

Supported units:

- `turns`
- `tokens`
- `milliseconds`
- `seconds`
- `minutes`
- `hours`
