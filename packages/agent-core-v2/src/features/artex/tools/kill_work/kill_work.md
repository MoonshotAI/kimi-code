Stop a running or queued intent (work): marks it stopped so no worker will execute or continue it. Use it to cancel a dead-end direction or an intent made obsolete by new findings.

- `intent_id`: the intent to stop.
- `reason` (optional): why the work is being stopped (recorded on the intent).

A stopped intent is terminal and is not redispatched. To pursue the direction differently, add a new intent.
