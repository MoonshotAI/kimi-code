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
 *     an orthogonal axis exposed as a separate picker.
 *   - `id: 'thinking'`  (`type: 'select'`, `category: 'thought_level'`)
 *     — appears ONLY when the currently-selected model's catalog row has
 *     `thinkingSupported === true`; otherwise omitted from the snapshot
 *     so the client doesn't render a non-actionable picker. The rows are
 *     `off` plus one entry per declared effort level
 *     (`'low' | 'medium' | …` from the model's `support_efforts`);
 *     boolean models (thinking support without `support_efforts`) keep
 *     the legacy 2-entry `off` / `on` shape. The wire form is
 *     `type: 'select'` rather than the spec's `boolean` arm because
 *     Zed's chip strip only knows how to draw `select` options.
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
 * {@link buildThinkingOption} picker (a `select` for Zed compatibility,
 * but the model picker shape is unaffected), so the model dropdown stays at most
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
 * Build the `thinking` picker.
 *
 * Spec category `'thought_level'` (`schema/types.gen.d.ts:4492`) is the
 * reserved bucket for reasoning / thinking knobs; using it lets a client
 * like Zed render the picker with the right icon / placement without the
 * adapter advertising a custom category.
 *
 * The wire form is `type: 'select'` — Zed's chip strip currently only
 * renders `select` options; the spec's `boolean` arm shows up as
 * "Unknown" because the UI hasn't been wired up to it yet.
 *
 * Row shape depends on the model's declared effort levels:
 *  - Effort-capable models (`supportEfforts` non-empty): one row per
 *    level, preceded by `off` — e.g. `off / low / medium / high`. The
 *    `currentValue` is the session's current effort; the legacy `'on'`
 *    alias (and any level the model does not declare) collapses to
 *    `defaultEffort` so the rendered value is always one of the rows.
 *  - Boolean models (no `support_efforts`): the legacy 2-entry
 *    `off` / `on` pair. Any non-`'off'` current effort renders as `on`.
 *
 * `alwaysThinking` models (declared `always_thinking` capability — the
 * runtime cannot disable thinking) drop the `off` row: the state stays
 * visible to the client, but there is no off option to pick. ACP has no
 * "disabled entry" concept, so omitting `off` is the wire-level
 * equivalent of the TUI's greyed-out `Off (Unsupported)` segment. A
 * recorded `'off'` current effort (which the engine clamps back to the
 * model default) renders as `defaultEffort`.
 */
export function buildThinkingOption(
  currentEffort: string,
  supportEfforts: readonly string[],
  defaultEffort: string,
  alwaysThinking = false,
): SessionConfigOption {
  const efforts = supportEfforts.filter((effort) => effort.length > 0);
  if (efforts.length === 0) {
    // Boolean model — the engine speaks `on`/`off`, so the picker keeps
    // the legacy two-row shape.
    return {
      type: 'select',
      id: 'thinking',
      name: 'Thinking',
      category: 'thought_level',
      currentValue: alwaysThinking || currentEffort !== 'off' ? 'on' : 'off',
      options: alwaysThinking
        ? [{ value: 'on', name: effortDisplayName('on') }]
        : [
            { value: 'off', name: effortDisplayName('off') },
            { value: 'on', name: effortDisplayName('on') },
          ],
    };
  }
  const values = alwaysThinking ? [...efforts] : ['off', ...efforts];
  const currentValue =
    !alwaysThinking && currentEffort === 'off'
      ? 'off'
      : efforts.includes(currentEffort)
        ? currentEffort
        : defaultEffort;
  return {
    type: 'select',
    id: 'thinking',
    name: 'Thinking',
    category: 'thought_level',
    currentValue,
    options: values.map((value) => ({ value, name: effortDisplayName(value) })),
  };
}

/** Display label for one thinking-picker row — the capitalized level. */
function effortDisplayName(effort: string): string {
  return effort.charAt(0).toUpperCase() + effort.slice(1);
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
 * is reachable first. The thinking picker is wedged between them so its
 * effect on the model selection above is visually adjacent.
 *
 * The thinking picker only appears when the currently-selected base
 * model is `thinkingSupported`; otherwise the snapshot is just
 * `[modelOption, modeOption]`. This means switching from a thinking-
 * capable model (e.g. `kimi-coder`) to a non-thinking one (e.g.
 * `kimi-plain`) causes the next `config_option_update` to omit the
 * picker entirely — Zed's UI is expected to handle "option set changes
 * across updates", which is the standard configOptions contract.
 *
 * `currentThinkingEffort` is the session's current effort string
 * (`'off'`, `'on'`, or a declared level); {@link buildThinkingOption}
 * projects it onto the row set — `'on'` and unknown levels render as
 * the model's default effort.
 *
 * Calls {@link listModelsFromHarness} exactly once per invocation so a
 * session refresh after each model/mode/thinking change is a single
 * round-trip to the harness. The helper itself is tolerant to
 * partial-stub harnesses: missing `getConfig` or a throwing one resolve
 * to an empty catalog, so the model picker ships an empty options
 * array and the thinking picker is suppressed (no current model means
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
  currentThinkingEffort: string,
  currentModeId: AcpModeId,
): Promise<SessionConfigOption[]> {
  const models = await listModelsFromHarness(harness);
  const currentModelEntry = models.find((m) => m.id === currentBaseModelId);
  const showThinking = currentModelEntry?.thinkingSupported === true;
  const out: SessionConfigOption[] = [buildModelOption(models, currentBaseModelId)];
  if (showThinking && currentModelEntry !== undefined) {
    out.push(
      buildThinkingOption(
        currentThinkingEffort,
        currentModelEntry.supportEfforts,
        currentModelEntry.defaultThinkingEffort,
        currentModelEntry.alwaysThinking === true,
      ),
    );
  }
  out.push(buildModeOption(currentModeId));
  return out;
}
