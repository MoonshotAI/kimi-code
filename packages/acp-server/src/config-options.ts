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
 *     render a non-actionable toggle. Encoded as a 2-entry select
 *     (`off` / `on`) for Zed compatibility (its chip strip only renders
 *     `select` options; the spec's `boolean` arm shows as "Unknown"). Effort
 *     granularity stays hidden behind the host — the runtime uses a single
 *     non-`'off'` level (the model's default effort).
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
 * Build the `thinking` toggle. `alwaysThinking` models collapse the select to a
 * single locked `on` entry (the state stays visible but there is no off option
 * to pick — ACP has no "disabled entry" concept).
 */
export function buildThinkingOption(enabled: boolean, alwaysThinking = false): SessionConfigOption {
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
  currentThinkingEnabled: boolean,
  currentModeId: AcpModeId,
): SessionConfigOption[] {
  const currentModelEntry = models.find((m) => m.id === currentBaseModelId);
  const showThinking = currentModelEntry?.thinkingSupported === true;
  const alwaysThinking = currentModelEntry?.alwaysThinking === true;
  const out: SessionConfigOption[] = [buildModelOption(models, currentBaseModelId)];
  if (showThinking) {
    // Always-thinking models render locked-on regardless of the session's
    // recorded toggle state — the runtime clamps the same way.
    out.push(buildThinkingOption(alwaysThinking || currentThinkingEnabled, alwaysThinking));
  }
  out.push(buildModeOption(currentModeId));
  return out;
}
