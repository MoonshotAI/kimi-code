# Topic — Permission

The target design for the agent-core permission system. Read this when touching `permission`, `permissionMode`, `permissionRules`, or when adding a new permission dimension.

> **The permission system should be a composable, registrable chain of responsibility (a microkernel).** The kernel only runs the chain in order, first hit wins; concrete permission dimensions (policies) are contributed by their owning Domain Services through a registry; tools only declare standardized resource access (`accesses`) in `resolveExecution`, and generic dimensions consume that metadata.
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
3. **Domain self-registration:** a domain that owns a dimension (plan/goal/swarm) registers its policy in DI, mirroring v2's existing "domain self-registers tools".
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

### 5.4 Domain self-registration

Mirrors v2's "domain registers tools in its constructor". `PlanService` self-registers its dimensions:

```ts
// src/plan/planService.ts
constructor(@IPermissionPolicyRegistry registry: IPermissionPolicyRegistry) {
  registry.register({ name: 'plan-mode-guard-deny', phase: 'guard',
    factory: a => new PlanModeGuardDenyPolicy(a.get(IPlanService)) });
  registry.register({ name: 'plan-mode-tool-approve', phase: 'mode',
    factory: a => new PlanModeToolApprovePolicy(a.get(IPlanService)) });
  registry.register({ name: 'exit-plan-mode-review-ask', phase: 'user-ask',
    factory: a => new ExitPlanModeReviewAskPolicy(a.get(IPlanService), a.get(IPermissionModeService)) });
}
```

A complex domain may register a single **composite** node externally and run a small internal chain, hiding its internal order from the global chain.

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

| Dimension | Owner (who registers) | Type |
|---|---|---|
| external hook veto | `externalHooks` domain | generic |
| tool-batch exclusivity | `swarm` domain | domain-specific (ships with the AgentSwarm tool) |
| runtime-mode posture | `permissionMode` domain | generic |
| plan-mode constraints | `plan` domain | domain-specific |
| goal-start approval | `goal` domain | domain-specific |
| static config rules | `permissionRules` domain | generic (data path) |
| session approval memory | `permissionRules` domain | generic |
| sensitive / special paths | generic "file-access/security" dimension | generic (consumes `accesses`) |
| tool intrinsic risk | core permission | generic (consumes tool declarations) |
| workspace write trust | generic "file-access/security" dimension | generic (consumes `accesses`) |
| fallback | core permission | generic |

Pattern: **specific dimensions ship with their owning domain + tool; generic dimensions register centrally and apply across tools via the declared `accesses`.**

## 6. Evolution path

Incremental, not big-bang:

1. **Registry + Composer (zero behavior change).** Replace the 19 hardcoded `new`s in v2 `PermissionPolicyService` with reads from `IPermissionPolicyRegistry`; register existing policies as-is. Immediately gain multi-agent/mode selectable chains and an external registration entry.
2. **Declarative modes.** Lift the mode guards in `YoloModeApprove` / `AutoModeApprove` into `modes` metadata.
3. **Sink domain dimensions.** Move registration of plan/goal/swarm policies into their owning domain service constructors.
4. **(On demand) extend resource types.** When non-file resources (network/DB/shell) need structural dimensions, extend the `ToolResourceAccess` union.
5. **(On demand) swap the matching kernel for Casbin.** Only when external rules genuinely need RBAC/ABAC semantics, swap the data-path rule-matching kernel for Casbin. Not before.

## Red lines (this topic)

- Do not introduce Casbin — decisions are behavior bundles, not scalar effects.
- The chain encodes dimensions, not tools: a new tool must not lengthen the chain.
- New specifics go through the data path (rules); only new behavior goes through the code path (a policy node).
- A domain that owns a dimension self-registers its policy in DI; do not centralize domain policies in core.
- Tools only declare `accesses`; generic dimensions consume them. kaos is the execution environment, not the permission abstraction.
- Use `factory` (Agent-scope instantiation), not `instance`, for registered policies.
