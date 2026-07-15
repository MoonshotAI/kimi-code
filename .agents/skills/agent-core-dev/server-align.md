# Subskill — Server align (expose `agent-core-v2` over `server-v2`)

Wire a v2 domain into `packages/kap-server`, and — when the endpoint is part of the established `/api/v1` wire contract — keep the wire shape **byte-for-byte compatible** with what released v1 clients expect. This is the server-side counterpart of [align.md](align.md): `align.md` ports v1 *business logic* into v2; this file exposes the v2 result over HTTP / WS, reusing the v1 wire contract where it already exists.

Use this when the task is "expose the new v2 Service on the server", "add a `/sessions/:sid/...` route to the `/api/v1` surface", or "keep server-v2 speaking the same `/api/v1` contract released clients rely on".

## The one-paragraph mental model

`server-v2` serves **two HTTP surfaces** off the same `agent-core-v2` scope tree:

- **`/api/v2/:sa`** — the native v2 RPC surface, driven by the `actionMap` allowlist (`packages/kap-server/src/transport/actionMap.ts`). One `resource:action` segment maps to one `Service.method`. New v2-native capabilities land here. See [edge-exposure.md](edge-exposure.md).
- **`/api/v1/...`** — the v1-compatible surface, hand-written routes in `packages/kap-server/src/routes/*.ts` that **implement the established v1 wire contract path-for-path and schema-for-schema**, mounted by `registerApiV1Routes.ts`. This surface IS the v1 contract now (the legacy v1 server is gone); it exists so existing v1 clients keep working against server-v2 unchanged.

The two surfaces can point at **different Services** for the same feature. v2's native `IAgentPromptService` serves `/api/v2`; a v1-shaped `IAgentPromptService` serves `/api/v1`. Keeping them separate is what lets v2's domain design stay clean while the wire stays compatible.

## Decision: which surface?

```text
Is the endpoint part of the established /api/v1 wire contract (the established wire schema
+ released-client expectation)?
├─ YES → /api/v1 mirror route (this file, §schema-fidelity + §legacy-service).
│         Reuse the established wire schema; add a LegacyService if v2 semantics diverge.
└─ NO  → /api/v2 native action (edge-exposure.md).
         Add to actionMap, wrapping in a facade if the method fails §2 there.
```

A feature often needs **both**: the v1 mirror so old clients keep working, and the v2 action so new clients get the cleaner shape. Do them as two routes / two action-map entries over the same scope tree.

## The server-align workflow

```text
Pick surface → Read the v1 route (if any) → Reuse / add the wire schema
→ Choose native Service vs LegacyService → Wire the route / actionMap entry
→ Map errors → Test against the v1 wire shape → Verify
```

### 1. Pick the surface

Apply the decision above. For a v1-matched endpoint, the **spec** is the established wire schema plus the existing mirror routes:

- The schema in its owning home — the backing `agent-core-v2` domain's contract, or `packages/kap-server/src/wire/` for v1-only shapes.
- `packages/kap-server/src/routes/<resource>.ts` — the file you are writing (create it if missing); sibling route files show the conventions.

The shared schema is the source of truth. Do not re-derive the wire shape from memory or from the v2 domain model.

### 2. Reuse (or add) the wire schema

The v1 wire schemas have two homes, both inside this repo's v2 chain — never
re-declare them inline in a route:

- **Engine-owned contracts** — DTOs the engine's own services speak live in
  the `agent-core-v2` domain that backs the endpoint (e.g. the fs DTO schemas
  in `session/sessionFs/fs.ts`, the session wire DTOs in
  `app/sessionLegacy/sessionWire.ts`, OAuth DTOs in `app/auth/oauthWire.ts`).
  Import them into the route via the leaf path
  (`@moonshot-ai/agent-core-v2/...`).
- **Server-owned v1-only schemas** — shapes only the v1 transport needs
  (envelope, numeric `ErrorCode`, pagination, `sessionSchema`, task/tool/
  skill/question/approval models, the `rest-*` endpoint schemas, the WS
  `ws-control` catalog) live in `packages/kap-server/src/wire/`.

Actions:

- **Schema already in one of these homes** → import it in the server-v2 route
  and use it in `defineRoute` (`body`, `success.data`, error `dataSchema` /
  `detailsSchema`). Do **not** re-declare the schema inline in server-v2.
- **Schema missing, and the engine's service speaks the shape** → add it to
  the owning `agent-core-v2` domain's contract (as a zod schema with an
  inferred type), then consume it from the route.
- **Schema missing and only the v1 edge needs it** → add it to the matching
  `packages/kap-server/src/wire/` module; do not push v1-only shapes into the
  engine.

#### Schema-fidelity rule (the hard rule)

For a `/api/v1` endpoint, the request and response schemas **must be the
established wire schema** (or a strict superset):

- ✅ **Adding** an optional field is allowed (`field: z.string().optional()`). Old clients ignore it; new clients may send it.
- ❌ **Renaming** a field, **changing** its type, **tightening** its validation, or **changing its meaning** is a wire break — do not do it in a mirror route. If the v2 domain genuinely needs a different shape, that shape belongs on `/api/v2`, not on the `/api/v1` mirror.
- ❌ Re-declaring the schema inline in server-v2 (even if it "looks identical") is forbidden — it drifts. One schema, one home: the owning v2 domain, or `kap-server/src/wire` for v1-only shapes.

Self-check: "would a released v1 client get a byte-identical envelope from `packages/kap-server` for this request?" If you cannot answer yes from the shared schema, the route is wrong.

### 3. Choose native Service vs LegacyService

Resolve the v2 Service that will back the route. Two cases:

**Case A — the v2 native Service already matches the v1 contract.** Use it directly. Most data/command Services (`IConfigService`, `IWorkspaceRegistry`, `IApprovalService`, `IQuestionService`, `IFileStore`, …) land here: the route is a thin adapter that resolves the scope, calls the method, and wraps the result. Examples: `routes/config.ts`, `routes/messages.ts`, `routes/questions.ts`, `routes/files.ts`.

**Case B — the v1 contract needs behavior that would distort the v2 domain.** Introduce a **`*LegacyService`** — an L7 edge adapter that implements the v1 contract **on top of** the v2 native Service, leaving the native Service untouched. The v2 native Service keeps serving `/api/v2`; the LegacyService serves `/api/v1`.

Reach for a LegacyService when **any** hold:

- The v1 endpoint carries state the v2 domain deliberately dropped (e.g. a FIFO queue, a `prompt_id`, idempotent `abort`/`steer`, auto-start-next).
- The v1 method returns a handle/stream that v2 wraps differently, and the v1 clients expect the old envelope shape.
- Matching v1 would force a `Map<sessionId, …>`-at-`App` anti-pattern or a scope/domain-direction violation into the native Service (see [align.md](align.md) red lines).
- The native Service's error set / return type would have to grow v1-only branches.

Do **not** put v1 quirks into the native v2 Service "to keep the route simple". That is the conflict this rule exists to prevent: the native Service serves the v2 architecture; the LegacyService serves the wire contract.

#### LegacyService recipe

A LegacyService is a normal v2 Service (service-authoring.md) with one extra convention: its contract is shaped by the **v1 wire** types, not by the v2 domain model.

```text
packages/agent-core-v2/src/<domain>Legacy/
├── <domain>Legacy.ts          ← contract: v1-wire-typed interface + decorator
├── <domain>LegacyService.ts   ← impl: delegates to the native v2 Service(s)
└── errors.ts                  ← v1-compatible error codes (KimiError codes)
```

Skeleton (matches `prompt/`):

```ts
// prompt.ts — contract shaped by the v1 wire DTOs (defined in this domain)
import type { PromptSubmitResult, PromptSubmission } from './promptWire';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentPromptService {
  readonly _serviceBrand: undefined;
  submit(body: PromptSubmission): Promise<PromptSubmitResult>;
  // ...the rest of the v1 contract, typed by the v1 wire
}
export const IAgentPromptService: ServiceIdentifier<IAgentPromptService> =
  createDecorator<IAgentPromptService>('agentPromptLegacyService');
```

```ts
// promptService.ts — impl delegates to the native v2 Service
constructor(@IAgentPromptService private readonly prompt: IAgentPromptService /*, ... */) {}
// submit() builds v2-native input, calls the native Service, projects the result
// back into the wire PromptSubmitResult.

registerScopedService(
  LifecycleScope.Agent,            // scope = the lifetime of the legacy state
  IAgentPromptService,
  AgentPromptLegacyService,
  InstantiationType.Delayed,
  'prompt',
);
```

Conventions:

- **Name** the domain `<domain>Legacy` and the interface with the scope prefix, `I<Scope><Domain>LegacyService` (e.g. `prompt` / `IAgentPromptService`), per service-authoring.md.
- **Header comment** must say it is an `L7 edge adapter` and name both the v1 contract it implements and the native v2 Service it leaves untouched (see `prompt.ts`).
- **Scope** = the lifetime of the *legacy* state it holds (the `prompt` queue is per-agent → `LifecycleScope.Agent`). Apply [orient.md](orient.md) / [design.md](design.md) normally — a LegacyService is not exempt from scope rules.
- **Delegate, do not duplicate** business logic. The LegacyService translates the v1 contract into native-Service calls and translates results back; the real work stays in the native Service.
- **Contract types come from the v1 wire schemas the domain owns** (zod in the domain contract, types inferred), so the interface cannot drift from the wire shape.

### 4. Wire the route / actionMap entry

**For `/api/v1` (mirror):** add a route file under `packages/kap-server/src/routes/<resource>.ts` using `defineRoute`, then register it in `registerApiV1Routes.ts`. Resolve the scope from the URL (`session_id` → Session scope, agent → Agent scope via `IAgentLifecycleService.getHandle`), then `accessor.get(IX)` the native or Legacy Service. Match the established verbs, paths (`:sid` / `{session_id}`), and `parseActionSuffix` actions (`:steer`, `:abort`) exactly — sibling routes under `packages/kap-server/src/routes/` are the reference.

```ts
const route = defineRoute(
  {
    method: 'POST',
    path: '/sessions/{session_id}/prompts',
    body: promptSubmissionSchema,                 // ← v1 wire schema (v2 domain or kap-server wire/)
    params: sessionIdParamSchema,
    success: { data: promptSubmitResultSchema },  // ← v1 wire schema
    errors: {
      [ErrorCode.SESSION_NOT_FOUND]: {},
      [ErrorCode.SESSION_BUSY]: {},
      [ErrorCode.PROMPT_ALREADY_COMPLETED]: { dataSchema: z.object({ aborted: z.literal(false) }) },
    },
    operationId: 'submitPrompt',
    tags: ['prompts'],
  },
  async (req, reply) => {
    try {
      const result = await resolveLegacy(core, req.params.session_id).submit(req.body);
      reply.send(okEnvelope(result, req.id));
    } catch (error) {
      sendMappedError(reply, req.id, error);
    }
  },
);
app.post(route.path, route.options, route.handler);
```

**For `/api/v2` (native):** add a `resource:action` entry to `actionMap` ([edge-exposure.md](edge-exposure.md) §3). If the method fails the direct-exposure rules (returns a handle / stream / bytes, takes a live object), wrap it in a wire-shaped facade first (`IAgentRPCService` / `ISessionRPCService`) and map to the facade — as `prompts:*` does via `IAgentRPCService`.

### 5. Map errors

The route translates domain `KimiError` codes into the numeric wire `ErrorCode` numbers. Two registries must stay in sync:

- **Domain code** — register in `agent-core-v2/src/errors.ts` (`ErrorCodes`) and throw from the Service (errors.md). Co-located domain errors go in `<domain>Legacy/errors.ts` (e.g. `prompt.not_found`, `session.busy`).
- **Wire code** — register the matching number in `packages/kap-server/src/wire/error-codes.ts` and reference it in the route's `errors` map and `sendMappedError`.

```ts
function sendMappedError(reply, requestId, err) {
  if (isKimiError(err)) {
    switch (err.code) {
      case 'session.not_found':
      case 'agent.not_found':
        return reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId));
      case 'prompt.not_found':
        return reply.send(errEnvelope(ErrorCode.PROMPT_NOT_FOUND, err.message, requestId));
      // ...
    }
  }
  return reply.send(errEnvelope(ErrorCode.INTERNAL_ERROR, String(err), requestId));
}
```

Match the v1 route's status codes and idempotent-conflict envelopes (e.g. `prompt.already_completed` → `40903` with `{ data: { aborted: false } }`). The error envelope is part of the wire contract — it is covered by the same schema-fidelity rule.

### 6. Test against the v1 wire shape

Add a `packages/kap-server/test/<resource>.test.ts` that boots the server and hits the route. Assert on the **envelope + wire shape**, not on the v2 domain internals:

- success envelope `{ code: 0, data: <wire shape>, request_id }`;
- each declared error envelope `{ code: <ErrorCode>, msg, data, request_id }`;
- the fields v1 clients read are present with the same names/types.

Where the route mirrors v1, the test is the regression guard for the schema-fidelity rule: if someone drifts the wire schema or the projection, this test breaks.

### 7. Verify

- `pnpm -C packages/kap-server test` — server routes green.
- `pnpm -C packages/kap-server test` — server routes green (incl. any new wire-schema tests).
- `pnpm -C packages/agent-core-v2 test` — native + Legacy Service tests green.
- `pnpm -C packages/agent-core-v2 run lint:domain` — a LegacyService is still inside the domain layers (edge adapter, L7); it must not pull business code into the edge or invert scope direction.
- `pnpm -C packages/server-e2e ...` when a v1 parity scenario exists.

## Worked example — porting v1 `/sessions/:sid/prompts`

This is the reference alignment (commits `feat(server-v2): port v1 /sessions/:sid/prompts routes`, `feat(server-v2): return turn ids for prompt actions`). It shows all three decisions at once.

**The mismatch.** v1 `IPromptService` is a per-agent *scheduler*: it owns a FIFO queue, assigns `prompt_id`s, supports `steer`/`abort`, and auto-starts the next queued prompt when a turn settles. v2's native `IAgentPromptService` is a *turn driver*: a submission *is* a turn, there is no queue and no `prompt_id`. Forcing the queue into the v2 native Service would distort the v2 domain.

**The split.**

- `/api/v2` keeps the native shape — `prompts:submit` / `steer` / `undo` / `clear` / `cancel` map to `IAgentRPCService` (a wire facade over the v2 turn driver) in `actionMap`. The native `IAgentPromptService` is untouched.
- `/api/v1` gets an `AgentPromptLegacyService` (`prompt/`, `LifecycleScope.Agent`) that re-implements the v1 scheduler — queue, `prompt_id`, steer/abort, auto-start-next — **on top of** the native `IAgentPromptService`. The `/api/v1` routes consume the LegacyService.

**The schema.** Both surfaces import `promptSubmissionSchema` / `promptSubmitResultSchema` / `promptListResponseSchema` / `promptSteerRequestSchema` / `promptSteerResultSchema` / `promptAbortResponseSchema` from the shared v1 wire schemas. The `/api/v1` and `/api/v2` routes are therefore compatible with released clients by construction; the LegacyService projects v2 turn results back into those wire shapes.

**The errors.** v1 codes (`prompt.not_found`, `session.busy`, `prompt.already_completed`) are registered in `agent-core-v2` (`prompt/errors.ts`) and in kap-server's `wire/error-codes.ts`, then mapped in the route's `sendMappedError` — including the idempotent `prompt.already_completed` → `40903 { data: { aborted: false } }`.

**The lesson.** When the v1 contract and the v2 domain disagree, add an adapter (LegacyService) at the edge; do not let the wire contract leak into the native domain. The two surfaces share the wire schema but not the Service.

## Migration checklist

Before submitting a server-align change:

- [ ] Surface chosen deliberately: `/api/v1` mirror for a v1-matched endpoint, `/api/v2` for a new native capability (both if needed).
- [ ] For a `/api/v1` mirror, the route matches the established v1 contract (the established wire schema + sibling routes) path-for-path, verb-for-verb, action-for-action.
- [ ] Request and response schemas come from their owning home (the backing `agent-core-v2` domain's contract, or `packages/kap-server/src/wire/` for v1-only shapes); no inline re-declaration in server-v2.
- [ ] Existing schema fields are unchanged in name, type, and semantics; only optional fields added (if any).
- [ ] Native v2 Service left clean; v1-only behavior isolated in a `<domain>Legacy` / `I<Domain>LegacyService` edge adapter when the semantics diverge.
- [ ] LegacyService registered with the correct `LifecycleScope` and a header comment naming it an L7 edge adapter + the native Service it preserves.
- [ ] Domain error codes registered in `agent-core-v2`; wire codes registered in `packages/kap-server/src/wire/error-codes.ts`; route maps them in `sendMappedError`, matching v1's status codes and idempotent envelopes.
- [ ] Route resolves the scope from the URL by `accessor.get(IX)`; no cached scope; finishes before disposal.
- [ ] Tests assert the wire envelope + the established wire shape; schema-level guards added/updated where the route mirrors v1.
- [ ] `lint:domain` passes; the LegacyService did not invert scope or domain direction.

## Red lines (this subskill)

- One wire schema, one home: the owning `agent-core-v2` domain contract, or `packages/kap-server/src/wire/` for v1-only shapes. Never re-declare a v1 wire schema inline in server-v2.
- A `/api/v1` mirror route must keep every existing schema field's name, type, and semantics; only optional additions are allowed. A different shape belongs on `/api/v2`, not on the mirror.
- Do not distort the native v2 Service to satisfy a v1 quirk — add a `<domain>Legacy` edge adapter instead. The native Service serves the v2 architecture; the LegacyService serves the wire contract.
- A LegacyService is still a v2 Service: it follows scope, domain-direction, and DI rules. "Edge adapter" describes its role, not an exemption.
- The established wire schema (in its owning home) plus the existing mirror routes are the spec for a `/api/v1` route — match them; do not re-derive the wire shape from the v2 domain model or from memory.
- Register every new error code in **both** `agent-core-v2` and `packages/kap-server/src/wire/error-codes.ts`; an unmapped code is a wire break.
- Events stream over WS (`listen`), never over the REST mirror; do not invent REST polling for something v1 pushed as an event.
