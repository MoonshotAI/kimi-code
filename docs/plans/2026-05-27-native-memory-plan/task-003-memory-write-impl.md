# Task 003 impl — Memory tool write operation + FileMemoryStore.write

**Subject**: Implement the Memory tool `write` operation and `FileMemoryStore.write` with atomic tmp-rename semantics.
**Type**: impl
**Depends-on**: ["003-test"]

## BDD Scenarios

```gherkin
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
```

## Files

- **Create**: `packages/agent-core/src/tools/builtin/state/memory.ts` — `MemoryTool` class (full class shell + `write` operation handler).
- **Create**: `packages/agent-core/src/tools/builtin/state/memory.md` — agent-facing tool description (sibling `.md` loaded automatically; placeholder content; final text lands in task 011).
- **Modify**: `packages/agent-core/src/memory/store.ts` — implement `FileMemoryStore.write` (atomic tmp-rename).
- **Modify**: `packages/agent-core/src/memory/slug.ts` — implement `isValidSlug` body.
- **Modify**: `packages/agent-core/src/memory/format.ts` — implement `renderMemoryFile` body.
- **Modify**: `packages/agent-core/src/tools/builtin/index.ts:17` — re-export `./state/memory`.
- **Modify**: `packages/agent-core/src/agent/tool/index.ts` (around line 372) — register `new b.MemoryTool(kaos, workspace)` in the builtin tools list.

## Interface contracts

```ts
// packages/agent-core/src/tools/builtin/state/memory.ts

const MemoryRecordSchema = z.object({ /* name kebab regex, description max 240, type enum */ });
const MemoryScopeSchema = z.enum(['user', 'project']);

export const MemoryInputSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('view') }),
  z.object({ operation: z.literal('list'),   scope: MemoryScopeSchema.optional(), type: z.enum([...]).optional() }),
  z.object({ operation: z.literal('read'),   scope: MemoryScopeSchema, name: z.string() }),
  z.object({ operation: z.literal('write'),  scope: MemoryScopeSchema, record: MemoryRecordSchema, body: z.string().max(4096) }),
  z.object({ operation: z.literal('update'), scope: MemoryScopeSchema, name: z.string(), record: MemoryRecordSchema.partial().optional(), body: z.string().max(4096).optional() }),
  z.object({ operation: z.literal('delete'), scope: MemoryScopeSchema, name: z.string() }),
]);

export type MemoryInput = z.infer<typeof MemoryInputSchema>;

export class MemoryTool implements BuiltinTool<MemoryInput> {
  readonly name = 'memory';
  readonly description: string;        // loaded from sibling memory.md
  readonly parameters: JsonSchema;     // toInputJsonSchema(MemoryInputSchema)
  constructor(kaos: Kaos, workspace: Workspace);
  resolveExecution(args: MemoryInput): ToolExecution;
}
```

`FileMemoryStore.write(scope, record, body)`:

1. Validate `record.name` via `isValidSlug`; reject `INVALID_SLUG` if not.
2. Validate body byte length ≤ `MEMORY_BODY_MAX_BYTES`; reject `BODY_TOO_LARGE`.
3. Resolve `finalPath = join(rootFor(scope), record.name + '.md')`; ensure inside `rootFor(scope)` via `isWithinDirectory` (reuse from `tools/policies/path-access.ts`).
4. Ensure scope dir exists (`mkdir { parents: true, existOk: true }`).
5. If `finalPath` already exists → throw structured `EXISTS` error.
6. Render the file content via `renderMemoryFile(record, body)` (frontmatter + body, trimmed).
7. Atomic write: `tmpPath = join(dir, '.tmp-' + randomHex(8) + '-' + record.name + '.md')`, `kaos.writeText(tmpPath, content)`, `kaos.rename(tmpPath, finalPath)`.
8. On secret-pattern match (regex list from design `best-practices.md` Security): annotate the returned `MemoryEntry` (or the tool result `output`) with a warning naming the category — do not block.
9. Return the `MemoryEntry`.

## Verification

- `pnpm test packages/agent-core/test/tools/memory.test.ts` — all 6 write cases pass (GREEN).
- `pnpm test packages/agent-core/test/profile/context.test.ts` — still green.
- `pnpm typecheck` + `pnpm lint` pass.
