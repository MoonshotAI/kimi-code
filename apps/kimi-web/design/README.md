# Kimi Web · Design Documents

This directory holds the design system and visual specs for `apps/kimi-web`.

## Canonical reference

- **`design-system.html`** — the design system and visual spec. **Read this before changing any UI.** It documents:
  - Design principles (impeccable.style + core UI/UX rules)
  - Audit of the current inconsistencies (with file paths)
  - Design tokens: color, typography, spacing, radius, elevation, z-index, motion, fonts (§03)
  - Component primitives with high-fidelity previews (§04)
  - Chat UI spec (§05)
  - Theme system: one theme driven by 4 color seeds + light/dark surfaces (§06)
  - Migration plan + anti-pattern (slop) detector rules (§07–§08)

  Open it in a browser: `open apps/kimi-web/design/design-system.html`.

## Supporting documents

- `implementation.md` — implementation plan, token/component API, anti-pattern rules, and the parallel execution order. Reference for *how* to implement the design; the visual target is always `design-system.html`.
- `prompt-redo.md` — the current orchestrator prompt for implementing the design system (visual-first + self-verifying, one-shot).
- `prompt.md` — earlier (superseded) orchestrator prompt, kept for history.

## Rule

When modifying the web UI, `design-system.html` is the authoritative reference. See the "Design system (normative)" section in `../AGENTS.md`.
