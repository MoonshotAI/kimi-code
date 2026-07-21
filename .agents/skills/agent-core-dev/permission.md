# Topic — Permission

The target design for the agent-core permission system. Read this when touching `permission`, `permissionMode`, `permissionRules`, or when adding a new permission dimension.

> **The permission system should be a composable, registrable chain of responsibility (a microkernel).** The kernel only runs the chain in order, first hit wins; concrete permission dimensions (policies) are contributed by their owning Domain Services through a registry; tools only declare standardized resource access (`accesses`) in `resolveExecution`, and generic dimensions consume that metadata.
>
> **The chain adjudicates risk only.** A policy node answers "how dangerous is this call, and may the user override that judgment?" — its `ask`/`deny` outcomes are always user-overridable. **Harness constraints are not permissions**: a mechanism that limits the agent for its own correctness (plan-mode write guard, AgentSwarm batch exclusivity, btw side-question fork, goal budget rejection) produces a hard deny with no ask channel and no per-call user exemption. Those live in their owning domains as `onBeforeExecuteTool` hooks ordered `before: 'permission'` (precedent: `goalService.ts`'s `goal-budget-reject`). Product reviews (plan review, goal-start review) are likewise not permissions: the owning domain intercepts its tool and drives the shared `IAgentToolApprovalService` round-trip itself.
>
> **Do not introduce Casbin** — the hard part here is *decision behavior* (continuations, side effects, RPC, state machines), not "match + scalar decision".

## 1. Problem definition

The permission system answers one question: **for each tool call, in the current agent and current mode — allow / deny / ask the user?** Three traits shape the architecture:

1. **Decisions carry behavior.** Returning `ask` is not an enum value — it is a workflow with an RPC round-trip, hooks, telemetry, state writes, and a continuation; returning `deny` may be the result of running an external hook.
2. **Heterogeneous policies.** Some check a tool-name set, some count same-batch `AgentSwarm` calls, some run a hook, some inspect the plan state machine — no uniform `(sub, obj, act)` shape.
3. **Multi-agent × multi-mode × external extension.** Different agents / modes need different permissions, and outsiders (org admins, plugins) must contribute rules or behavior in a decoupled way.

## 2. Current state (v1) at a glance

Code lives in `packages/agent-core/src/agent/permission/`.

- **Architecture: ordered chain of responsibility, first hit wins.** `PermissionManager` holds `PermissionPolicy[]`; evaluation iterates in order, the first non-`undefined` result wins.
- **`PermissionPolicyResult` is a behavior bundle, not a scalar:** `approve` (with `executionMetadata`), `deny` (with `message`), or `ask` (with `resolveApproval` / `resolveError` continuations).
- **11 dimensions, 19 policies**, hardcoded in `policies/index.ts#createPermissionDecisionPolicies()`. Order is a high-to-low safety cascade: external force → structural deny → state-machine deny → static deny → mode allow → session-memory allow → static ask → static allow → flow allow → sensitive-path ask → default allow → fallback ask.
- **Resource-access declaration:** tools declare accessed resources in `resolveExecution(input)` via `accesses` (`ToolAccesses`, currently `file` and `all`); generic dimensions read `context.execution.accesses`.

### v1 pain points the target design fixes

1. The chain is hardcoded — outsiders cannot contribute.
2. `mode` is an `if` inside each policy (`YoloModeApprove` / `AutoModeApprove` self-guard).
3. No per-agent chain entry point (only scattered `agent.type === 'sub'` checks).
4. No external extension point beyond the single `PreToolUse` hook slot.

## 3. Why not Casbin

- **`policy_effect` is unusable** — composition here is a fixed, intentionally hardcoded safety cascade; the real complexity lives in each policy's `evaluate` behavior, which a Casbin expression cannot absorb. Externally tunable safety knobs are already exposed via `mode` + allow/deny/ask rules.
- **Flexible priority is unusable** — there is no plugin injection point, no multi-subject/RBAC, and a fixed subject (agent/user), so priority collisions do not arise. Casbin's `(sub, obj, act)`, `g()`, and domains would idle.
- **Fundamental mismatch: decisions are not scalars.** `enforce()` maps a request to an effect; agent-core decisions are behavior bundles (continuations, side effects, synthesized results). Even if Casbin computed `ask`, the surrounding behavior would still need to be rewritten — Casbin would degrade to an enum generator.
- **When Casbin becomes worth it:** when the hard part is matching semantics itself — role inheritance, domain isolation, ABAC expressions, policies loaded from a DB. Not before.

## 4. Design-pattern placement

Permission orchestration is a layered combination, not a single pattern:

| Layer | Pattern | Role |
|---|---|---|
| Runtime decision | **Chain of Responsibility** | multiple candidates in order; first hit wins, rest short-circuit |
| Single handler | **Strategy** | each policy is an interchangeable "permission adjudication" algorithm |
| Assembly / external extension | **Plugin / Microkernel** | minimal kernel + explicit extension points + pluggable policies |
| Landing support | **Registry + Factory** | collect plugins; assemble the chain per `(agent, mode)` on demand |

Casbin = single Strategy + data-driven. This design = multiple Strategies + chain-of-responsibility composition. Behavior-heavy systems must choose the latter — behavior cannot be flattened into data rows.

## 5. Target design

### 5.1 Core principles

1. **The chain encodes "permission dimensions", not "tools".** Adding a tool does not lengthen the chain; only adding a dimension adds a node.
2. **Two contribution paths:** high-frequency trivial specifics go through the **data path** (rules); low-frequency new dimensions with behavior go through the **code path** (policies).
3. **Guard/review off-chain, risk on-chain:** harness constraints and product reviews ship with their owning domain as executor hooks (§5.4); risk dimensions contributed by a domain self-register as chain policies in DI, mirroring v2's "domain self-registers tools".
4. **Tools declare resources; generic dimensions consume them:** bash/write/read only declare `accesses`; file/security dimensions judge centrally.

### 5.2 Core abstractions

```ts
type Phase =
  | 'guard' | 'user-deny' | 'mode' | 'session'
  | 'user-ask' | 'default' | 'fallback';

interface PermissionPolicyEntry {
  name: string;
  phase: Phase;
  modes?: PermissionMode[];        // declare which modes this applies in (no more in-evaluate if)
  agentTypes?: AgentType[];
  factory: (accessor: ServicesAccessor) => PermissionPolicy;
}

// App scope — collects every domain's registration
interface IPermissionPolicyRegistry {
  register(entry: PermissionPolicyEntry): IDisposable;
  list(): readonly PermissionPolicyEntry[];
}
```

`PermissionPolicyService` (Agent scope) changes from a hardcoded list to "assemble by `(agent, mode)`":

```ts
this.policies = registry.list()
  .filter(e => !e.modes    || e.modes.includes(mode))
  .filter(e => !e.agentTypes || e.agentTypes.includes(agentType))
  .sort(byPhaseThenRegistrationOrder)
  .map(e => e.factory(accessor));
```

Key points:

- `modes` / `agentTypes` are **declarations** — they lift the `if (mode !== 'yolo') return` out of `YoloModeApprove` into metadata.
- `factory`, not `instance`: a node may depend on agent-scoped services (mode, rules) and must be instantiated in the Agent scope — symmetric to `IToolDefinitionRegistry` (App) storing factories and `IToolService` (Agent) instantiating tools.
- **Different `(agent, mode)` produce differently-shaped chains** — under yolo the ask/fallback phases are physically filtered out.

### 5.3 Two contribution paths

| What is being added | Path | Chain length |
|---|---|---|
| New tool, new org rule, new user preference ("deny `Bash(curl *)`") | **Data path**: add a `PermissionRule` to an existing node | unchanged |
| New cross-cutting behavior (custom approval UI, audit log, new mode) | **Code path**: register a new policy node | +1 |

Most growth goes through the data path — node count is bounded by "kinds of behavior"; rule count grows with specifics (rule matching is a cheap Set/glob).

### 5.4 Domain dimensions: guard/review via executor hooks, policy registration for risk

**Harness constraints and product reviews no longer live on the chain.** A domain that owns one registers an executor hook ordered `before: 'permission'` and decides for itself:

```ts
// src/plan/planService.ts — constructor
constructor(@IAgentPermissionGate _gate, @IAgentToolExecutorService executor, ...) {
  executor.hooks.onBeforeExecuteTool.register('plan-guard', handler, { before: 'permission' });
}
```

- Injecting `IAgentPermissionGate` (unused, `_`-prefixed) forces the gate to be constructed first, so the `'permission'` hook target always exists — the built-in tools registrar can otherwise construct the domain service before the gate is ignited.
- **Guard** (hard deny): set `ctx.decision = { block: true, reason: toolApproval.formatDenyMessage(...) }` and do not call `next()`. Short-circuiting a *deny* ahead of the chain is correct — these policies sat at the head of the chain anyway.
- **Review** (product approval): intercept the tool, drive `IAgentToolApprovalService.requestToolApproval(ctx, ask, origin)` and fold the continuation into `ctx.decision`; pass `next()` for every case you do not review so user rules still apply.
- **Plain allow**: do NOT short-circuit approvals in the hook — put the tool in `default-tool-approve`'s whitelist and `next()`, so user deny/ask rules keep their precedence.

**Risk dimensions contributed by a domain still go through the chain** (the registry path below): a domain whose state changes the *risk* verdict registers its policy via `IPermissionPolicyRegistry`, mirroring v2's "domain self-registers tools". A complex domain may register a single **composite** node externally and run a small internal chain, hiding its internal order from the global chain.

### 5.5 Tools declare resources at runtime (`resolveExecution` / `accesses`)

In `resolveExecution(input)`, before execution, declare accessed resources with the `ToolAccesses.*` builders:

```ts
resolveExecution(args: WriteInput): ToolExecution {
  const path = resolvePathAccessPath(args.path, { kaos, workspace, operation: 'write' });
  return {
    accesses: ToolAccesses.writeFile(path),            // declares: write this file
    approvalRule: literalRulePattern(this.name, path),
    matchesRule: (ruleArgs) => matchesPathRuleSubject(ruleArgs, path, ...),
    execute: () => this.execution(args, path),
  };
}
```

Current resource types:

```ts
type ToolResourceAccess =
  | { kind: 'file'; operation: 'read'|'write'|'readwrite'|'search'; path: string; recursive?: boolean }
  | { kind: 'all' };   // non-enumerable side effects (pessimistic, globally exclusive)
```

Two complementary channels:

- **Enumerable resources** (write/read/edit/grep/glob) → use `accesses`; generic file dimensions cover them automatically.
- **Non-enumerable resources** (bash running arbitrary commands) → do not declare `accesses`; use the `matchesRule` DSL (e.g. `Bash(rm *)` globs by command string).

**kaos's role:** kaos is the execution-environment abstraction (fs/process/pathClass) used by the file dimension for path normalization and judgment — it is **not** the permission-dimension abstraction itself. Permission semantics live one layer above kaos, at "file access".

**v2 evolution:** extend the `ToolResourceAccess` union so non-file resources can be declared structurally:

```ts
type ToolResourceAccess =
  | { kind: 'file';      operation: FileOp; path: string; recursive?: boolean }
  | { kind: 'network';   operation: 'connect'; host: string }
  | { kind: 'shell';     command: string }
  | { kind: 'datastore'; operation: 'read'|'write'; table: string }
  | { kind: 'all' };
```

Each new resource kind can pair with a generic dimension that consumes it; tools always only **declare**.

### 5.6 Dimension ownership

| Dimension | Owner | Type |
|---|---|---|
| external hook veto | `externalHooks` domain | generic |
| tool-batch exclusivity | `swarm` domain — executor hook `swarm-exclusive` | harness constraint (off-chain) |
| plan-mode write guard | `plan` domain — executor hook `plan-guard` | harness constraint (off-chain) |
| plan review | `plan` domain — same hook + `toolApproval` | product review (off-chain) |
| goal-start review | `goal` domain — executor hook `goal-start-review` + `toolApproval` | product review (off-chain) |
| goal budget rejection | `goal` domain — executor hook `goal-budget-reject` | harness constraint (off-chain) |
| btw tool disablement | `btw` domain — executor hook `btw-deny-all` on the fork | harness constraint (off-chain) |
| runtime-mode posture (auto/yolo) | `permissionMode` domain (chain nodes, pending the level×routing split) | generic |
| static config rules | `permissionRules` domain | generic (data path) |
| session approval memory | `permissionRules` domain | generic |
| sensitive / special paths | generic "file-access/security" dimension | generic (consumes `accesses`) |
| tool intrinsic risk | core permission (`default-tool-approve`) | generic (consumes tool declarations) |
| workspace write trust | generic "file-access/security" dimension | generic (consumes `accesses`) |
| fallback | core permission | generic |
| approval round-trip | `toolApproval` domain — shared by gate asks and domain reviews | infrastructure |

Pattern: **harness constraints and reviews ship with their owning domain as executor hooks; risk dimensions ship as chain policies (self-registered once the registry lands); generic dimensions register centrally and apply across tools via the declared `accesses`.**

## 6. Evolution path

Incremental, not big-bang:

1. ~~**Sink domain dimensions.**~~ **Done** — plan guard/review, goal-start review, swarm batch exclusivity, and btw deny-all moved out of the chain into their owning domains as executor hooks ordered `before: 'permission'`; the shared approval round-trip was extracted to `IAgentToolApprovalService`; `registerPolicy` was removed (btw was its only production user). The chain now holds 12 risk-adjudication nodes only.
2. **Level × routing split.** Separate "risk level" (read-only / read-write / yolo posture — what `yolo-mode-approve` really is) from "interaction routing" (what `auto-mode-approve` / `auto-mode-ask-user-question-deny` really are: route permission asks and reviews without the user). The routing layer lands on the `session/approval` broker; the three remaining mode policies leave the chain here.
3. **Registry + Composer.** Replace the hardcoded `new`s in `PermissionPolicyService` with reads from `IPermissionPolicyRegistry`; lift mode guards into `modes` metadata. Chain shape becomes selectable per `(agent, mode)` and externally extensible.
4. **(On demand) extend resource types.** When non-file resources (network/DB/shell) need structural dimensions, extend the `ToolResourceAccess` union.
5. **(On demand) swap the matching kernel for Casbin.** Only when external rules genuinely need RBAC/ABAC semantics, swap the data-path rule-matching kernel for Casbin. Not before.

## Red lines (this topic)

- Do not introduce Casbin — decisions are behavior bundles, not scalar effects.
- The chain adjudicates risk only. A node whose deny/ask the user cannot per-call exempt is a harness constraint: implement it as an executor hook ordered `before: 'permission'` in the owning domain, never as a chain policy.
- Product reviews (plan/goal) are not permissions either: the owning domain intercepts its tool and drives `IAgentToolApprovalService` itself; the gate only handles chain asks.
- When registering such a hook, inject `IAgentPermissionGate` (unused) so the gate exists before you order `before: 'permission'`.
- The chain encodes dimensions, not tools: a new tool must not lengthen the chain.
- New specifics go through the data path (rules); only new risk behavior goes through the code path (a policy node).
- Tools only declare `accesses`; generic dimensions consume them. kaos is the execution environment, not the permission abstraction.
- Use `factory` (Agent-scope instantiation), not `instance`, for registered policies.
