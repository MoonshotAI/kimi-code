/**
 * Build the unified `SessionConfigOption[]` surface (PLAN D11) advertised on
 * `session/new` + `session/load` and refreshed by `config_option_update`.
 *
 * Phase 14 unifies model + mode selection under the spec's generic
 * `configOptions` channel — replacing Phase 12's dedicated
 * `NewSessionResponse.modes` field — so a client like Zed renders both
 * pickers from a single source of truth and can flip either through
 * `session/set_config_option`.
 *
 * The v0 surface has up to three options:
 *   - `id: 'model'`     (`type: 'select'`, `category: 'model'`) — one row
 *     per {@link AcpModelEntry}, no `,thinking` variants. Thinking is
 *     an orthogonal axis exposed as a separate toggle.
 *   - `id: 'thinking'`  (`type: 'select'`, `category: 'thought_level'`)
 *     — appears ONLY when the currently-selected model's catalog row has
 *     `thinkingSupported === true`; otherwise omitted from the snapshot
 *     so the client doesn't render a non-actionable toggle. Phase 16
 *     converted this from `SessionConfigBoolean` to a 2-entry select
 *     (`off` / `on`) so Zed renders it — Zed's chip strip currently
 *     only knows how to draw `type: 'select'` options, and the spec's
 *     `boolean` arm shows up as "Unknown". Effort granularity
 *     (`'low' | 'medium' | …`) is still hidden behind the adapter —
 *     kimi-code uses a single non-`'off'` level under the hood (the
 *     model's default effort, resolved by agent-core's
 *     `resolveThinkingEffort`).
 *   - `id: 'mode'`      (`type: 'select'`, `category: 'mode'`) — the
 *     locked 4-mode taxonomy from PLAN D9 ({@link ACP_MODES}).
 *
 * The wire shape mirrors `@agentclientprotocol/sdk` `SessionConfigOption`
 * (`schema/types.gen.d.ts:4449-4480`): each option carries `id`, `name`,
 * optional `category`, and a `type`-discriminated `currentValue` (string
 * for `'select'`, boolean for `'boolean'`).
 */

import type { SessionConfigOption, SessionConfigSelectOption } from '@agentclientprotocol/sdk';
import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { ACP_MODES, type AcpModeId } from './modes';
import { listModelsFromHarness, type AcpModelEntry } from './model-catalog';

/**
 * Project the catalog into the `SessionConfigOption` `model` arm.
 *
 * One option row per catalog entry — Phase 15 removed the inlined
 * `${id},thinking` variant rows in favour of a separate
 * {@link buildThinkingOption} toggle (Phase 16 then changed that toggle
 * from `boolean` to a 2-entry `select` for Zed compatibility, but the
 * model picker shape is unaffected), so the model dropdown stays at most
 * N rows even when many catalog entries support thinking. The Python
 * reference's `_expand_llm_models` (`kimi-cli/src/kimi_cli/acp/server.py:441-468`)
 * still emits twin rows, but it has no `select`-based effort
 * equivalent; we diverge intentionally for UX clarity.
 *
 * `currentValue` is the bare model id (no `,thinking` suffix). When
 * an external caller still sends the merged form via
 * `unstable_setSessionModel({ modelId: 'k2,thinking' })`,
 * {@link AcpSession.setModel} splits the suffix off and updates both
 * the model and thinking authoritative state before the snapshot is
 * built — so the value reaching this builder is always already-split.
 */
export function buildModelOption(
  models: readonly AcpModelEntry[],
  currentBaseModelId: string,
): SessionConfigOption {
  const options: SessionConfigSelectOption[] = models.map((model) => ({
    value: model.id,
    name: model.name,
    ...(model.description !== undefined ? { description: model.description } : {}),
  }));
  return {
    type: 'select',
    id: 'model',
    name: 'Model',
    category: 'model',
    currentValue: currentBaseModelId,
    options,
  };
}

/**
 * Build the `thinking` toggle.
 *
 * Spec category `'thought_level'` (`schema/types.gen.d.ts:4492`) is the
 * reserved bucket for reasoning / thinking knobs; using it lets a client
 * like Zed render the toggle with the right icon / placement without the
 * adapter advertising a custom category.
 *
 * Phase 16 made this a 2-entry `type: 'select'` (`off` / `on`) instead
 * of `type: 'boolean'` — Zed's chip strip currently only renders
 * `select` options; boolean shows as "Unknown" because the UI hasn't
 * been wired up to the spec's boolean arm yet. The adapter still tracks
 * the toggle internally as a boolean (`AcpSession.currentThinkingEnabled`);
 * only the wire encoding is `'on'` / `'off'` strings.
 *
 * The caller decides whether to include this option at all — when the
 * currently-selected model has `thinkingSupported === false`, the
 * snapshot omits it entirely (dynamic visibility), so the client never
 * shows a toggle that wouldn't do anything.
 *
 * `alwaysThinking` models (declared `always_thinking` capability — the
 * runtime cannot disable thinking) collapse the select to a single
 * locked `on` entry: the state stays visible to the client, but there
 * is no off option to pick. ACP has no "disabled entry" concept, so
 * omitting `off` is the wire-level equivalent of the TUI's greyed-out
 * `Off (Unsupported)` segment.
 */
export function buildThinkingOption(
  enabled: boolean,
  alwaysThinking = false,
): SessionConfigOption {
  if (alwaysThinking) {
    return {
      type: 'select',
      id: 'thinking',
      name: 'Thinking',
      category: 'thought_level',
      currentValue: 'on',
      options: [{ value: 'on', name: 'Thinking On' }],
    };
  }
  return {
    type: 'select',
    id: 'thinking',
    name: 'Thinking',
    category: 'thought_level',
    currentValue: enabled ? 'on' : 'off',
    options: [
      { value: 'off', name: 'Thinking Off' },
      { value: 'on', name: 'Thinking On' },
    ],
  };
}

/**
 * Project the locked 4-mode taxonomy ({@link ACP_MODES}) into the
 * `SessionConfigOption` `mode` arm. Order is preserved (default → plan →
 * auto → yolo) so the client renders the dropdown the same way Phase 12
 * did via the dedicated `modes:` field.
 */
export function buildModeOption(currentModeId: AcpModeId): SessionConfigOption {
  const options: SessionConfigSelectOption[] = ACP_MODES.map((mode) => ({
    value: mode.id,
    name: mode.name,
    description: mode.description,
  }));
  return {
    type: 'select',
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    currentValue: currentModeId,
    options,
  };
}

/**
 * Compose the v0 `SessionConfigOption[]` surface — `[modelOption, …(thinkingOption?), modeOption]`.
 * Order is part of the contract: ACP clients render options top-to-bottom, and
 * PLAN D11 fixes model on top of mode so the more frequently-used selector
 * is reachable first. The thinking toggle is wedged between them so its
 * effect on the model selection above is visually adjacent.
 *
 * The thinking toggle only appears when the currently-selected base
 * model is `thinkingSupported`; otherwise the snapshot is just
 * `[modelOption, modeOption]`. This means switching from a thinking-
 * capable model (e.g. `kimi-coder`) to a non-thinking one (e.g.
 * `kimi-plain`) causes the next `config_option_update` to omit the
 * toggle entirely — Zed's UI is expected to handle "option set changes
 * across updates", which is the standard configOptions contract.
 *
 * Calls {@link listModelsFromHarness} exactly once per invocation so a
 * session refresh after each model/mode/thinking change is a single
 * round-trip to the harness. The helper itself is tolerant to
 * partial-stub harnesses: missing `getConfig` or a throwing one resolve
 * to an empty catalog, so the model picker ships an empty options
 * array and the thinking toggle is suppressed (no current model means
 * no thinkingSupported signal to read).
 *
 * Returns a mutable `SessionConfigOption[]` (rather than `readonly`) so
 * the value is assignable to the SDK's `NewSessionResponse.configOptions`
 * field, which is typed `Array<SessionConfigOption>` — TypeScript treats
 * `readonly T[]` as not assignable to `T[]` even when callers never
 * mutate it.
 */
export async function buildSessionConfigOptions(
  harness: KimiHarness,
  currentBaseModelId: string,
  currentThinkingEnabled: boolean,
  currentModeId: AcpModeId,
): Promise<SessionConfigOption[]> {
  const models = await listModelsFromHarness(harness);
  const currentModelEntry = models.find((m) => m.id === currentBaseModelId);
  const showThinking = currentModelEntry?.thinkingSupported === true;
  const alwaysThinking = currentModelEntry?.alwaysThinking === true;
  const out: SessionConfigOption[] = [buildModelOption(models, currentBaseModelId)];
  if (showThinking) {
    // Always-thinking models render locked-on regardless of the session's
    // recorded toggle state — agent-core clamps the runtime the same way.
    out.push(buildThinkingOption(alwaysThinking || currentThinkingEnabled, alwaysThinking));
  }
  out.push(buildModeOption(currentModeId));
  return out;
}
