/**
 * Build the unified `SessionConfigOption[]` surface advertised on
 * `session/new` + `session/load` + `session/resume` and refreshed by
 * `config_option_update`.
 *
 * The surface has up to three options:
 *   - `id: 'model'`    (`type: 'select'`, `category: 'model'`) — one row per
 *     {@link AcpModelEntry}. Thinking is an orthogonal axis (separate toggle).
 *   - `id: 'thinking'` (`type: 'select'`, `category: 'thought_level'`) —
 *     appears ONLY when the currently-selected model's catalog row has
 *     `thinkingSupported === true`; otherwise omitted so the client doesn't
 *     render a non-actionable toggle. Encoded as a `select` for Zed
 *     compatibility (its chip strip only renders `select` options; the spec's
 *     `boolean` arm shows as "Unknown"). The entries adapt to the model's
 *     declared capability: a model with `supportEfforts` offers `off` plus
 *     every declared effort level; a boolean model keeps the plain
 *     `off` / `on` pair. `always_thinking` models drop the `off` entry.
 *   - `id: 'mode'`     (`type: 'select'`, `category: 'mode'`) — the locked
 *     4-mode taxonomy ({@link ACP_MODES}).
 */

import type { SessionConfigOption, SessionConfigSelectOption } from '@agentclientprotocol/sdk';

import { ACP_MODES, type AcpModeId } from './modes';
import type { AcpModelEntry } from './model-catalog';

/**
 * Project the catalog into the `SessionConfigOption` `model` arm. One option
 * row per catalog entry. `currentValue` is the bare model id.
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
 * Build the `thinking` select. Entries adapt to the model's declared
 * capability: with `supportEfforts` the select is `off` plus every declared
 * effort level; without them it stays the boolean `off` / `on` pair.
 * `alwaysThinking` models drop the `off` entry (thinking cannot be disabled —
 * ACP has no "disabled entry" concept). A `currentLevel` not present in the
 * entries (e.g. an engine-resolved effort the catalog didn't declare) is
 * appended so `currentValue` always stays selectable.
 */
export function buildThinkingOption(
  currentLevel: string,
  alwaysThinking = false,
  supportEfforts?: readonly string[],
): SessionConfigOption {
  const values = supportEfforts !== undefined ? ['off', ...supportEfforts] : ['off', 'on'];
  const options: SessionConfigSelectOption[] = values
    .filter((value) => !(alwaysThinking && value === 'off'))
    .map((value) => ({ value, name: thinkingOptionName(value) }));
  if (!options.some((option) => option.value === currentLevel)) {
    options.push({ value: currentLevel, name: thinkingOptionName(currentLevel) });
  }
  return {
    type: 'select',
    id: 'thinking',
    name: 'Thinking',
    category: 'thought_level',
    currentValue: currentLevel,
    options,
  };
}

/** Display name for a thinking select entry (`off` → `Thinking Off`). */
function thinkingOptionName(value: string): string {
  return `Thinking ${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

/**
 * Project the locked 4-mode taxonomy ({@link ACP_MODES}) into the
 * `SessionConfigOption` `mode` arm. Order is preserved (default → plan → auto →
 * yolo).
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
 * Compose the `SessionConfigOption[]` surface —
 * `[modelOption, …(thinkingOption?), modeOption]`. Order is part of the
 * contract: ACP clients render options top-to-bottom, model on top of mode.
 *
 * The thinking toggle only appears when the currently-selected base model is
 * `thinkingSupported`; otherwise the snapshot is just `[modelOption, modeOption]`.
 *
 * Returns a mutable `SessionConfigOption[]` (rather than `readonly`) so the
 * value is assignable to the SDK's `NewSessionResponse.configOptions` field,
 * which is typed `Array<SessionConfigOption>`.
 */
export function buildSessionConfigOptions(
  models: readonly AcpModelEntry[],
  currentBaseModelId: string,
  currentThinkingLevel: string,
  currentModeId: AcpModeId,
): SessionConfigOption[] {
  const currentModelEntry = models.find((m) => m.id === currentBaseModelId);
  const showThinking = currentModelEntry?.thinkingSupported === true;
  const alwaysThinking = currentModelEntry?.alwaysThinking === true;
  const out: SessionConfigOption[] = [buildModelOption(models, currentBaseModelId)];
  if (showThinking) {
    // Always-thinking models render locked-on regardless of the session's
    // recorded level — the runtime clamps the same way.
    const level = alwaysThinking && currentThinkingLevel === 'off' ? 'on' : currentThinkingLevel;
    out.push(buildThinkingOption(level, alwaysThinking, currentModelEntry?.supportEfforts));
  }
  out.push(buildModeOption(currentModeId));
  return out;
}
