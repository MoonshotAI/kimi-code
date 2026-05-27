# BDD Specifications — Native Cross-Session Memory

Companion to [`_index.md`](./_index.md). Uses canonical vocabulary from the `_index.md` Glossary. Scenarios will be translated into vitest cases living next to existing tests (per repo `AGENTS.md`: "do not add too many new test files"). This file is the planning artifact, not a runnable `.feature` file (this repo has no `.feature` infrastructure today).

```gherkin
# Vocabulary (canonical, do not invent synonyms):
#   memory        — the system / feature
#   Memory tool   — the builtin tool (proper noun in prose); registered as `memory`
#   fact / memory record — a single stored item (preferred: fact)
#   scope         — user | project
#   index         — the rendered, budgeted block injected into the system prompt
#   MEMORY.md     — reserved logical filename for the index (v1: render-only, not persisted)
#   body          — per-fact .md file content
#   slug          — kebab-case identifier (equals frontmatter `name`, equals basename without `.md`)
#   operation     — discriminator field on Memory tool input
#
# Storage layout:
#   ~/.kimi-code/memory/<slug>.md                          (user-scope body files)
#   <git-root>/.kimi-code/memory/<slug>.md                 (project-scope body files)

Feature: Storage with layered scopes

  Background:
    Given a clean user home directory
    And a clean project working directory inside a git repository

  Scenario: Loading from user scope only
    Given the user scope contains a fact "code-style" of type "user"
    And the project scope contains no memory directory
    When the agent assembles the system prompt
    Then the rendered index lists "code-style" under the User section
    And the index is annotated with the user-scope source path
    And no Project section is rendered

  Scenario: Loading from project scope only
    Given the project scope contains a fact "build-commands" of type "project"
    And the user scope contains no memory directory
    When the agent assembles the system prompt
    Then the rendered index lists "build-commands" under the Project section
    And the index is annotated with the project-scope source path

  Scenario: Loading merged user and project indexes with no collisions
    Given the user scope contains a fact "code-style"
    And the project scope contains a fact "build-commands"
    When the agent assembles the system prompt
    Then both facts appear in the rendered index
    And the Project section appears before the User section

  Scenario: Project slug shadows user slug on collision
    Given the user scope contains a fact "code-style" with description "global default"
    And the project scope contains a fact "code-style" with description "repo-specific"
    When the agent assembles the system prompt
    Then exactly one entry for slug "code-style" is rendered in the index
    And that entry comes from the Project section
    And the user-scope fact remains addressable via the Memory tool with scope "user"

  Scenario: Subagent inherits parent's memory index
    Given the main agent has a memory index containing fact "test-runner"
    When the subagent host spawns a subagent with the same cwd
    Then the subagent's system prompt also contains the "test-runner" index entry
    And the subagent's index is loaded fresh from disk (not copied from parent state)

  Scenario: Missing memory directory is handled silently
    Given neither user nor project memory directories exist
    When the agent assembles the system prompt
    Then no Memory section is injected
    And no error or warning is recorded
    And no empty header is rendered

  Scenario: Non-git working directory falls back to no project scope
    Given the working directory is not inside a git repository
    And the user scope contains a fact "global-pref"
    When the agent assembles the system prompt
    Then only the user-scope index is loaded
    And no project-scope lookup is attempted

  Scenario: Reserved filename MEMORY.md is skipped during scan
    Given the project scope directory contains a file named "MEMORY.md"
    When the agent assembles the system prompt
    Then the file named "MEMORY.md" is not treated as a fact
    And no entry for slug "memory" is rendered from that file

Feature: Agent writes via the Memory tool

  Background:
    Given the agent has the Memory tool enabled
    And the agent is running inside a git repository

  Scenario: Agent creates a new fact
    When the agent calls the Memory tool with operation "write", scope "project", name "preferred-test-runner", description "Use vitest, never jest.", type "project", body "Use vitest, never jest."
    Then a body file is created at "<project-root>/.kimi-code/memory/preferred-test-runner.md"
    And the file's frontmatter matches the supplied record
    And the tool result confirms the scope and slug

  Scenario: Atomic write — body is created via tmp-rename
    When the agent calls the Memory tool with operation "write"
    Then the body file appears via a tmp-rename sequence (no partial state visible on interrupt)
    And no `.tmp-*` file remains after completion

  Scenario: Duplicate slug is rejected with a helpful error
    Given the project scope already contains slug "code-style"
    When the agent calls the Memory tool with operation "write" for the same slug in the same scope
    Then the tool returns isError true with reason "EXISTS"
    And the error message suggests operation "update"
    And the existing file is not modified

  Scenario: Body exceeding 4 KB is rejected with a size hint
    When the agent calls the Memory tool with operation "write" and a body of 4097 bytes
    Then the tool returns isError true with reason "BODY_TOO_LARGE"
    And the message states the 4 KB body limit
    And no file is created

  Scenario: Frontmatter missing required fields is rejected
    When the agent calls the Memory tool with operation "write" and omits the type field
    Then the tool returns isError true
    And the error lists the missing field "type"
    And the accepted enum values are listed: user, feedback, project, reference

  Scenario: Secret-looking content triggers a warning but does not block
    When the agent calls the Memory tool with operation "write" and a body containing "sk-ant-xxxxxxxxxxxxxxxxxxxx"
    Then the fact is written successfully
    And the tool result includes a warning naming the matched pattern category
    And the wire log records the warning (pattern category only; no raw match)

Feature: Agent reads via the Memory tool

  Scenario: view returns the merged index
    Given the project scope contains fact "build" and the user scope contains fact "style"
    When the agent calls the Memory tool with operation "view"
    Then the output lists both facts grouped by scope
    And each fact line shows slug, type, and description (not body)
    And the rendered output fits within the 8 KB index budget

  Scenario: list filters by type
    Given the project scope contains facts of types "project" and "reference"
    When the agent calls the Memory tool with operation "list" and type "reference"
    Then only "reference"-typed slugs are returned

  Scenario: list filters by scope
    Given facts exist in both scopes
    When the agent calls the Memory tool with operation "list" and scope "user"
    Then only user-scope slugs are returned

  Scenario: list returns the full untruncated set even when the injected index was truncated
    Given 200 small facts exist in the project scope, totaling more than 8 KB rendered
    And the injected index was budget-truncated
    When the agent calls the Memory tool with operation "list" and scope "project"
    Then the output contains every project-scope slug

  Scenario: read returns the full body of a named fact
    Given a fact "build" exists in the project scope with body "pnpm build"
    When the agent calls the Memory tool with operation "read", scope "project", name "build"
    Then the output contains "pnpm build"
    And the output includes the fact's frontmatter

  Scenario: read of an unknown slug returns a structured error
    When the agent calls the Memory tool with operation "read" and an unknown slug
    Then the tool returns isError true with reason "NOT_FOUND"
    And the message names the requested slug and scope
    And the message suggests calling operation "list" to see available slugs

Feature: Agent updates and deletes via the Memory tool

  Scenario: update replaces body
    Given a fact "build" exists with body "old"
    When the agent calls the Memory tool with operation "update", scope "project", name "build", body "new"
    Then the body file now contains "new"
    And the rendered index reflects any frontmatter changes
    And the write is atomic (tmp-rename)

  Scenario: update merges partial frontmatter
    Given a fact "build" exists with description "Use pnpm" and type "project"
    When the agent calls the Memory tool with operation "update", scope "project", name "build", record.description "Use pnpm exclusively"
    Then the body is preserved
    And the frontmatter description updates to "Use pnpm exclusively"
    And the frontmatter type remains "project"

  Scenario: update of an unknown slug fails without creating a file
    When the agent calls the Memory tool with operation "update" and an unknown slug
    Then the tool returns isError true with reason "NOT_FOUND"
    And no new body file is created

  Scenario: delete removes the body file
    Given a fact "obsolete" exists
    When the agent calls the Memory tool with operation "delete" and slug "obsolete"
    Then the body file no longer exists
    And the next rendered index omits the slug

  Scenario: deleting the last fact in a scope leaves an empty scope dir
    Given the project scope contains exactly one fact
    When the agent calls the Memory tool with operation "delete" on that slug
    Then the scope directory still exists
    And the next rendered index omits the Project section entirely
    And the system prompt's Memory section is omitted if the User scope is also empty

Feature: /memory slash command (TUI curation)

  Scenario: /memory opens a list grouped by scope
    Given facts exist in both scopes
    When the user types "/memory"
    Then the TUI mounts a full-screen browser
    And the panel groups facts under "Project" and "User" headers
    And each row shows slug, type, and one-line description

  Scenario: Selecting a fact previews its body read-only
    Given the /memory panel is open
    When the user selects fact "code-style"
    Then a read-only pane displays the full body including frontmatter
    And no edit affordance is exposed in this view

  Scenario: Deleting via the UI requires explicit confirmation
    Given the /memory panel is open and a fact is selected
    When the user presses "d"
    Then a confirmation prompt is shown
    And only after explicit confirmation is the delete dispatched through `session.deleteMemory(...)`
    And the deletion is atomic at the body file level

  Scenario: /memory shows shadowed user-scope facts with an indicator
    Given the user scope and project scope each contain a fact with slug "code-style"
    When the user opens "/memory"
    Then both facts are listed
    And the user-scope entry is annotated as "shadowed by project"

  Scenario: /remember triggers an agent-routed write (not a direct file write)
    When the user types "/remember Use pnpm not npm in this repo"
    Then `session.remember("Use pnpm not npm in this repo")` is invoked
    And a subagent is spawned to call the Memory tool with operation "write"
    And the TUI does not touch any memory file directly

  Scenario: /remember reuses the /init queueing pattern
    Given the editor has pending user messages
    When the user types "/remember <text>"
    Then deferred-message queueing matches the pattern used by /init
    And the spinner resets after the subagent completes

Feature: System-prompt injection

  Scenario: Index renders into a dedicated section of the system prompt
    Given the user scope and project scope both contain at least one fact
    When the system prompt is rendered
    Then a "# Memory" section appears in the rendered prompt
    And the section contains the merged index
    And the section sits between "# Project Information" and "# Skills"

  Scenario: Each scope block is annotated with its source path
    When the system prompt is rendered with both scopes populated
    Then the Project block heading mentions the project memory directory path
    And the User block heading mentions "~/.kimi-code/memory"

  Scenario: Empty merged set omits the Memory section entirely
    Given no facts exist in any scope
    When the system prompt is rendered
    Then the rendered prompt contains no "# Memory" header
    And no Memory annotation comments are emitted

  Scenario: Total index byte budget is enforced
    Given the merged index would exceed 8 KB rendered
    When the system prompt is rendered
    Then User entries are dropped first (reverse-alpha) until under budget
    And then Project entries are dropped (reverse-alpha) if still over budget
    And the truncated section ends with a sentinel comment "<!-- truncated: N entries omitted; call Memory.list for the full set -->"
    And dropped slugs are not silently lost — they remain on disk and visible via operation "list"

Feature: Survives /compact and session restart

  Scenario: Resuming a session re-reads memory from disk
    Given a previous session wrote fact "x" to project scope
    And the session metadata is persisted but the in-memory cache is empty
    When the session resumes and renders its first system prompt
    Then fact "x" appears in the rendered index
    And the index is read from disk, not restored from session state

  Scenario: /compact preserves memory injection on the next turn
    Given memory contains fact "y"
    When the user runs /compact
    And the agent starts the next turn
    Then fact "y" still appears in the assembled system prompt
    And no duplicate "# Memory" section is rendered

  Scenario: Subagent write becomes visible to parent on next turn
    Given the parent agent's current turn is mid-flight
    When a spawned subagent calls the Memory tool with operation "write" for slug "newfact"
    Then the parent's current system prompt does NOT yet contain "newfact"
    And the parent's next turn's system prompt DOES contain "newfact"

Feature: Security and path safety

  Scenario: Memory write outside the memory directory is rejected
    When the agent calls the Memory tool with operation "write" and a slug containing "../escape"
    Then the tool returns isError true with reason matching "PATH_OUTSIDE_WORKSPACE" or "INVALID_SLUG"
    And no file is created
    And no I/O is performed outside the memory directory

  Scenario: Slug validation rejects unsafe characters
    When the agent calls the Memory tool with operation "write" and slug "FOO BAR/.."
    Then the tool returns isError true with reason "INVALID_SLUG"
    And the message names the allowed slug pattern
    And no file is created

  Scenario: Slug validation rejects leading or trailing hyphens
    When the agent calls the Memory tool with operation "write" and slug "-leading"
    Then the tool returns isError true with reason "INVALID_SLUG"
    And no file is created

  Scenario: Symlink inside the memory directory is not followed
    Given a symlink "trap.md" inside the project memory directory pointing to "/etc/passwd"
    When the agent calls the Memory tool with operation "read" and slug "trap"
    Then the tool returns isError true with a symlink-refusal reason
    And "/etc/passwd" is not read

  Scenario: Plan mode blocks Memory writes
    Given plan mode is active
    When the agent calls the Memory tool with operation "write", "update", or "delete"
    Then the tool returns isError true
    And the message instructs the agent to call ExitPlanMode first
    And read-only operations ("view", "list", "read") still succeed

Feature: Telemetry

  Scenario: Each mutation emits a telemetry event
    When the agent successfully completes operation "write", "update", or "delete"
    Then a corresponding telemetry event is recorded (e.g. `memory_write`, `memory_update`, `memory_delete`)
    And the event includes scope and slug (no body content)

  Scenario: Index truncation increments a counter
    Given the rendered index overflows the 8 KB budget
    When the system prompt is assembled
    Then a `memory_index_truncated` event is recorded with the count of dropped entries
```
