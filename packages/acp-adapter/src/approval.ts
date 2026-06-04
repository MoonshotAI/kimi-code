import type {
  PermissionOption,
  RequestPermissionResponse,
  ToolCallContent,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type { ApprovalRequest, ApprovalResponse } from '@moonshot-ai/kimi-code-sdk';

import { displayBlockToAcpContent } from './convert';
import { acpToolCallId } from './events-map';

/**
 * Canonical option ids surfaced to the ACP client.
 *
 * The wire-level `PermissionOption.optionId` is opaque to the client (it
 * round-trips back in `RequestPermissionResponse.outcome.optionId`), so
 * the adapter is free to pick any stable string. These literals are the
 * single source of truth on both the build- and the parse-side; tests
 * import them rather than re-typing the strings.
 */
export const APPROVE_ONCE_OPTION_ID = 'approve_once';
export const APPROVE_ALWAYS_OPTION_ID = 'approve_always';
export const REJECT_OPTION_ID = 'reject';

/**
 * Phase 13.2 plan_review optionId namespace. Picked deliberately so the
 * `plan_*` prefix never collides with the canonical `approve_*` /
 * `reject` namespace nor with the question bridge's `q{n}_*` namespace.
 *
 *  - `plan_opt_<i>` — one per `display.options[i]` (rendered as
 *    `allow_once` in the ACP UI so the user can pick A / B / C without
 *    re-entering the prompt).
 *  - `plan_approve` — fallback approve when `display.options` is absent
 *    or has fewer than two entries (covers the "plan with no explicit
 *    selectable variants" branch).
 *  - `plan_revise` / `plan_reject_and_exit` — the two reject-side
 *    options surfaced in the TUI by `apps/kimi-code/src/tui/reverse-rpc/approval/adapter.ts:13`'s
 *    `PLAN_REJECT_CHOICES`. Order is preserved so Zed renders the same
 *    bottom-of-list ordering as the TUI.
 */
export const PLAN_APPROVE_OPTION_ID = 'plan_approve';
export const PLAN_REVISE_OPTION_ID = 'plan_revise';
export const PLAN_REJECT_AND_EXIT_OPTION_ID = 'plan_reject_and_exit';

function planOptOptionId(i: number): string {
  return `plan_opt_${i}`;
}

/**
 * The three canonical permission options surfaced to the ACP client for
 * a non-`plan_review` approval prompt.
 *
 * Order is load-bearing: ACP clients (Zed at the time of writing) render
 * the options top-to-bottom, so allow-once is the primary action,
 * allow-always is the secondary, and reject is the terminal/dangerous
 * action that should be hardest to click by accident.
 *
 * The `kind` field is used by clients to choose icons / styling; the
 * `name` is the human-readable label that surfaces in the UI and is
 * the value that round-trips back via `ApprovalResponse.selectedLabel`
 * (Phase 5.2). The list is `readonly` because callers treat it as a
 * constant lookup table — they do not mutate it.
 */
const CANONICAL_OPTIONS: readonly PermissionOption[] = [
  { optionId: APPROVE_ONCE_OPTION_ID, name: 'Approve once', kind: 'allow_once' },
  {
    optionId: APPROVE_ALWAYS_OPTION_ID,
    name: 'Approve for this session',
    kind: 'allow_always',
  },
  { optionId: REJECT_OPTION_ID, name: 'Reject', kind: 'reject_once' },
];

/**
 * Build the {@link PermissionOption}[] surfaced to the ACP client for
 * an approval prompt.
 *
 * Phase 13.2 adds a `plan_review` branch — when the request's display
 * block carries `kind: 'plan_review'`, the options expand to:
 *  - one `allow_once` option per `display.options[i]` (A / B / C), or a
 *    single `plan_approve` fallback when the policy did not supply ≥ 2
 *    discrete options;
 *  - the two `reject_once` exits `Revise` and `Reject and Exit`
 *    (order matches the TUI's `PLAN_REJECT_CHOICES`).
 *
 * For every other display kind, the function returns the canonical
 * 3-option list (`Approve once` / `Approve for this session` / `Reject`)
 * — Phase 5's behaviour, preserved verbatim.
 *
 * The `req` parameter is optional so that older callsites (notably
 * tests that built their own non-plan_review fixtures with no request
 * payload) continue to compile and exercise the canonical branch.
 */
export function approvalRequestToPermissionOptions(
  req?: ApprovalRequest,
): readonly PermissionOption[] {
  if (!req || req.display.kind !== 'plan_review') {
    return CANONICAL_OPTIONS;
  }
  const display = req.display;
  const approveOptions: PermissionOption[] =
    display.options !== undefined && display.options.length >= 2
      ? display.options.map((opt, i) => ({
          optionId: planOptOptionId(i),
          name: opt.label,
          kind: 'allow_once' as const,
        }))
      : [{ optionId: PLAN_APPROVE_OPTION_ID, name: 'Approve', kind: 'allow_once' as const }];
  return [
    ...approveOptions,
    { optionId: PLAN_REVISE_OPTION_ID, name: 'Revise', kind: 'reject_once' as const },
    {
      optionId: PLAN_REJECT_AND_EXIT_OPTION_ID,
      name: 'Reject and Exit',
      kind: 'reject_once' as const,
    },
  ];
}

/**
 * Translate an ACP {@link RequestPermissionResponse} into Kimi's
 * {@link ApprovalResponse}.
 *
 * Decision mapping (canonical / non-plan_review path — Phase 5):
 *  - `cancelled` outcome → `decision: 'cancelled'` (the client closed
 *    the prompt without selecting an option).
 *  - `approve_once`  → `decision: 'approved'` (no scope, one-shot).
 *  - `approve_always` → `decision: 'approved'` with `scope: 'session'`
 *    so the SDK installs a session-runtime allow rule for subsequent
 *    invocations of the same matcher.
 *  - `reject`        → `decision: 'rejected'`.
 *  - Any other optionId is treated as a defensive `rejected`: rejecting
 *    is strictly safer than approving for an unknown id.
 *
 * Phase 13.2 adds a plan_review branch: when `req.display.kind ===
 * 'plan_review'`, the `plan_opt_<i>` / `plan_approve` /
 * `plan_revise` / `plan_reject_and_exit` optionIds map directly to the
 * SDK-side approval discriminator, and the matched option's label is
 * attached as `selectedLabel` in-place (so
 * `exit-plan-mode-review-ask.ts:49`'s `selectedExitPlanModeOption`
 * lookup hits without a second pass through {@link attachSelectedLabel}).
 *
 * The `req` parameter is optional for backward compatibility with
 * callsites that built fixtures without a request — those exercise the
 * canonical 3-option mapping unchanged.
 */
export function permissionResponseToApprovalResponse(
  req: ApprovalRequest | undefined,
  response: RequestPermissionResponse,
): ApprovalResponse {
  if (response.outcome.outcome === 'cancelled') {
    return { decision: 'cancelled' };
  }
  const optionId = response.outcome.optionId;
  if (req?.display.kind === 'plan_review') {
    return mapPlanReviewOptionId(req.display, optionId);
  }
  switch (optionId) {
    case APPROVE_ONCE_OPTION_ID:
      return { decision: 'approved' };
    case APPROVE_ALWAYS_OPTION_ID:
      return { decision: 'approved', scope: 'session' };
    case REJECT_OPTION_ID:
      return { decision: 'rejected' };
    default:
      // Unknown optionId — defensive fallback. Reject is safer than
      // approve. Logging is the caller's responsibility (the mapper is
      // pure so unit tests don't need to mock a logger).
      return { decision: 'rejected' };
  }
}

/**
 * Map a plan_review {@link RequestPermissionResponse}'s optionId to the
 * SDK {@link ApprovalResponse}. Pulled out of
 * {@link permissionResponseToApprovalResponse} so the canonical and
 * plan_review branches stay readable side-by-side.
 *
 * `selectedLabel` is attached here for `plan_opt_<i>` /
 * `plan_revise` / `plan_reject_and_exit`. The downstream policy
 * (`exit-plan-mode-review-ask.ts:49` and `:107`) drives its branch off
 * `selectedLabel` so the labels must be stable strings — not
 * re-derived from the option array on every call.
 *
 * `plan_approve` intentionally returns `{ decision: 'approved' }` with
 * no `selectedLabel` so the policy walks its default approved path.
 *
 * Defensive: an unknown `plan_*` optionId or a `plan_opt_<i>` with `i`
 * out of bounds → `{ decision: 'rejected' }` (same posture as the
 * canonical unknown→reject branch).
 */
function mapPlanReviewOptionId(
  display: Extract<ApprovalRequest['display'], { kind: 'plan_review' }>,
  optionId: string,
): ApprovalResponse {
  if (optionId === PLAN_APPROVE_OPTION_ID) {
    return { decision: 'approved' };
  }
  if (optionId === PLAN_REVISE_OPTION_ID) {
    return { decision: 'rejected', selectedLabel: 'Revise' };
  }
  if (optionId === PLAN_REJECT_AND_EXIT_OPTION_ID) {
    return { decision: 'rejected', selectedLabel: 'Reject and Exit' };
  }
  const match = /^plan_opt_(\d+)$/.exec(optionId);
  if (match) {
    const i = Number(match[1]);
    const opts = display.options;
    if (opts !== undefined && Number.isInteger(i) && i >= 0 && i < opts.length) {
      return { decision: 'approved', selectedLabel: opts[i]!.label };
    }
    return { decision: 'rejected' };
  }
  // Unknown plan_* optionId — same defensive reject as the canonical
  // unknown branch.
  return { decision: 'rejected' };
}

/**
 * Build the ACP {@link ToolCallUpdate} that scopes a permission request
 * to a specific in-flight tool call.
 *
 * The `toolCallId` is the **prefixed** ACP wire id `${turnId}:${rawId}`
 * — matching the id format used by all other tool_call/tool_call_update
 * notifications — so the client can correlate the approval prompt with
 * the tool card it already rendered. If `turnId` is `undefined` (the
 * `onEvent` listener has not yet observed any turn-scoped event), the
 * raw SDK id is used as a defensive fallback. In practice approvals
 * always fire **after** `tool.call.started`, so the fallback is
 * effectively unreachable; it exists so the handler never throws.
 *
 * Content shape (Phase 5.2):
 *  - If `req.display` produces a diff-bearing entry via
 *    {@link displayBlockToAcpContent} (diff kind, or file_io with
 *    before+after), prepend it so the diff card is the headline of
 *    the approval prompt. Non-diff display kinds (command, search, …)
 *    contribute no structured content here — their information is
 *    already conveyed by the action text below.
 *  - Phase 13.2 adds a `plan_review` entry so the full plan markdown
 *    (and the optional `Plan saved to:` path prefix) lands at the top
 *    of the approval card — the previous Phase-5 fallback truncated
 *    everything but the action text, losing the plan body.
 *  - Always append a human-readable action summary
 *    (`"Requesting approval to ${req.action}"`). This is the fallback
 *    surface in narrow notification UIs that cannot render the full
 *    diff card and matches the wording used by the Python reference.
 */
export function buildPermissionToolCallUpdate(
  turnId: number | undefined,
  req: ApprovalRequest,
): ToolCallUpdate {
  const toolCallId =
    turnId !== undefined ? acpToolCallId(turnId, req.toolCallId) : req.toolCallId;
  const content: ToolCallContent[] = [];
  // Diff entry first — diffs and file-io previews carry the most
  // context and should land at the top of the approval card. Phase 13.2
  // adds plan_review to the same path so plan markdown surfaces in the
  // headline too.
  const headlineEntry = displayBlockToAcpContent(req.display);
  if (headlineEntry !== null) {
    content.push(headlineEntry);
  }
  // Always include the action summary so the prompt is never empty.
  content.push({
    type: 'content',
    content: { type: 'text', text: `Requesting approval to ${req.action}` },
  });
  return {
    toolCallId,
    title: req.toolName,
    content,
  };
}

/**
 * Look up the matched {@link PermissionOption}'s display name for the
 * given response and return a new {@link ApprovalResponse} carrying
 * `selectedLabel`. Returns the input unchanged when:
 *  - the outcome was `'cancelled'` (no option was matched), or
 *  - the `optionId` does not appear in the option table (defensive —
 *    matches the `permissionResponseToApprovalResponse` unknown→reject
 *    path), or
 *  - the response has already been mapped to `'cancelled'`, or
 *  - the optionId is in the `plan_*` namespace — Phase 13.2 attaches
 *    the label inside {@link permissionResponseToApprovalResponse}'s
 *    plan_review branch, so a second pass through the canonical option
 *    table here would either overwrite it with `undefined` (the canonical
 *    table has no plan ids) or no-op; short-circuiting is the simpler,
 *    explicit contract.
 *
 * Pure: returns a fresh object (never mutates the input) so callers
 * can stitch the label on top of the discriminator mapping without
 * worrying about TS strict-readonly fields.
 */
export function attachSelectedLabel(
  response: RequestPermissionResponse,
  approval: ApprovalResponse,
  options: readonly PermissionOption[],
): ApprovalResponse {
  const outcome = response.outcome;
  if (outcome.outcome !== 'selected') return approval;
  // Phase 13.2: plan_review optionIds already carry selectedLabel from
  // the mapper. Short-circuit so this canonical-table lookup never
  // strips an already-attached label.
  if (
    outcome.optionId.startsWith('plan_opt_') ||
    outcome.optionId === PLAN_APPROVE_OPTION_ID ||
    outcome.optionId === PLAN_REVISE_OPTION_ID ||
    outcome.optionId === PLAN_REJECT_AND_EXIT_OPTION_ID
  ) {
    return approval;
  }
  const matched = options.find((o) => o.optionId === outcome.optionId);
  if (!matched) return approval;
  return { ...approval, selectedLabel: matched.name };
}
