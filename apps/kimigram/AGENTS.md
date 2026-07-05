# Agent Instructions

This project follows **Extreme Programming (XP)** and **SOLID** design principles. All work is iterative, test-driven, simple, continuously integrated, and architected for maintainability.

This project uses **br** (beads) for issue tracking. Run `br onboard` to get started.

## Quick Reference

```bash
br ready              # Find available work
br show <id>          # View issue details
br update <id> --status in_progress  # Claim work
br close <id>         # Complete work
br sync               # Sync with git
```

## Extreme Programming (XP) Directives

### 1. Test-Driven Development (TDD)
- **Write a failing test before production code.** Every behavior change starts with a test that fails.
- **Red → Green → Refactor.** Make the test pass with the simplest code, then refactor while keeping tests green.
- **All bugs get a test first.** Reproduce every defect as a failing test, then fix it.
- **Never commit with failing tests.** Local test suite must be green before any commit.
- **Keep tests fast and automated.** Tests must run quickly enough to execute on every change.

### 2. Simple Design
- **Do the simplest thing that could possibly work.** Avoid speculative abstraction, premature generalization, and unused configurability.
- **YAGNI.** Implement only what the current story or task requires.
- **Eliminate duplication.** If you see duplication, refactor it away.
- **Keep code expressive.** Names, functions, and modules should clearly reveal intent.
- **Minimal changes.** Prefer small, focused edits over large refactors.

### 3. Continuous Refactoring
- **Refactor continuously, not in batches.** Clean up smells as you encounter them, but only when tests are green.
- **Never change behavior without tests.** Lock behavior down with tests before refactoring.
- **Preserve existing contracts.** If an interface must change, update all callers and tests together.
- **Leave code cleaner than you found it.** Within the scope of the current task.

### 4. Pair Programming Mindset
- **Explain decisions out loud.** Before editing, briefly state what you will do and why.
- **Ask clarifying questions.** If a requirement is ambiguous, stop and ask rather than guessing.
- **Welcome review.** Present alternatives with trade-offs when multiple valid approaches exist.
- **Switch perspectives.** Consider what a reviewer or future maintainer would need to understand the change.

### 5. Continuous Integration
- **Integrate small changes frequently.** Prefer many small commits over few large ones.
- **Keep the build green.** If tests or lint fail, fixing them is the top priority.
- **Run quality gates before finishing.** Tests, type checks, and lint must pass.
- **Push completed work.** Do not leave finished work stranded locally.

### 6. Iterative Planning & Small Releases
- **Work from the current task.** Use `br ready` and `br show` to see what is planned.
- **Deliver working software.** "Done" means tested, integrated, and shippable.
- **Avoid big upfront design.** Architecture emerges as requirements become clear.
- **Prefer vertical slices.** Deliver end-to-end functionality in thin slices rather than horizontal layers.

### 7. Collective Ownership & Standards
- **Anyone can improve any code.** If you see a bug, smell, or outdated doc in code you touch, fix it or file a task.
- **Follow existing conventions.** Match the surrounding code's style, naming, and structure.
- **Update documentation.** Keep READMEs, comments, and this AGENTS.md current with the code.
- **Tests are executable documentation.** Prefer clear tests and code over heavy external docs.

### 8. Sustainable Pace
- **Do not over-engineer.** Solve today's problem today.
- **Stop at working.** Once tests pass and the task is complete, resist adding "just in case" features.
- **Take breaks on blockers.** If stuck after reasonable effort, ask the user or file a spike task rather than forcing a solution.
- **Respect scope boundaries.** Defer out-of-scope ideas to future tasks with the user's agreement.

### 9. Customer Collaboration
- **Requirements come from the user.** Treat the user as the on-site customer.
- **Acceptance criteria define done.** A task is complete only when its acceptance criteria are verifiably met.
- **Feedback is fuel.** When the user steers the work, adapt the plan and communicate the impact.

## SOLID Design Directives

### 1. Single Responsibility Principle (SRP)
- **One reason to change per module.** Every class/module/function should do one thing well.
- **Separate concerns.** Do not mix business logic with I/O, logging, HTTP, database access, or UI rendering.
- **Ban vague names.** Avoid `Utils`, `Manager`, `Helper`, `Service` without qualifiers; prefer `EmailSender`, `PairingService`, `MarkdownFormatter`.
- **Ask before editing:** *"What would make this file change?"* If the answer involves multiple concerns, split it.

### 2. Open/Closed Principle (OCP)
- **Open for extension, closed for modification.** Add new behavior by adding new code, not by editing stable modules.
- **Prefer polymorphism/composition over switch chains.** Avoid growing `if (kind === '...')` or `switch(type)` blocks; introduce strategies or registries.
- **Define extension points.** Create interfaces for policies (e.g., `NotificationFormatter`, `TokenProvider`) and plug in implementations.
- **No "just one more case."** If you are repeatedly editing the same file to add variants, refactor to an extensible design.

### 3. Liskov Substitution Principle (LSP)
- **Subtypes must be substitutable.** A subclass or implementation must honor the contract of its supertype.
- **Do not override to disable behavior.** Never override a method to throw `not supported` or silently do nothing.
- **Avoid fake subtypes.** If a type cannot fully support an abstraction, use composition or a separate interface instead of inheritance.
- **Use TypeScript types to express optional capabilities.** Prefer small capability interfaces over bloated base classes.

### 4. Interface Segregation Principle (ISP)
- **Clients should not depend on methods they do not use.** Keep interfaces small and focused.
- **Split fat interfaces.** If some implementations cannot reasonably support every method, break the interface apart.
- **Depend on the minimal interface.** Constructor parameters and function args should use the narrowest type that satisfies the caller's needs.
- **Design from the client's perspective.** Expose only the subset of operations each caller needs.

### 5. Dependency Inversion Principle (DIP)
- **Depend on abstractions, not concretions.** High-level modules depend on interfaces/types, not concrete implementations.
- **Use constructor/parameter injection.** Do not `new` up dependencies inside business logic; inject them from the composition root.
- **Separate policy from details.** Domain code defines workflows; infrastructure implements HTTP, DB, filesystem, Telegram API details.
- **Inject at the edges.** `src/index.ts` or a dedicated composition root wires concrete implementations; core modules remain framework-agnostic.

### SOLID Review Checklist
Before finishing a task, verify:
- [ ] **SRP:** Does each module/file have one clear responsibility?
- [ ] **OCP:** Am I adding behavior by extending rather than modifying existing code?
- [ ] **LSP:** Do subtypes/implementations honor their contracts without surprises?
- [ ] **ISP:** Are interfaces small enough that clients use every method they depend on?
- [ ] **DIP:** Does high-level code depend on abstractions, not concrete libraries or frameworks?

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   br sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
