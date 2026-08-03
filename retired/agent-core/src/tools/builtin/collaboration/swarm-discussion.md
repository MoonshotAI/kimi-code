Run a roundtable discussion OR a structured debate among multiple AI agents.

**Discussion mode** (default): Each agent takes turns speaking, sees the full transcript, and responds naturally — like humans in a roundtable conversation.

**Debate mode**: A structured multi-phase debate with Opening Statements → Free Debate → Closing Arguments → Consensus. Ideal for adversarial analysis, decision-making, and reaching conclusions.

Use this when you need multiple perspectives on a complex topic, want agents to critique each other's ideas, or need a synthesized outcome from diverse expertise.

## Input

- `mode`: `"discussion"` (default) or `"debate"`.
  - **Discussion**: open roundtable, agents respond naturally.
  - **Debate**: structured phases — opening, free debate (multiple rounds), closing, and optional consensus.
- `topic`: The topic or question to discuss/debate.
- `participants`: Array of participant configurations. Each participant has:
  - `profileName`: Agent profile (e.g. "coder", "explore"). Defaults to "coder".
  - `roleDescription`: The role this agent plays (e.g. "You are a senior database architect...").
  - `assignedStance`: (Debate only) Optional — assign a specific stance (e.g. "argue for migration").
- `maxRounds`: For discussion: max rounds (default: 3). For debate: max free-debate rounds (default: 2).
- `summaryPrompt`: Optional. If provided, generates a summary (discussion) or consensus report (debate).
- `enableVoting`: (Debate only) Whether to include a voting phase (default: false).

## Examples

### Discussion

```json
{
  "mode": "discussion",
  "topic": "How should we optimize our database for high concurrency?",
  "participants": [
    {
      "profileName": "coder",
      "roleDescription": "You are a database researcher who specializes in connection pooling and query optimization."
    },
    {
      "profileName": "coder",
      "roleDescription": "You are a systems architect who focuses on scalability and distributed systems."
    }
  ],
  "maxRounds": 3,
  "summaryPrompt": "Summarize the key decisions and action items from this discussion."
}
```

### Debate

```json
{
  "mode": "debate",
  "topic": "Should we migrate from REST to GraphQL?",
  "participants": [
    {
      "profileName": "coder",
      "roleDescription": "You are a senior backend engineer who values simplicity and proven patterns.",
      "assignedStance": "Argue against GraphQL migration — REST is sufficient"
    },
    {
      "profileName": "coder",
      "roleDescription": "You are a frontend architect frustrated by over-fetching and multiple round-trips.",
      "assignedStance": "Argue for GraphQL — it solves real pain points"
    },
    {
      "profileName": "coder",
      "roleDescription": "You are a DevOps engineer focused on operational cost and observability."
    }
  ],
  "maxRounds": 3,
  "summaryPrompt": "List points of consensus, remaining disagreements, and recommend a decision.",
  "enableVoting": true
}
```

## Behavior

### Discussion
- Each participant receives the full discussion transcript before their turn.
- Participants speak naturally — no special tools or communication primitives needed.
- The discussion ends after `maxRounds` rounds.
- Results include the full transcript, summary, and aggregate token usage.

### Debate
- **Phase 1 — Opening Statements**: Each participant presents their initial stance.
- **Phase 2 — Free Debate**: Multiple rounds of back-and-forth; participants challenge, support, and refine positions.
- **Phase 3 — Closing Arguments**: Each participant delivers a final summary.
- **Phase 4 — Consensus** (optional): Extract agreed/disagreed points, key insights, and action items.
- Cross-references between participants are automatically detected (e.g. @speaker, "as X said").
- Position changes are tracked across the debate.
- Results include the full transcript, phase breakdown, consensus report, cross-reference count, and position changes.