# Goals

Goals keep Kimi Code working toward a defined outcome across turns. Use `/goal` when the task has a clear finish line, but the next useful step depends on what the agent learns while it works.

A normal prompt says what to do next. A goal says what must become true. Kimi Code keeps that objective visible, checks progress against evidence, and continues while the goal is active.

::: info
`/goal` is still experimental. Start `kimi` with:

```sh
KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1 kimi
```
:::

## Start a goal

Write the objective after `/goal`:

```sh
/goal Fix bugs listed in the issue tracker.
```

Kimi Code saves the objective, sends it as the next user message, and starts goal mode. After each turn, it checks whether the goal is complete, blocked, paused, or still active.

Goals work best when the objective names the finish line and the evidence that proves it:

```sh
/goal Fix every bug labeled checkout-regression, add or update tests for each fix, and run the checkout test suite
```

Avoid goals that only name a broad direction:

```sh
/goal Find all bugs in this codebase.
```

That goal does not say what counts as success, what to inspect, or when to stop. The agent may block immediately, or keep working far longer than you expected.

### When to use goals

1. Use goals for work with a clear finish line and verifiable evidence.

    ```sh
    /goal Fix every failing checkout test and run the checkout test suite successfully.
    ```

    Kimi Code can inspect test output, change files, rerun checks, and decide when the goal is complete.

2. Use goals when the task may need several turns of investigation and repair.

    ```sh
    /goal Find why the release build fails, fix the root cause, and verify the build passes.
    ```

    The goal describes the result, so the agent can adapt when the first clue is not the root cause.

3. Use goals for ordered work that should continue without another prompt.

    ```sh
    /goal Update the feature implementation, add docs, run tests, and summarize the changed files.
    ```

    This is useful when you already know the checks or artifacts that must exist before the work is done.

### When not to use goals

1. Do not use goals for broad topics or open-ended discussions.

    ::: warning Counterexample
    ```sh
    /goal Greetings!
    ```
    :::

    Agents will mark the goal as complete immediately for non-goals.

2. Do not use goals for tasks that are known to be impossible or unresolvable.

    ::: warning Counterexample
    ```sh
    /goal Prove 1 + 1 = 3.
    ```
    :::

    Agents will mark the goal as blocked if the goal seems impossible or unresolvable.

3. Do not use goals with ambiguous or complicated objectives.

    ::: warning Counterexample
    ```sh
    /goal Create a videogame in a single HTML file.
    ```
    :::

    Agents may complete goals, but also may produce unexpected or surprising outcomes after a long time.

## Manage the lifecycle

Use the same command surface to inspect or control the current goal:

| Command | Action |
| --- | --- |
| `/goal` or `/goal status` | Show the current goal and its progress |
| `/goal pause` | Pause the active goal without deleting it |
| `/goal resume` | Resume a paused or blocked goal |
| `/goal cancel` | Remove the current goal |
| `/goal replace <objective>` | Replace the current goal with a new objective |

A goal can stop in three ways:

- `complete`: the objective is done, and Kimi Code clears the goal
- `paused`: you paused it, interrupted the turn, or resumed a session that had an active goal
- `blocked`: Kimi Code needs input, cannot complete the goal as stated, reached a budget limit, or hit a runtime failure

Write stop conditions into the objective. `/goal` does not have a separate stop-limit flag.

## Queue upcoming goals

Agents sometimes complete a goal too quickly. Users can be disappointed that they can assign only one goal at a time. Many people already know the upcoming goals they want to pursue. They had to wait for the current goal to complete, opens the TUI, and submit the next goal manually.

Use `/goal next` when you have more work ready but do not want to interrupt the current goal:

```sh
/goal next Update the release notes after the tests pass
```

Upcoming goals are not visible to the agent while the current goal is running. When the current goal completes, Kimi Code starts the first upcoming goal in the same way as users enter `/goal <objective>`.

Manage upcoming goals interactively:

```sh
/goal next manage
```

In the manager, use <kbd>↑</kbd> / <kbd>↓</kbd> to browse, <kbd>Space</kbd> to select a goal for moving, <kbd>↑</kbd> / <kbd>↓</kbd> to reorder it, <kbd>E</kbd> to edit, <kbd>D</kbd> to delete, and <kbd>Esc</kbd> to cancel.

The feature helps you run sequential goals in a manageable way. If the current goal is paused, canceled, or blocked, Kimi Code does not start the next upcoming goal. When a goal blocks and upcoming goals exist, the TUI reminds you that they wait for completion.

## Use goal mode carefully

Goal mode is useful for work that can be checked with files, tests, command output, generated artifacts, or a clear written report. It is less useful for a one-off edit or a question that only needs one answer.

In `manual` permission mode, goal work may pause for tool call approval. For unattended work, use a permission mode that matches the risk of the repository and the commands the agent may run.

In non-interactive prompt mode, only goal creation is supported:

```sh
KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1 kimi -p "/goal Fix the failing checkout test"
```

Prompt mode exits with code `0` when the goal completes, `3` when it blocks, and `6` when it pauses. `/goal next` and other management commands are TUI controls.
