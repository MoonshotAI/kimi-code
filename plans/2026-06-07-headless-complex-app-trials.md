# Headless Complex App Trials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use `kimi headless` to build eight substantial, usable applications and reveal headless-mode bugs through long, supervised multi-turn development.

**Architecture:** Treat headless mode as the worker interface, not the product being built. A human operator drives each project with short prompts, inspects artifacts after every turn, uses Playwright for browser checks, records failures, and sends terse correction prompts. Each app lives in its own directory under `/tmp/kimi-headless-examples/`.

**Tech Stack:** `kimi headless`, TypeScript, Vite, React, SQLite where useful, local file persistence, Playwright CLI for browser inspection, Vitest or app-appropriate tests.

---

## Reader Outcome

After this plan, you can run a serious headless-mode trial across eight real applications.

Each project shall receive 50 to 100 completed headless turns.

Each project shall become usable by a real person, not just a mocked demo.

Each project shall have browser inspection, tests, screenshots, status files, run logs, and a written report.

Execution shall not start until the user approves this plan.

## Trial Definition

This plan tests whether `kimi headless` can drive realistic software development.

The trial does not build applications about headless mode.

The applications are test payloads. They should be hard enough to expose headless bugs, agent drift, missing status updates, weak recovery behavior, and poor operator ergonomics.

## Global Trial Contract

Each app shall use this budget:

- Minimum completed turns: `50`
- Target completed turns: `60`
- Maximum completed turns: `100`

Use more than 60 turns when:

- Playwright inspection finds broken interaction.
- Tests fail after a claimed fix.
- The UI works but feels unfinished.
- Data persistence is incomplete.
- Import, export, search, or settings flows are missing.
- The app cannot be used without reading source code.

Stop before 100 turns only when all app-specific acceptance gates pass.

If an invocation is cancelled, interrupted, failed, or stuck, do not count it as a completed turn.

Record it in the project report and continue with a new completed turn.

## Headless Bug Triage And Restart Contract

If the operator finds a headless-mode bug during the experiment, pause the current app trial long enough to classify the bug.

Record:

- exact `kimi headless` command
- app directory
- run directory
- turn number
- `status.json`
- `stdout.json`
- `stderr.txt`
- output files
- screenshots if browser state matters
- expected behavior
- actual behavior
- whether the current app folder is still resumable

Severity rules:

- **Blocking:** the current session, status, lock, output, or app folder cannot be trusted.
- **High:** the trial can continue, but status, output, lock, signal handling, or resume behavior is wrong.
- **Medium:** the trial can continue, but metadata, help, or reports are confusing.
- **Low:** docs or cosmetic issue.

Fix headless mode before continuing when the bug affects:

- session continuation
- status file truth
- output file integrity
- run locks
- signal handling
- prompt or goal control
- metadata needed by the operator

If the current app project is not safely resumable, do not keep trying to repair that folder.

Use this restart protocol:

1. Mark the current folder as abandoned in its `trial-report.md`.
2. Add an entry to `shared/failure-ledger.md`.
3. Preserve the broken folder as evidence.
4. Fix the headless-mode bug if needed.
5. Start the same app idea in a new sibling folder.
6. Start a new Git repo in the new folder.
7. Start a new headless session in the new folder.
8. Continue completed-turn counting from the new folder only.
9. Link the abandoned folder from the new folder's `prompt-log.md` and `trial-report.md`.

Restart folder names shall use this pattern:

```text
apps/workflow-automation-builder/
apps/workflow-automation-builder-restart-01/
apps/workflow-automation-builder-restart-02/
```

The abandoned folder shall keep:

- `prompt-log.md`
- `trial-report.md`
- app-local Git history

The root trial folder shall keep the abandoned folder's run evidence under `runs/<abandoned-folder-name>/`.

The aggregate report shall count abandoned folders separately from successful final folders.

## Lazy Human Operator Contract

The operator shall write prompts like a busy user, not like a detailed spec author.

Prompt style:

```text
make the import flow real. csv in, errors visible, sample file too.
```

```text
ui is confusing. inspect it in browser and make the main path obvious.
```

```text
tests are failing. fix the cause, don't delete coverage.
```

```text
ship the saved views feature. make it usable.
```

The operator shall still supervise:

- read status files while turns run
- inspect generated files
- run tests
- open the app in a browser
- use Playwright snapshots and screenshots
- reject shallow work
- send concise correction prompts

## Per-Turn Prompt Log Contract

Each app shall have a Markdown prompt log:

```text
app-name/
  prompt-log.md
```

The operator shall update `prompt-log.md` before or immediately after every headless invocation.

Each completed, failed, cancelled, or stuck invocation shall have one entry.

Use this format:

````markdown
## Turn 017

**Prompt used:**

```text
the board reload is broken. fix persistence and commit.
```

**Why this prompt now:** Playwright reload check showed the shape layer disappeared after refresh, so the next turn should focus only on persistence.

**Expected artifact change:** Board state should persist across reload and tests should cover saved shape layers.

**Result:** Completed. Commit `abc1234` added persistence tests and fixed layer serialization.
````

The prompt log shall explain why the operator chose that prompt at that moment.

The explanation should reference concrete evidence:

- status file state
- failing test output
- Playwright snapshot or screenshot
- broken browser workflow
- missing acceptance gate
- shallow implementation from the prior turn

Do not write generic reasons such as "continue development".

## App-Local Commit Contract

Each app shall be its own Git repository.

The headless worker shall make small, frequent commits inside the app directory.

Commit expectations:

- Initialize Git in the app during the first turn or first setup turn.
- Commit after each self-contained feature, bug fix, test pass, or UI polish slice.
- Prefer one commit every 1 to 3 completed turns.
- Use conventional commit-style messages where practical.
- Do not make one large final commit.
- Do not commit `runs/`, screenshots, status files, or temporary logs unless the project report explicitly needs them.
- Do not add co-author trailers.

The operator should often include commit pressure in prompts:

```text
make saved views work. add tests. commit the focused change.
```

```text
ui is messy. polish the card editor only and commit.
```

The operator shall verify commit history during supervision:

```sh
git -C "$APP_DIR" log --oneline --decorate -12
git -C "$APP_DIR" status --short
```

Expected:

- meaningful recent commits exist
- no accidental `runs/` files are staged
- no unrelated generated files are committed

## Global Directory Layout

Create this layout under `/tmp/kimi-headless-examples/`:

```text
headless-trials-2026-06/
  README.md
  tracker.md
  operator-log.md
  runs/
    collaborative-whiteboard/
      turn-001/
        status.json
        stdout.json
        stderr.txt
        output/
        playwright/
          snapshot.md
          screenshot.png
  shared/
    prompt-bank.md
    playwright-notes.md
    failure-ledger.md
  apps/
    collaborative-whiteboard/
    kanban-planning-system/
    log-analytics-workbench/
    sql-explorer/
    workflow-automation-builder/
    workflow-automation-builder-restart-01/
    issue-tracker-triage/
    music-library-manager/
    personal-crm/
```

Each app shall contain:

```text
app-name/
  operator-log.md
  prompt-log.md
  trial-report.md
  README.md
  package.json
  src/
  tests/
```

Do not place run artifacts under the app directory.

Use root-level run folders instead:

```text
headless-trials-2026-06/
  runs/
    app-name/
      turn-001/
        status.json
        stdout.json
        stderr.txt
        output/
        playwright/
```

The worker can delete files under its cwd during scaffold cleanup.

Status files, stdout, stderr, response files, screenshots, and snapshots shall live outside the worker cwd.

## Progress Tracker Contract

Maintain this file throughout execution:

```text
/tmp/kimi-headless-examples/headless-trials-2026-06/tracker.md
```

The tracker is the user's quick progress view when they are not present.

Update it:

- before starting an app
- after every completed, failed, cancelled, interrupted, or stuck turn
- after each Playwright inspection
- after each test run
- after each app-local commit check
- after each headless-mode bug triage
- after each restart decision
- before ending any long work session

Use these status values:

- `not-started`
- `running`
- `verifying`
- `blocked-headless-bug`
- `blocked-app-bug`
- `abandoned`
- `restarted`
- `done`

The table shall use this shape:

```markdown
| Project | Status | Folder | Completed Turns | Failed/Cancelled/Stuck | Target | Max | Restarts | Last Turn | Last Prompt | Last Status | Tests | Browser Check | Commits | Open Issue | Next Action | Updated |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| collaborative-whiteboard | not-started | apps/collaborative-whiteboard | 0 | 0 | 60 | 100 | 0 | - | - | - | - | - | 0 | - | bootstrap app | 2026-06-07T00:00:00+08:00 |
```

Column rules:

- `Project`: stable app slug.
- `Status`: one of the status values above.
- `Folder`: current active folder, or final folder after restart.
- `Completed Turns`: only turns with `state: "completed"`.
- `Failed/Cancelled/Stuck`: all non-completed invocations.
- `Target`: default `60`.
- `Max`: default `100`.
- `Restarts`: number of abandoned folders for the app.
- `Last Turn`: latest run directory name.
- `Last Prompt`: short summary, not the full prompt. The full prompt belongs in `prompt-log.md`.
- `Last Status`: latest status-file state and useful counters.
- `Tests`: latest test command result.
- `Browser Check`: latest Playwright snapshot or screenshot result.
- `Commits`: app-local commit count.
- `Open Issue`: most important unresolved app or headless issue.
- `Next Action`: what the operator should do next.
- `Updated`: ISO timestamp with timezone.

If a project is abandoned and restarted, keep one row for the app.

Set `Folder` to the active restart folder.

Mention abandoned folders in `Open Issue` or `Next Action`, and detail them in the aggregate report.

## Common Headless Command Pattern

Before each run, set:

```sh
APP_DIR=/tmp/kimi-headless-examples/headless-trials-2026-06/apps/<app-folder>
RUN_DIR=/tmp/kimi-headless-examples/headless-trials-2026-06/runs/<app-folder>/turn-001
mkdir -p "$RUN_DIR/output" "$RUN_DIR/playwright"
```

`RUN_DIR` shall not be inside `APP_DIR`.

First turn:

```sh
node /path/to/kimi-code/apps/kimi-code/dist/main.mjs \
  headless run \
  --cwd "$APP_DIR" \
  --prompt "$PROMPT" \
  --metadata-only \
  --status-file "$RUN_DIR/status.json" \
  --output-dir "$RUN_DIR/output" \
  > "$RUN_DIR/stdout.json" \
  2> "$RUN_DIR/stderr.txt"
```

Follow-up turns:

```sh
node /path/to/kimi-code/apps/kimi-code/dist/main.mjs \
  headless run \
  --cwd "$APP_DIR" \
  --continue \
  --prompt "$PROMPT" \
  --metadata-only \
  --status-file "$RUN_DIR/status.json" \
  --output-dir "$RUN_DIR/output" \
  > "$RUN_DIR/stdout.json" \
  2> "$RUN_DIR/stderr.txt"
```

Status check:

```sh
node /path/to/kimi-code/apps/kimi-code/dist/main.mjs \
  headless status \
  --file "$RUN_DIR/status.json"
```

## Turn Wait Protocol

The operator shall supervise each headless turn without joining Kimi's creation loop.

After starting `kimi headless`, wait for one of two events:

- the process exits
- one minute passes

During the one-minute wait:

- do not read code
- do not read generated files
- do not read diffs
- do not inspect artifacts
- do not poll status repeatedly
- do not update tracker files
- do not send extra prompts

If the operator is using an interactive process session, the wait may be a blocking read with no input:

```text
write_stdin({
  session_id: <kimi-process-session>,
  chars: "",
  yield_time_ms: 60000
})
```

This call only waits for the process to produce output or exit.

It shall not be treated as active supervision work.

If the process exits before 60 seconds, handle the completed run immediately.

If one minute passes and the process is still running, read only compact status fields:

```sh
jq '{state,lastEvent,turnId,summary,error,updatedAt}' "$RUN_DIR/status.json"
```

If status is healthy, wait another minute.

A turn taking more than 5 minutes is not suspicious by itself.

Do not classify a run as stuck only because it is slow.

Treat it as stuck only when status stops changing for a long period, the process is gone without a terminal status, or a clear headless-mode bug appears.

The operator shall not read Kimi's code while the turn is running.

The operator should inspect outcomes after the turn finishes:

- final status
- final response file
- app-local Git status and latest commit
- tests and build
- browser behavior with Playwright when the app can run

The operator should read code only when the outcome is unclear, tests fail in a way that needs triage, or a headless-mode bug needs evidence.

## Playwright Supervision Contract

Before using Playwright, verify `npx`:

```sh
command -v npx >/dev/null 2>&1
```

Set the wrapper path:

```sh
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"
```

For each browser inspection:

```sh
"$PWCLI" open "$APP_URL" --headed
"$PWCLI" snapshot > "$RUN_DIR/playwright/snapshot.md"
"$PWCLI" screenshot "$RUN_DIR/playwright/screenshot.png"
```

Use snapshots before clicking element refs.

Re-snapshot after navigation, modal opens, tab changes, drag/drop attempts, or major UI updates.

Playwright belongs to the supervising operator.

The headless worker should not use Playwright during app-building turns.

The worker should use normal project tests, typechecks, and implementation tools.

The operator uses Playwright outside the worker turn to inspect the artifact and decide the next prompt.

## Quality Bar For Every App

Each app shall have:

- real create, read, update, and delete workflows
- persistence across page reloads
- import and export where the domain naturally needs it
- empty states
- loading states
- validation errors
- useful sample data
- keyboard-accessible controls
- screen-reader labels for primary workflows
- responsive layout for desktop and narrow widths
- tests for domain logic
- tests for persistence or import/export logic
- at least one browser-supervised end-to-end workflow
- project README with setup, usage, test, and limitations
- project `prompt-log.md` with every prompt and rationale
- project `trial-report.md` with DOs and DONTs
- small, frequent app-local commits

Basic styling is not enough.

Each app shall have polished details:

- clear information hierarchy
- usable spacing
- stable toolbar and navigation
- meaningful icons only when available from the chosen stack
- consistent button states
- disabled states for unavailable actions
- inline validation copy
- no overlapping text
- no placeholder-only features

## Task 1: Prepare Trial Harness

**Files:**

- Create: `/tmp/kimi-headless-examples/headless-trials-2026-06/README.md`
- Create: `/tmp/kimi-headless-examples/headless-trials-2026-06/tracker.md`
- Create: `/tmp/kimi-headless-examples/headless-trials-2026-06/operator-log.md`
- Create: `/tmp/kimi-headless-examples/headless-trials-2026-06/shared/prompt-bank.md`
- Create: `/tmp/kimi-headless-examples/headless-trials-2026-06/shared/playwright-notes.md`
- Create: `/tmp/kimi-headless-examples/headless-trials-2026-06/shared/failure-ledger.md`

- [x] **Step 1: Create the root trial folder**

Run:

```sh
mkdir -p /tmp/kimi-headless-examples/headless-trials-2026-06/shared
mkdir -p /tmp/kimi-headless-examples/headless-trials-2026-06/apps
```

Expected: folders exist.

- [x] **Step 2: Verify the headless CLI build**

Run:

```sh
pnpm --filter @moonshot-ai/kimi-code run build
node apps/kimi-code/dist/main.mjs headless --help
```

Expected: build passes and help includes `run`, `status`, and `goal`.

- [x] **Step 3: Verify Playwright wrapper**

Run:

```sh
command -v npx >/dev/null 2>&1
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"
"$PWCLI" --help
```

Expected: wrapper prints help.

- [x] **Step 4: Write the root README**

The README shall explain:

- eight apps
- 50 to 100 completed turns per app
- `tracker.md` as the quick progress view
- how completed turns are counted
- how prompt rationale logs are maintained
- how cancelled and failed turns are logged
- how app-local commits are expected
- where screenshots and reports live

- [x] **Step 5: Write the shared prompt bank**

Include prompt categories:

- bootstrap
- fix failing tests
- browser polish
- persistence
- import/export
- accessibility
- performance
- small commits
- report writing

- [x] **Step 6: Write the initial tracker**

Create `tracker.md` with one row per app.

Initial values:

- `Status`: `not-started`
- `Completed Turns`: `0`
- `Failed/Cancelled/Stuck`: `0`
- `Target`: `60`
- `Max`: `100`
- `Restarts`: `0`
- `Last Turn`: `-`
- `Last Prompt`: `-`
- `Last Status`: `-`
- `Tests`: `-`
- `Browser Check`: `-`
- `Commits`: `0`
- `Open Issue`: `-`
- `Next Action`: `bootstrap app`

- [x] **Step 7: Commit harness files only if execution starts**

Do not commit during plan approval.

Commit during execution after files are created:

```sh
git add /tmp/kimi-headless-examples/headless-trials-2026-06
git commit -m "chore: add headless trial harness"
```

## Task 2: Collaborative Whiteboard

**App Directory:** `/tmp/kimi-headless-examples/headless-trials-2026-06/apps/collaborative-whiteboard`

**Goal:** Build a polished local whiteboard for drawing shapes, sticky notes, connectors, and annotations.

**Core Workflows:**

- create boards
- draw rectangles, ellipses, arrows, and freehand strokes
- add sticky notes
- select, move, resize, and delete items
- zoom and pan
- undo and redo
- save boards locally
- export to PNG and JSON
- import JSON board snapshots

**Expected Tech:**

- Vite
- React
- TypeScript
- canvas or SVG
- localStorage or IndexedDB
- Vitest for geometry and state tests

**Turn Plan:**

- Turns 1-10: scaffold app, drawing model, board persistence, tests
- Turns 11-20: selection, drag, resize, delete, undo/redo
- Turns 21-30: zoom, pan, sticky notes, connectors
- Turns 31-40: import/export, sample boards, error handling
- Turns 41-50: Playwright browser inspection and interaction repair
- Turns 51-70: UI polish, keyboard controls, accessibility, responsive layout
- Turns 71-100: bug hunts, edge cases, performance, final report

**Supervision Gates:**

- [ ] board can be created and reopened after reload
- [ ] shapes can be selected, moved, resized, and deleted
- [ ] undo and redo work for at least five action types
- [ ] exported JSON imports into an equivalent board
- [ ] Playwright screenshot shows a usable toolbar and canvas
- [ ] no visible overlap at 1280px and 390px widths

**Playwright Checks:**

```sh
"$PWCLI" open "$APP_URL" --headed
"$PWCLI" snapshot > "$RUN_DIR/playwright/snapshot.md"
"$PWCLI" screenshot "$RUN_DIR/playwright/screenshot.png"
```

Manual actions to perform through Playwright:

- create board
- add sticky note
- draw rectangle
- select and move item
- reload page
- verify board persists

## Task 3: Kanban Planning System

**App Directory:** `/tmp/kimi-headless-examples/headless-trials-2026-06/apps/kanban-planning-system`

**Goal:** Build a usable planning board for tasks, lanes, dependencies, filters, and saved views.

**Core Workflows:**

- create projects and boards
- create columns and swimlanes
- create, edit, archive, and restore cards
- drag cards across columns
- assign priority, labels, due dates, and owners
- define card dependencies
- filter and search cards
- save views
- import and export board JSON

**Expected Tech:**

- Vite
- React
- TypeScript
- drag/drop library if available or native pointer events
- localStorage or IndexedDB
- Vitest for board reducers and dependency rules

**Turn Plan:**

- Turns 1-10: scaffold, domain model, reducer tests, basic board UI
- Turns 11-20: card CRUD, columns, swimlanes, persistence
- Turns 21-30: drag/drop, dependency rules, archive/restore
- Turns 31-40: filters, search, saved views
- Turns 41-50: import/export and sample data
- Turns 51-70: Playwright repair, keyboard navigation, responsive board layout
- Turns 71-100: polish, edge cases, report

**Supervision Gates:**

- [ ] card movement persists after reload
- [ ] dependency cycles are rejected with clear copy
- [ ] saved filters can be selected later
- [ ] import/export round-trips realistic sample data
- [ ] drag/drop is usable in browser
- [ ] dense board remains readable

**Playwright Actions:**

- create card
- edit title and labels
- drag card to another column
- filter by label
- save view
- reload and verify persistence

## Task 4: Mini Log Analytics Workbench

**App Directory:** `/tmp/kimi-headless-examples/headless-trials-2026-06/apps/log-analytics-workbench`

**Goal:** Build a local log-analysis app that imports logs, parses events, filters timelines, and highlights anomalies.

**Core Workflows:**

- import plain text log files
- parse timestamps, levels, sources, and messages
- display event table and timeline
- filter by time, level, source, and text
- save queries
- mark anomalies
- chart event volume
- export filtered results

**Expected Tech:**

- Vite
- React
- TypeScript
- Web Worker for parsing if needed
- localStorage or IndexedDB
- Vitest for parser and query engine

**Turn Plan:**

- Turns 1-10: scaffold, parser, fixtures, parser tests
- Turns 11-20: import UI, event table, empty/error states
- Turns 21-30: filters, saved queries, query tests
- Turns 31-40: timeline and charts
- Turns 41-50: anomaly markers, export, sample datasets
- Turns 51-70: Playwright inspections, performance on large fixture
- Turns 71-100: visual polish, accessibility, report

**Supervision Gates:**

- [ ] realistic log fixture imports successfully
- [ ] invalid lines are shown without crashing import
- [ ] filters update table and chart consistently
- [ ] saved query survives reload
- [ ] large fixture remains responsive enough for local use
- [ ] anomaly marker is visible in table and timeline

**Playwright Actions:**

- import sample log
- apply level filter
- save query
- mark anomaly
- export filtered data

## Task 5: Interactive SQL Explorer

**App Directory:** `/tmp/kimi-headless-examples/headless-trials-2026-06/apps/sql-explorer`

**Goal:** Build a local SQLite-style query explorer with schema browsing, saved queries, result tables, CSV import, and charting.

**Core Workflows:**

- create or load local database
- import CSV into a table
- inspect schema
- write SQL query
- run query and show result table
- save query
- view query history
- chart numeric result columns
- export query results

**Expected Tech:**

- Vite
- React
- TypeScript
- SQLite in browser through a local package if practical
- fallback in-memory relational model if SQLite package setup blocks progress
- Vitest for CSV parsing, query history, and chart data mapping

**Turn Plan:**

- Turns 1-10: scaffold, table model, CSV parser, tests
- Turns 11-20: schema browser, query editor, result table
- Turns 21-30: SQL execution or fallback query engine
- Turns 31-40: saved queries, history, errors
- Turns 41-50: charting and export
- Turns 51-70: Playwright inspection, keyboard shortcuts, empty states
- Turns 71-100: polish, robustness, report

**Supervision Gates:**

- [ ] CSV import creates a browsable table
- [ ] query errors are shown inline
- [ ] saved query can be rerun
- [ ] query history persists
- [ ] chart view handles at least one numeric column
- [ ] export writes visible result data

**Playwright Actions:**

- import CSV
- inspect schema
- run query
- save query
- switch to chart
- export results

## Task 6: Workflow Automation Builder

**App Directory:** `/tmp/kimi-headless-examples/headless-trials-2026-06/apps/workflow-automation-builder`

**Goal:** Build a visual node-based workflow builder with mock execution and trace inspection.

**Core Workflows:**

- create workflow
- add trigger, transform, condition, and action nodes
- connect nodes
- edit node configuration
- validate workflow
- run workflow against sample input
- show step-by-step trace
- save and reload workflow
- export and import workflow JSON

**Expected Tech:**

- Vite
- React
- TypeScript
- SVG or canvas node graph
- localStorage or IndexedDB
- Vitest for graph validation and execution engine

**Turn Plan:**

- Turns 1-10: scaffold, graph model, validation tests
- Turns 11-20: node palette, node editor, persistence
- Turns 21-30: connectors, layout, graph interactions
- Turns 31-40: mock execution engine and trace viewer
- Turns 41-50: import/export and sample workflows
- Turns 51-80: Playwright graph interaction repair, usability polish
- Turns 81-100: edge cases, accessibility, report

**Supervision Gates:**

- [ ] invalid graph shows clear validation errors
- [ ] valid workflow runs and produces trace
- [ ] node config edits persist
- [ ] import/export round-trips workflow
- [ ] graph is usable in browser without reading docs
- [ ] trace viewer explains each step

**Playwright Actions:**

- create workflow
- add nodes
- connect nodes
- run workflow
- inspect trace
- reload and verify persistence

## Task 7: Issue Tracker With Triage Hooks

**App Directory:** `/tmp/kimi-headless-examples/headless-trials-2026-06/apps/issue-tracker-triage`

**Goal:** Build a local issue tracker with triage workflows, duplicate detection, saved views, comments, and activity history.

**Core Workflows:**

- create issue
- edit title, description, status, priority, labels, and milestone
- add comments
- record activity log
- search and filter issues
- detect likely duplicates from title and labels
- save views
- import/export issue JSON
- Markdown preview for descriptions and comments

**Expected Tech:**

- Vite
- React
- TypeScript
- localStorage or IndexedDB
- small Markdown renderer if dependency is justified
- Vitest for triage rules and duplicate scoring

**Turn Plan:**

- Turns 1-10: scaffold, issue model, reducer tests
- Turns 11-20: issue list, detail editor, persistence
- Turns 21-30: comments, activity log, labels, milestones
- Turns 31-40: search, filters, saved views
- Turns 41-50: duplicate detection, Markdown preview
- Turns 51-70: Playwright inspection and workflow repair
- Turns 71-100: import/export, polish, report

**Supervision Gates:**

- [ ] issue workflow works from list to detail and back
- [ ] comments append to activity log
- [ ] duplicate detection is visible but not destructive
- [ ] saved view persists
- [ ] Markdown preview is readable
- [ ] imported issues preserve comments and activity

**Playwright Actions:**

- create issue
- add comment
- apply label filter
- save view
- inspect duplicate suggestions
- export issues

## Task 8: Music Library Manager

**App Directory:** `/tmp/kimi-headless-examples/headless-trials-2026-06/apps/music-library-manager`

**Goal:** Build a local music library manager with folder import simulation, metadata editing, playlists, duplicate detection, and smart filters.

**Core Workflows:**

- import a folder manifest or sample JSON library
- list tracks, albums, artists, and genres
- edit metadata
- create playlists
- detect duplicates
- define smart filters
- export library and playlists
- show scan summary and warnings

**Expected Tech:**

- Vite
- React
- TypeScript
- localStorage or IndexedDB
- fixture-based import instead of direct filesystem scan in browser
- Vitest for duplicate detection, filters, and playlist rules

**Turn Plan:**

- Turns 1-10: scaffold, music domain model, sample library fixtures
- Turns 11-20: library import, track table, metadata editor
- Turns 21-30: album/artist views, playlists
- Turns 31-40: duplicate detection and smart filters
- Turns 41-50: export and scan warnings
- Turns 51-70: Playwright inspection, dense UI polish
- Turns 71-100: edge cases, accessibility, report

**Supervision Gates:**

- [ ] sample library imports and persists
- [ ] metadata edit updates all relevant views
- [ ] playlist creation and ordering work
- [ ] duplicate suggestions are explainable
- [ ] smart filters can be saved
- [ ] export includes edited metadata and playlists

**Playwright Actions:**

- import sample library
- edit track metadata
- create playlist
- run duplicate detection
- save smart filter
- reload and verify persistence

## Task 9: Personal CRM

**App Directory:** `/tmp/kimi-headless-examples/headless-trials-2026-06/apps/personal-crm`

**Goal:** Build a local CRM for contacts, companies, interactions, reminders, pipeline stages, notes, and search.

**Core Workflows:**

- create contacts and companies
- link contacts to companies
- record interactions
- add notes
- create reminders
- move opportunities through pipeline stages
- search contacts and companies
- import/export contacts
- show timeline per contact

**Expected Tech:**

- Vite
- React
- TypeScript
- localStorage or IndexedDB
- Vitest for relationship logic, reminders, and search

**Turn Plan:**

- Turns 1-10: scaffold, CRM domain model, tests
- Turns 11-20: contact and company CRUD, persistence
- Turns 21-30: interactions, notes, timeline
- Turns 31-40: reminders and pipeline stages
- Turns 41-50: search, import/export, sample data
- Turns 51-70: Playwright workflow repair and UI polish
- Turns 71-100: responsive layout, accessibility, report

**Supervision Gates:**

- [ ] contact can be linked to company
- [ ] timeline shows notes and interactions in order
- [ ] reminder state can be changed
- [ ] pipeline stage changes persist
- [ ] search finds contacts, companies, and notes
- [ ] import/export round-trips sample data

**Playwright Actions:**

- create company
- create contact
- add interaction
- create reminder
- move opportunity
- search and reload

## Task 10: Cross-Project Supervision

**Files:**

- Modify: `/tmp/kimi-headless-examples/headless-trials-2026-06/tracker.md`
- Create: `/tmp/kimi-headless-examples/headless-trials-2026-06/operator-log.md`
- Modify: `/tmp/kimi-headless-examples/headless-trials-2026-06/shared/failure-ledger.md`
- Modify: each app's `prompt-log.md`
- Modify: each app's `trial-report.md`

- [ ] **Step 1: Count completed turns after each app**

Run:

```sh
python3 - <<'PY'
import json, pathlib
root = pathlib.Path('/tmp/kimi-headless-examples/headless-trials-2026-06/apps')
for app in sorted(root.iterdir()):
    if not app.is_dir():
        continue
    completed = 0
    states = {}
    for status_path in sorted((app / 'runs').glob('turn-*/status.json')):
        status = json.load(open(status_path))
        states[status['state']] = states.get(status['state'], 0) + 1
        if status['state'] == 'completed':
            completed += 1
    print(f'{app.name}: completed={completed} states={states}')
PY
```

Expected: every app has `completed >= 50`.

- [ ] **Step 2: Update the tracker table**

After every app turn or verification checkpoint, update `tracker.md`.

For each app row, verify:

- `Status` reflects current reality.
- `Folder` points to the active app folder.
- `Completed Turns` matches status files.
- `Failed/Cancelled/Stuck` matches status files.
- `Last Turn` is the newest run directory.
- `Last Prompt` matches the latest prompt-log entry summary.
- `Last Status` includes latest status state and tool count when useful.
- `Tests` names the latest test command and result.
- `Browser Check` names latest snapshot or screenshot result.
- `Commits` matches app-local Git history.
- `Open Issue` is concise.
- `Next Action` is actionable.
- `Updated` uses the current timestamp.

If the user asks for progress, read `tracker.md` first.

- [ ] **Step 3: Verify per-turn prompt logs**

For each app, verify:

- `prompt-log.md` exists
- each run directory has a matching prompt-log entry
- each prompt-log entry includes the exact prompt text
- each prompt-log entry explains why that prompt was used at that moment
- each prompt-log entry links to evidence when available
- failed, cancelled, interrupted, and stuck runs are included

Run:

```sh
python3 - <<'PY'
import pathlib, re
root = pathlib.Path('/tmp/kimi-headless-examples/headless-trials-2026-06/apps')
for app in sorted(root.iterdir()):
    if not app.is_dir():
        continue
    log = app / 'prompt-log.md'
    runs = sorted((app / 'runs').glob('turn-*'))
    text = log.read_text() if log.exists() else ''
    entries = len(re.findall(r'^## Turn ', text, flags=re.M))
    print(f'{app.name}: runs={len(runs)} prompt_log_entries={entries}')
PY
```

Expected: `prompt_log_entries >= runs` for each app.

- [ ] **Step 4: Verify app-local commits**

For each app, run:

```sh
git -C "$APP_DIR" status --short
git -C "$APP_DIR" log --oneline --decorate -20
```

Expected:

- Git repo exists.
- Recent history has small commits.
- Commit messages describe focused changes.
- `runs/`, status files, screenshots, and temporary logs are not committed.
- No co-author trailers appear in commit messages.

- [ ] **Step 5: Record headless bugs**

For each failure, record:

- command
- status file state
- stdout and stderr paths
- what the operator expected
- what happened
- whether a product fix was made
- whether the app folder was still resumable
- abandoned folder path when restart was required
- replacement folder path when restart was required

- [ ] **Step 6: Record abandoned and restarted projects**

For each abandoned app folder, verify:

- original folder still exists
- original `runs/` data is preserved
- original `prompt-log.md` includes the abandonment entry
- original `trial-report.md` explains why it was abandoned
- `shared/failure-ledger.md` links to the original folder
- replacement folder uses the `-restart-NN` naming pattern
- replacement folder has a new Git repo
- replacement folder has a new headless session

Run:

```sh
find /tmp/kimi-headless-examples/headless-trials-2026-06/apps \
  -maxdepth 1 \
  -type d \
  -name '*-restart-*' \
  -print
```

Expected: any restart folder corresponds to a documented abandoned folder.

- [ ] **Step 7: Record app bugs**

For each app bug, record:

- browser screenshot path
- failing test command
- correction prompt
- turn number that fixed it

- [ ] **Step 8: Write per-project report**

Each `trial-report.md` shall include:

- turn count
- commit count
- screenshots
- prompt-log summary
- strongest lazy prompts
- weak prompts
- headless-mode issues found
- app-quality issues found
- abandonment and restart history when applicable
- DOs
- DONTs

- [ ] **Step 9: Write aggregate report**

Create:

```text
/tmp/kimi-headless-examples/headless-trials-2026-06/report.md
```

Include:

- table of all eight apps
- completed turns per app
- abandoned folder count per app
- final folder path per app
- app-local commit count per app
- final verification command per app
- screenshots per app
- top 10 headless-mode findings
- top 10 operator lessons
- product issues fixed during the trial
- remaining headless-mode concerns

## Task 11: Final Verification

**Files:**

- Modify: `/tmp/kimi-headless-examples/headless-trials-2026-06/report.md`
- Modify: `plans/2026-06-07-headless-complex-app-trials.md`

- [ ] **Step 1: Verify all app tests**

Run each app's documented test command.

Expected: every app passes its own test suite.

- [ ] **Step 2: Verify all apps run**

Start each app's dev server one at a time.

Open it with Playwright.

Capture a screenshot.

Expected: each app renders the primary workflow without blank screens or console-fatal errors.

- [ ] **Step 3: Verify turn counts**

Run the count script from Task 10.

Expected: all apps have at least 50 completed turns.

- [ ] **Step 4: Verify reports**

Check every app has:

- `README.md`
- root `tracker.md` row with current state
- `prompt-log.md`
- `trial-report.md`
- at least one Playwright screenshot
- at least one status file from a long-running turn
- app-local Git history with small commits
- restart history when the app was abandoned and restarted
- final verification command result

- [ ] **Step 5: Update this plan**

Mark completed tasks in this file as execution progresses.

Do not mark a project done until its supervision gates pass.

## Execution Policy

Do not start execution from this plan until the user explicitly approves it.

Once approved, use small commits after self-contained additions in the headless repository when repository files change.

Inside each side-project app, ask the headless worker to commit its own changes frequently.

The app-local commits shall stay inside the app repository.

Do not commit generated side-project code into the headless repository unless the user asks.

Do not overwrite the existing trial projects unless the user approves cleanup.

If a project becomes non-resumable, preserve it and restart in a new sibling folder.

Do not delete the abandoned folder.

Do not reuse the abandoned folder's Git repo or headless session for the restarted app.

## Risk Register

- Eight apps at 50 to 100 turns each is a long-running trial. Expect interruptions and retries.
- Browser-based apps may drift into superficial UI unless Playwright checks happen often.
- Agents may claim tests passed without running them. Verify command output directly.
- Long turns may expose status-file or signal-handling bugs. Record these as trial findings.
- Too much prompt detail makes the operator unrealistic. Keep prompts short and corrective.
- Too little supervision lets bad app quality accumulate. Inspect after every turn or every small group of turns.
- Missing app-local commits make it harder to audit agent work. Verify commit history repeatedly.
- Missing prompt rationale makes the trial hard to learn from. Update `prompt-log.md` every turn.
- A headless bug may corrupt the current app's session or status. Preserve the broken folder and restart in a new sibling folder.
- Restarted apps can confuse reporting. Track abandoned and final folders separately.

## Definition of Done

- All eight apps exist under `/tmp/kimi-headless-examples/headless-trials-2026-06/apps/`.
- Each app has at least 50 completed headless turns.
- If an app was restarted, the final restart folder has at least 50 completed turns.
- Abandoned app folders are preserved and linked from the aggregate report.
- Each app is usable through a browser.
- Each app has persistence.
- Each app has tests.
- Each app has a README.
- Root `tracker.md` accurately shows current status, turn counts, tests, browser checks, commits, open issue, and next action for every app.
- Each app has a `prompt-log.md` with every prompt and the reason for using it.
- Each app has a `trial-report.md`.
- Each app has small, frequent local Git commits made by the headless worker.
- Each app has Playwright snapshots and screenshots.
- The aggregate report exists.
- All final verification commands pass.
- Any headless-mode bugs found during the trial are recorded with reproduction data.
