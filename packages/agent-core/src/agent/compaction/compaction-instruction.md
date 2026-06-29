You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

--- This message is a direct task, not part of the above conversation ---

You are now given a task to compact this conversation context according to the priorities and output requirements below.

The goal of compaction is to keep essential code patterns, technical details, and architectural decisions for continuing development without losing context after the above messages are cleared.

Compression priorities, in order:

1. Current Task State: what is being worked on right now
2. Errors & Solutions: unresolved or recurring errors and their resolutions
3. Code Evolution: final working versions only; remove intermediate attempts
4. System Context: project structure, dependencies, environment setup
5. Design Decisions: architectural choices and their rationale
6. TODO Items: unfinished tasks and known issues

Required output structure:

## Current Focus

[What we're working on now]

## Environment

- [Key setup/config points]
- ...

## Completed Tasks

- [Task]: [Brief outcome]
- ...

## Active Issues

- [Issue]: [Status/Next steps]
- ...

## Code State

### [Critical file name]

[Brief description of the file's purpose and current state]

```
[The latest version of critical code snippets in this file, <20 lines]
```

### [Critical file name]

- [Useful classes/methods/functions]: [Brief description/usage]
- ...

Omit non-critical code, intermediate attempts, and resolved errors.

## Important Context

- [Any crucial information not covered above]
- ...

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.

Respond with text only. Do not call any tools — you already have everything you need in the conversation history.
