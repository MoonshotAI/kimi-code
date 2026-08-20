Cancel an active monitor before it fires.

Cancelling stops the monitor's watcher and timeout; for `command` monitors it also terminates the monitored command. Cancelling an already finished monitor is a no-op that returns its current state. An unknown `monitor_id` is an error.
