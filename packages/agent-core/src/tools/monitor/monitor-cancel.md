Cancel an active monitor by id (from MonitorCreate / MonitorList).

Cancelling closes the watcher immediately: file watchers are shut down, a command monitor's process is stopped, and its timeout is cleared. No notification is sent for a cancelled monitor.

Cancelling a monitor that already fired, ended, or was cancelled is an error — use MonitorList to check status first.
