# Task 002 impl — Implement loadMemory + renderIndex

**Subject**: Implement `loadMemory(kaos, workDir)` and `renderIndex(entries, budget)` to make the 002-test scenarios pass.
**Type**: impl
**Depends-on**: ["002-test"]

## BDD Scenarios

```gherkin
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
```

## Files

- **Implement**: `packages/agent-core/src/memory/loader.ts` (function bodies for `loadMemory` and `renderIndex`).
- **Implement**: `packages/agent-core/src/memory/format.ts` (`parseMemoryFile` body — reuses `parseFrontmatter` from `packages/agent-core/src/skill/parser.ts`).

## Implementation guidance

`loadMemory`:

1. `userRoot = join(kaos.gethome(), '.kimi-code', 'memory')`.
2. `projectRoot = findProjectRoot(kaos, workDir)`; `projectMemoryRoot = join(projectRoot, '.kimi-code', 'memory')` (only when inside a git repo — `findProjectRoot` returns the workDir unchanged when no `.git` is found; detect that and skip the project-scope walk).
3. For each scope in order `[user, project]` (project last so it overwrites in the Map):
   - If the scope dir does not exist, skip silently.
   - `readdir`, filter `.md`, sort, skip `MEMORY.md`, skip files whose slug fails `isValidSlug` (with warning), `parseMemoryFile` each, skip on parse failure (with warning), `bySlug.set(slug, entry)`.
4. Pass entries to `renderIndex(entries, MEMORY_INDEX_MAX_BYTES)`.
5. Return `result.rendered`.

`renderIndex`:

1. Group entries by scope (Project before User in output).
2. Render per-entry line: `- [<slug>](<slug>.md) (<type>) — <description>`.
3. Section heading: `## Project (<project-memory-root>)` / `## User (~/.kimi-code/memory)`.
4. Prepend the file-level annotation comments + version sentinel.
5. If total bytes > budget, drop entries: User reverse-alpha first, then Project reverse-alpha, appending `<!-- truncated: N entries omitted; call Memory.list for the full set -->`.
6. Empty merged set → return `MemoryIndex { rendered: "", entries: [], droppedSlugs: [] }`.

`parseMemoryFile`:

1. Read the file via Kaos.
2. Call `parseFrontmatter(text)` from `skill/parser.ts`.
3. Validate frontmatter shape with a zod schema — reject (return `undefined`, emit warning) when missing required fields.
4. Verify `record.name === slug` (basename without `.md`).
5. Validate body byte length ≤ `MEMORY_BODY_MAX_BYTES`; oversized → warn and skip.
6. Build and return the `MemoryEntry`.

## Verification

- `pnpm test packages/agent-core/test/profile/context.test.ts` — all 8 `loadMemory` cases pass (GREEN).
- `pnpm typecheck` passes.
- `pnpm lint` passes.
