Write JavaScript to orchestrate the agent's tools programmatically, instead of calling tools one by one. Your code becomes the body of an `async function`: use `await tools.<name>(args)` to call a tool, `console.log(...)` to emit output, and `return` a final value. Only your console output and return value come back — intermediate tool results stay inside the execution environment and never enter the conversation, so prefer filtering, aggregating, or summarizing large results in code and printing only the conclusions.

Use this tool when a task needs fan-out or loops over many tool calls, conditional logic on intermediate results, or processing of large tool outputs. Do not use it for a single simple call or when each step needs your own reasoning over the previous full result.

Each `tools.<name>(args)` call resolves to the tool's plain-text result and rejects on unknown names, budget exhaustion, or aborts. `detach(text)` marks the whole run as backgrounded; you will be notified when it completes. Code runs in the agent's own process with full Node.js module access — treat it with the same care as a shell command.

Available tools (callable as `tools.<name>(args)`):
