# Common use cases

Below are typical scenarios and prompt samples for Kimi Code CLI.

## Understanding an unfamiliar project

Use `kimi --plan` or press `Shift-Tab` to enter Plan mode for large-scale research. Ask it to produce a plan first and approve before execution:

```
Walk me through the overall architecture of this repository. Focus on:
1. Where the entry point is and what happens at startup
2. The dependency relationships between major modules
3. How configuration and data are loaded
At the end, draw a simple module relationship diagram.
```

For focused questions, ask directly:

```
How does the event loop under src/runtime work? Where do events originate, and who consumes them?
```

```
How is "permission approval" implemented in this project? Which files are involved, and what are the key types?
```

For large investigations, the main agent can spawn **subagents** to handle subtasks in parallel. See [Agents](../customization/agents.md).

## Implementing a new feature

State the requirement and acceptance criteria clearly. Use Plan mode for complex or risky changes.

```
Add a retry utility under src/utils:
- Function signature retry<T>(fn: () => Promise<T>, options): Promise<T>
- Supports three options: maxAttempts, initialDelayMs, backoffFactor
- Throws the last error on failure
- Add a set of unit tests covering success, success after retry, and full failure
```

Tell it how to change the result — no need to edit by hand:

```
The backoff uses a fixed value. I want some jitter added to avoid thundering herd. Update the code and the tests.
```

## Fixing bugs

State the symptom, reproduction conditions, and expected behavior:

```
Running npm test occasionally throws this error:

  TypeError: Cannot read properties of undefined (reading 'id')
      at SessionStore.update (src/session/store.ts:142:18)

It only appears in cases that trigger multiple updates concurrently. Locate the cause, fix it, and run the full test suite once at the end to confirm.
```

Not sure where the cause is? Have it investigate first:

```
User report: after a successful login, the first page refresh sends them back to the login page; refreshing again works fine. Investigate the possible causes first, list the most suspicious spots, and wait for me to confirm a direction before making any changes.
```

For mechanical tasks, just hand it off:

```
Run the tests, fix any failing cases, and run them again to confirm everything is green.
```

## Writing tests and refactoring

Tasks with clear boundaries and acceptance criteria are a great fit:

```
src/parser/markdown.ts currently has almost no tests. Add a set of unit tests covering plain paragraphs, nested lists, code blocks, tables, blockquotes, and mixed scenarios. Follow the existing test style in this project.
```

```
Extract the repeated "read body → validate → write log → return" logic under src/handlers into a middleware. Run the tests after the changes and make sure existing behavior is unchanged.
```

For multi-file refactors, use Plan mode to confirm the plan first. Use `/fork` to explore alternative approaches.

## One-off scripts and automation tasks

Bulk edits, statistics, and research can be done with a single prompt:

```
Change all var declarations in .js files under src/ to const or let, preferring const when possible. Run lint after the changes to confirm.
```

```
Analyze the access logs under logs/ for the past 7 days. Group by endpoint path and report the number of calls plus p50 and p99 response times. Output the result as a markdown table.
```

```
Research the mainstream dependency injection options in TypeScript (tsyringe, inversify, awilix). Compare them along three dimensions: API style, decorator dependencies, and runtime overhead. Give me a recommendation within one page.
```

Use `--yolo` or `/yolo` to skip approvals, or set an allow list under [permission configuration](../configuration/config-files.md#permission) for a safer middle ground.

## Scheduled tasks and reminders

Within an interactive session you can ask the assistant to set a one-shot reminder, run a task on a recurring schedule, or come back to you after a fixed delay. The agent maps the request to a 5-field cron expression in your local timezone and re-injects the prompt into the same session when it fires.

```
Remind me at 2:30pm today to check the deploy.
```

```
Every weekday at 9am, summarize the latest CI failures and post the result to me.
```

```
Hourly, poll the production health endpoint and let me know if anything looks off.
```

```
In about 10 minutes, come back and verify the build finished.
```

Schedules live inside the session: closing the terminal is fine, and `kimi resume`-ing the same session reloads them and resumes the schedule. They do not carry over into a brand-new session. Recurring tasks auto-expire after seven days — the agent gets a `stale` notice on the final fire and will either let the task end or refresh it depending on your earlier instructions. Use `--yolo` if you want the agent to schedule tasks without approval prompts; otherwise each `CronCreate` asks for confirmation against the exact schedule and prompt.

To see what is currently scheduled, just ask: `What scheduled tasks are pending?` (the agent runs the read-only `CronList` tool). To cancel one, ask the agent to drop it or quote its 8-character id. The full tool surface is documented under [Scheduled tasks](../reference/tools.md#scheduled-tasks), and the kill switch is `KIMI_DISABLE_CRON=1`.

## Generating and maintaining documentation

```
I just changed the interface signature of src/auth/login.ts. Update the corresponding JSDoc, the example code in the README, and any paragraph that mentions this interface under docs/en/guides.
```

```
For every public function under src/api that does not have a docstring, add one. Match the style of the existing comments.
```

```
Based on the command implementations under src/cli, generate a draft command reference listing each subcommand, its arguments, and default values. Put it under docs/en/reference for me to review later.
```

Archive or share a session with `kimi export <sessionId>`.
