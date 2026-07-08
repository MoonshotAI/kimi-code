Use this tool when you need to ask the user questions with structured options during execution. This allows you to:
1. Collect user preferences or requirements before proceeding
2. Resolve ambiguous or underspecified instructions
3. Let the user decide between implementation approaches as you work
4. Present concrete options when multiple valid directions exist

**When NOT to use:**
- When you can infer the answer from context — be decisive and proceed
- Trivial decisions that don't materially affect the outcome

Overusing this tool interrupts the user's flow. Only use it when the user's input genuinely changes your next action.

**Usage notes:**
- Users always have an "Other" option for custom input — don't create one yourself
- Use multi_select to allow multiple answers to be selected for a question
- Keep option labels concise (1-5 words), use descriptions for trade-offs and details
- Each question should have 2-4 meaningful, distinct options
- Question texts must be unique across the call, and option labels must be unique within each question
- You can ask 1-4 questions at a time; group related questions to minimize interruptions
- If you recommend a specific option, list it first and append "(Recommended)" to its label
- The result is JSON with an `answers` object keyed by question text; each value is the chosen option's label (comma-separated labels for multi_select, or the user's own words if they picked "Other"); if `answers` is empty and a `note` says the user dismissed it, they declined to answer — proceed with your best judgment and do not re-ask the same question
- Set background=true when you can keep working without the answer. This starts a background question task and returns a task_id immediately. The answer arrives automatically in a later turn — you do not need to poll, sleep, or check on it. Continue with other work; never fabricate or predict the answer.