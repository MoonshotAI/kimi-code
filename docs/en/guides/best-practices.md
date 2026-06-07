# Kimi Code Best Practices

> Tips for everything from daily coding to large-scale automation — get the most out of Kimi Code.

Kimi Code is an autonomous coding environment. Unlike a question-and-answer AI, it reads files, runs commands, modifies code, and drives tasks forward on its own. Understanding the patterns that come with this autonomy is the key to using it well.

## 1. What you don't say, Kimi decides

> 💡 Any space in your prompt without a constraint is Kimi's decision space. It will fill it — with what it thinks is "better."

This is the most common and least visible trap when using Kimi Code.

Tell Kimi "fix this code" on a function with an SQL injection bug, and it won't just fix the SQL injection. It will also add type annotations, docstrings, refactor the discount logic, change the order ID format — turning 23 lines into 43. Every change may be reasonable, but:

- You're doing a hotfix; now your PR has a pile of unrelated changes
- Changing the order ID format may break downstream systems
- Type annotations will error on older Python versions

The problem isn't that Kimi did something wrong — it's that you didn't tell it what not to touch.

**Add constraints, not just goals**

Same scenario, with constraints:

```
get_user_orders has an SQL injection risk. Fix it with a parameterized query.
Only change this one function. No type annotations. No docstrings. Don't touch any other logic.
```

Result: one line changed — just the SQL statement. Everything else untouched.

| | Prompt | Actual changes |
|---|---|---|
| ❌ | "Fix this code" | SQL injection + type annotations + docstrings + discount refactor + order ID format + error handling |
| ✅ | "Fix SQL injection in get_user_orders, don't touch anything else" | 1 line changed |

**When to leave room, when to constrain**

- **Exploration / tech debt / unfamiliar codebase**: vague prompts are fine — let Kimi find the problems
- **Hotfixes / targeted PR changes / production code**: must use constraints to prevent scope creep
- **Migrations / formatting / bulk changes**: vague is okay but specify scope ("only process files under src/, leave tests/ alone")

**A practical prompt structure**

> **[Target file/function]** + **[what to do]** + **[what not to touch]** + **[acceptance criteria]**

```
# Example
The refresh_token function in @src/auth/session.py doesn't raise an exception when the token expires.
Add that error handling. Only change this one function — don't touch callers or test files.
Run pytest tests/test_auth.py when done to confirm it passes.
```

## 2. Get a plan you can veto before any code lands

> 💡 Kimi reads the code before acting, but you only see the architectural choices it made after the code is written. Plan mode inserts an approval window in between — review the plan first, then execute.

Tell an orders system to "add a refund feature" and Kimi will read `main.py`, see SQLite, and then — still introduce an in-memory dictionary (`_orders_db = {}`) to store refund data, complete with a comment saying "should use a database in production."

It knew this wasn't ideal but did it anyway: because no one said no.

By the time you see the code, it's already written. With Plan mode, Kimi first presents its plan — "I'll use an in-memory dict for refund records" — and you can immediately say "no, use SQLite, the schema goes in the orders table" before a single line is written.

**Plan mode: review the plan, then execute**

In Plan mode, Kimi reads but does not write. It presents its understanding and proposed approach for your approval before making any changes.

How to enter:
- At startup: `kimi --plan`
- Mid-session: `Shift-Tab` or `/plan`

The prompt changes to `📋` and the status bar shows a blue `plan` indicator. For the full Plan mode interaction behavior (including approval flow and its relationship with YOLO mode), see [Interaction → Plan mode](../guides/interaction.md#plan-mode).

**Recommended workflow**

```
[Plan mode] Read the code under @src/orders/ and understand
how the data layer is designed and what storage it uses.
```

After Kimi explores:

```
[Plan mode] I want to add a refund feature that supports full and partial refunds.
Based on what you just saw, give me an implementation plan.
```

Review the plan, confirm it chose SQLite instead of an in-memory dict, approve, then exit Plan mode to execute.

**When Plan is worth it, when it isn't**

- New feature integrating into an existing system → explore first
- Changes spanning multiple files or modules → Plan first
- Renaming a variable or adding a log line → just do it, no Plan needed

Planning is cheap insurance against going in the wrong direction, but it has overhead. If you can describe the change in one sentence, you probably don't need a plan.

**Checkpoint before you start**

```bash
git commit -m "checkpoint: before refund feature"
```

If something goes wrong, one command gets you back to the starting point.

## 3. Memory needs to be designed

> 💡 Every new session, Kimi starts blank. It doesn't remember what you said last time or know your project's conventions. Lock that knowledge into files so Kimi understands your project better over time.

### Use `/init` to generate AGENTS.md

Run `/init` and Kimi will analyze your project structure, build system, and test framework to generate `AGENTS.md` as a starting point. It's automatically read at the start of every session. (See [Slash commands → Account & Configuration](../reference/slash-commands.md#account--configuration) for details.)

Format is flexible, but keep it short. For example:

```markdown
# Build & test
- Run tests with pytest: `pytest tests/ -v`
- Type checking: `mypy src/`
- Data layer uses SQLite only, no ORM

# Code conventions
- No f-string SQL queries (must use parameterized queries)
- No type annotations (project is still on Python 3.8)
- Errors: raise ValueError, no custom exception classes
```

**What's worth writing, what isn't**

| ✅ Write this | ❌ Skip this |
|---|---|
| Build and test commands | Things obvious from reading the code |
| Tech stack constraints (what not to use) | Standard Python/JS conventions |
| Code style that differs from defaults | Obvious rules ("write clean code") |
| Non-intuitive behavior and known pitfalls | File-by-file descriptions of the codebase |

For every line, ask yourself: *"Would Kimi make a mistake without this?"* If not, delete it. A file that's too long buries the important rules.

**Negative rules are more stable than positive ones**

```markdown
# Unstable (Kimi may "forget")
- Use SQLite for database operations

# Stable (harder for Kimi to work around)
- Don't use SQLAlchemy or any ORM — only the native sqlite3 module
```

Negative constraints rule out specific behaviors and are harder to ignore than positive rules.

### Use Skills to lock in specialized knowledge

Skills are knowledge files stored under `.claude/skills/`, loaded on demand, and never consuming context in unrelated sessions.

```markdown
# .claude/skills/db-conventions/SKILL.md
---
name: db-conventions
description: Project database operation conventions
---
# Database conventions
- Only use the native sqlite3 module — no ORMs
- All SQL statements must use parameterized queries (cursor.execute("...", (param,)))
- Use try/finally to ensure connections are closed
- No connection pooling — each function opens and closes its own connection
```

To invoke: `/skill:db-conventions implement a refund record query`

For the complete Skill file format, frontmatter fields, and multi-directory management, see [Agent Skills](../customization/skills.md).

### Use `@` references instead of pasting

```
Take a look at the refresh_token function in @src/auth/session.py
```

Kimi reads the file when needed; only the reference path goes in the context, not the file contents. For large files, this difference can be thousands of tokens. See [File references](../guides/interaction.md#file-references) for supported reference types (folders, glob patterns, URLs, etc.).

### Use images to add context

Beyond file references, you can also **paste screenshots, design mockups, or error screens directly into the input box** — Kimi can understand image content and respond accordingly. For example, paste a UI screenshot with "this layout doesn't match the design" or paste a terminal error screenshot. See [Pasting images and video](../guides/interaction.md#pasting-images-and-video) for full details.

## 4. Your toolchain is your leverage

> 💡 Out of the box is just the starting point. Hooks turn "suggestions" into guarantees; MCP connects external systems; custom Agents run dirty work in isolated contexts.

### Hooks: don't rely on Kimi remembering

Hooks automatically trigger scripts at specific points in Kimi's workflow. Unlike text instructions in AGENTS.md, Hooks execute deterministically — regardless of whether Kimi "remembers," the action always happens.

Best use cases for Hooks:

- Auto-run a linter after every file edit ("run eslint after every code change" written in AGENTS.md might be forgotten; a Hook won't be)
- Block writes to certain directories (migrations/, secrets/, etc.)
- Auto-run type checking before commits

Ask Kimi to write one: *"Write a Hook that runs eslint --fix after every file edit"* — it will generate the config and write it to `.claude/settings.json`. Use `/hooks` to see what's currently configured. For the complete event types, config structure, and return value semantics, see [Hooks](../customization/hooks.md).

### MCP: let Kimi use your tools directly

MCP lets Kimi interact with external services — query databases, read Notion docs, check Sentry errors, pull Figma designs. See [MCP](../customization/mcp.md) for setup.

Once configured, you can just say:

- "Check Sentry for errors in the last 24 hours and find the most frequent one"
- "Read the requirements for Linear issue ENG-1234 and start implementing"
- "Query the database for last week's user retention rate"

### Custom Agents: isolate specialized tasks

Define Agent files under `.claude/agents/` and Kimi can delegate specific tasks to these specialized assistants. Each Agent runs in an independent context and doesn't consume tokens from your main session.

```markdown
# .claude/agents/security-reviewer.md
---
name: security-reviewer
description: Review code for security vulnerabilities
tools: Read, Grep, Glob, Bash
---
You are a senior security engineer. Focus on:
- Injection vulnerabilities: SQL injection, XSS, command injection
- Authentication and authorization flaws
- Secrets or hardcoded credentials in code
- Insecure data handling and serialization

Provide specific file and line number references with suggested fixes.
```

Usage: *"Use a subagent to do a security review of @src/orders/"*

For the complete Agent definition format, context isolation mechanism, and permission inheritance rules, see [Agents and sub-agents](../customization/agents.md).

## 5. How to save tokens

> 💡 Kimi's context window is your most valuable resource. As a session grows, performance degrades — Kimi may start forgetting earlier instructions or repeating the same mistakes. Manage it before you run out.

The status bar at the bottom shows real-time context usage (e.g. `context: 42% (4.2k/10.0k)`) — your most important monitoring metric. For when to trigger context compression and how, see [Sessions & context → Context compression](../guides/sessions.md#context-compression).

### Actively manage context

**`/clear`**: Fully reset context. Use when switching tasks. A context full of "fix login bug" records will noticeably degrade quality when you ask an architecture question.

**`/compact`**: Compress history, preserve key decisions, free up space. You can specify what to keep:

```
/compact Focus on preserving our API design decisions and the list of modified files
```

**`/btw`**: Side-question mode. The answer appears in a floating panel and doesn't enter the main conversation history. Good for quick questions you don't want consuming context:

```
/btw What's the return type of this function?
```

For the full parameter reference for `/clear`, `/compact`, and `/btw`, see [Slash commands → Session management](../reference/slash-commands.md#session-management).

### When to start a new session

Not every situation calls for a reset — sometimes keeping context is the right call:

- Task completely switched? `/clear`
- Corrected the same thing twice and still not right, going in circles? `/clear`, then write a more precise prompt
- Still digging into the same problem? Keep the context

If you've corrected Kimi more than twice and it still can't get it right, stop correcting — a context full of failed attempts will contaminate future judgment. Use `/clear` to start over and write what you learned into the new prompt.

### Reduce token usage at the source

Cleaning up context is reactive. Better to burn fewer tokens from the start:

**`@` references instead of pasting**

Pasting file contents stuffs the entire file into context; `@src/auth/session.py` is just a one-line path that Kimi reads when needed. For large files, the difference can be thousands of tokens.

**Store expertise in Skills, don't repeat it every time**

Conventions like "we use SQLite, no ORM, all SQL must be parameterized" cost tokens on every turn if you write them in every prompt. Put them in a Skill file, load on demand, and they consume zero context in unrelated sessions.

**Resume sessions instead of creating new ones frequently**

Every new session starts from scratch, reloading system prompts and tool definitions. Resuming an existing session reuses the cache — hit rates are noticeably higher than repeatedly starting fresh.

## 6. Use failing tests to define "done"

> 💡 Kimi saying "done" doesn't mean it's actually done. Write verification conditions into the prompt — don't do it manually after the fact. The most reliable verification is something it can't change itself: test files.

When Kimi can verify the result itself — running tests, comparing screenshots, checking command output — its performance is significantly better than "you look it over."

**Write acceptance criteria into the prompt**

| | Example |
|---|---|
| ❌ | "Implement a shopping cart module" |
| ✅ | "Implement a shopping cart module. Run pytest tests/test_cart.py when done — all tests must pass." |
| ❌ | "Make this endpoint faster" |
| ✅ | "This endpoint's p99 is 800ms. Target is under 200ms. When done, run locust -f load_test.py --headless -u 100 and share the results." |

**Tests first: specs Kimi can't change**

Write failing tests first, then have Kimi implement:

```python
# Write the tests first (these should currently fail)
def test_empty_cart_raises():
    with pytest.raises(ValueError, match="empty"):
        checkout({"user_id": 1, "items": []})

def test_gold_user_discount():
    assert calculate_discount(100, "gold") == 85.0
```

Then:

```
There are 2 failing tests in tests/test_orders.py.
Only modify main.py to make them pass.
Do not modify test_orders.py. Do not delete or skip any tests.
Run pytest tests/test_orders.py -v when done to confirm they all pass.
```

The test file is a spec Kimi can't modify. It can only change the implementation to satisfy the tests — it can't cheat by changing the tests. Result: Kimi adds exactly two lines of code — just enough to satisfy both tests, nothing else touched.

**Have Kimi run verification itself**

```
After implementing, run pytest and mypy src/.
If anything fails, fix it and re-run until everything passes.
```

Embed verification in the task definition, not as a follow-up question.

## 7. Conversations as assets

> 💡 Every conversation is a potential project asset. Solidify what you learned so Kimi understands your project better with each session.

### Extract learnings immediately into Skills or AGENTS.md

Found a pitfall Kimi keeps hitting, or confirmed an effective constraint? Tell it right away:

```
Add this rule to AGENTS.md: all SQL queries must use parameterized queries.
No f-string concatenation. Reject any code that violates this.
```

This is a self-improvement loop — every conversation deepens Kimi's understanding of your project.

### Find previous conversations

Kimi Code automatically saves all sessions — no manual backup needed:

- **Resume the most recent session**: `kimi --continue` (or `-C`) — pick up right where you left off
- **Choose from a list**: `kimi --session` (or `-S`) — opens an interactive selector
- **Restore a specific session**: `kimi -r <session-id>` — the command is printed when a session exits, just copy it
- **Switch mid-session**: type `/sessions` to switch without quitting; press `Ctrl-A` to toggle between "current directory" and "all directories" for cross-project browsing

Multi-day tasks don't need context re-explained — resume the session and approval decisions, Plan mode state, and sub-Agent instances are all automatically restored. For full details on session storage paths, in-TUI switching, and session recovery, see [Sessions & context](../guides/sessions.md).

### Name sessions so you can find them

Use `/title` to give the current session a meaningful name (like `refund-feature` or `auth-migration`). Next time you open `/sessions` you'll spot it immediately instead of scrolling through a list of dates.

### Save and reuse valuable sessions

Use `/export` to export a conversation. Sessions with key decisions, architecture discussions, or complex debug processes are worth archiving. You can also use `/import <file>` to import one into a new session as background context.

### `/undo`: don't be afraid to take a wrong turn

`/undo` opens a history selector, rolls back to any previous turn, forks a new branch from there, and leaves the original session untouched. No need to plan every step in advance — if the direction feels wrong, roll back and try another path.

::: info
`/undo` is a recently added command not yet covered in the [slash commands reference](../reference/slash-commands.md). If you don't see it in the menu, run `kimi upgrade` to get the latest version.
:::

## 8. Scale output without babysitting

> 💡 One person can produce team-scale output. Design tasks as batch processes that run in the background, start them, and go do something else.

### Print mode: embed in scripts and CI

`kimi --print` runs non-interactively and exits when done, ideal for scripting. `--quiet` is a shortcut for `--print --output-format text --final-message-only` — only the final result is output. (These flags are new CLI features not yet in the [command reference](../reference/kimi-command.md) — documentation is coming.)

```bash
# Single run
kimi --print -p "Check src/ for SQL injection risks and list any affected files"

# Final result only (skip intermediate output)
kimi --quiet -p "Write a commit message for the current git diff"

# Streaming JSON output for programmatic parsing
kimi --print -p "Analyze this module's interface design" --output-format stream-json
```

### Batch process multiple files

For large-scale migrations or bulk changes:

```bash
# Batch migrate Python files (--yolo auto-approves all operations)
for file in $(cat files.txt); do
  kimi --print --yolo -p "Replace all f-string SQL queries in $file with parameterized queries and commit"
done
```

Test your prompt on 2–3 files first to confirm it works, then run the full batch.

### Background parallel tasks

For long-running analysis tasks, let Kimi run in the background:

```
Use a background subagent to scan all files under src/ for SQL queries,
list every location using f-string concatenation with the file name and line number
```

Use `/tasks` to check background task status — a three-pane TUI with task list, details, and output preview.

### Exit codes: let scripts make decisions

Print mode uses structured exit codes to report results:

| Exit code | Meaning |
|---|---|
| `0` | Success |
| `1` | Permanent failure (auth error, config error, quota exhausted) |
| `75` | Transient failure, retry (rate limit, server error, connection timeout) |

```bash
#!/bin/bash
for file in $(cat files.txt); do
  kimi --print --yolo -p "Migrate $file"
  code=$?
  if [ $code -eq 75 ]; then
    echo "$file: rate limited, adding to retry queue"
    echo $file >> retry.txt
  elif [ $code -eq 1 ]; then
    echo "$file: permanent failure, needs manual review"
  fi
done
```

## Common failure modes

- **Catch-all sessions**: one session with multiple unrelated tasks — context fills with noise.
  > **Fix**: use `/clear` when switching tasks.

- **Repeated corrections that don't converge**: the same problem corrected two or three times and still not right, getting worse.
  > **Fix**: stop after two corrections, `/clear` and start over, write what you learned into the new prompt.

- **AGENTS.md keeps growing**: past a certain length, important rules start getting ignored.
  > **Fix**: cut ruthlessly. If Kimi would get it right without a line, delete it; for rules that must be enforced, use a Hook instead.

- **Trust without verification**: Kimi delivers what looks like a complete implementation but edge cases aren't covered.
  > **Fix**: always specify verification in the prompt — if it can't be verified, it's not done.

- **Unbounded exploration**: ask Kimi to "research" something and it reads hundreds of files until context explodes.
  > **Fix**: constrain the research scope ("only look at files under src/auth/"), or use a subagent to explore — it runs in an isolated context and doesn't affect the main session.

## Next steps

- [Common use cases](../guides/use-cases.md) — full workflows for specific scenarios (feature development, bug fixes, batch tasks)
- [Interaction & input](../guides/interaction.md) — Plan mode, file references, and approval flow explained in full
- [Sessions & context](../guides/sessions.md) — session storage, recovery, and compression mechanics
- [Hooks](../customization/hooks.md) — enforce rules with scripts instead of relying on Kimi to remember
- [MCP](../customization/mcp.md) — connect Kimi directly to external systems (databases, Linear, Sentry, etc.)
- [Agent Skills](../customization/skills.md) — package specialized knowledge into on-demand Skill files
