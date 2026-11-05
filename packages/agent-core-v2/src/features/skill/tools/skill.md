Invoke a registered skill from the current skill listing. BLOCKING REQUIREMENT: when a skill from the listing matches the user's request, you MUST call this tool before taking any task action. Do not read `SKILL.md` to invoke a skill; use direct file access only to inspect or edit the skill itself.

Example:
- `{ "skill": "commit", "args": "-m 'Fix bug'" }`

Do not re-invoke a skill to repeat work already done: if a `<skill-loaded>` block for it with the same `args` is already present in the conversation, follow those instructions directly instead of calling the tool again. Do call the tool again when you need the skill with different arguments — the loaded block was expanded with the earlier `args` and will not reflect new inputs.