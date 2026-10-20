
Monitors (tasks started with the Monitor tool) are the exception to the rules above. A WaitFor without `task_id` does not cover them: their events do not end it, it does not wait for them to stop, and when only monitors are running it returns immediately. With a monitor's `task_id`, the wait ends as soon as that monitor's next event is ready.
