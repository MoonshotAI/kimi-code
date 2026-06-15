
--- This message is a direct task, not part of the above conversation ---

You are now given a task to compact this conversation context according to specific priorities and output requirements.

Output text only. DO NOT CALL ANY TOOLS. Calling tools will be rejected and fails the task. You already have all the information you need in the conversation history. You have only one chance.

The goal of compaction is to keep essential code patterns, technical details, and architectural decisions for continuing development without losing context after the above messages are cleared work.

{{ customInstruction }}

<!-- Compression Priorities (in order) -->

1. **Current Task State**: What is being worked on RIGHT NOW
2. **Errors & Solutions**: All encountered errors and their resolutions
3. **Code Evolution**: Final working versions only (remove intermediate attempts)
4. **System Context**: Project structure, dependencies, environment setup
5. **Design Decisions**: Architectural choices and their rationale
6. **TODO Items**: Unfinished tasks and known issues

<!-- Required Output Structure -->

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

<!-- Omit non-critical code, intermediate attempts, and resolved errors -->

## Important Context

- [Any crucial information not covered above]
- ...

## All User Messages

- [Detailed non tool use user message]
- ...

<!-- Must output a summary matching the above template in the **final answer**, not in thinking. -->
