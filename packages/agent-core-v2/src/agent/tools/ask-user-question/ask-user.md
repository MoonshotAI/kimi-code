Ask the user structured multiple-choice questions while you work.

Each call interrupts the user, so ask only when the answer would change your next action and you cannot reasonably infer it from context. Group related questions into one call.

- Question texts must be unique across the call, and option labels must be unique within each question. List a recommended option first.
- The result is JSON with an `answers` object keyed by question text; each value is the chosen option's label (comma-separated labels for multi_select, or the user's own words if they picked "Other"). If `answers` is empty and a `note` says the user dismissed it, they chose not to answer: decide from context, do not treat this as selecting the recommended option, and do not re-ask the same question.
