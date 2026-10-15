import {
  effectiveModelAlias,
  type KimiConfig,
  type ModelAlias,
  type ThinkingEffort,
} from '@moonshot-ai/kimi-code-sdk';

import type { SlashCommandHost } from '../commands/dispatch';
import { defaultThinkingEffortFor, modelDisplayName } from '../components/dialogs/model-selector';
import type { AppState } from '../types';
import { formatErrorMessage } from './event-payload';
import { thinkingEffortFromConfig, thinkingEffortToConfig } from './thinking-config';

export const MODEL_SWITCH_CACHE_WARNING =
  'Note: Switching models invalidates the existing prompt cache. Use /new to avoid extra token costs.';

/** True once the conversation has at least one user message: a switch from
 * then on resends the accumulated context, losing the cache. Shell-command
 * echoes are also 'user' transcript entries but carry an empty `bullet`, so
 * they're excluded. */
export function hasConversationHistory(host: SlashCommandHost): boolean {
  return host.state.transcriptEntries.some(
    (entry) => entry.kind === 'user' && entry.bullet !== '',
  );
}

export function effectiveModelForHost(host: SlashCommandHost, model: ModelAlias): ModelAlias {
  const providerType = host.state.appState.availableProviders[model.provider]?.type;
  // Flat models (no named provider, e.g. inline base_url served by a v2
  // backend) have no provider entry to look up; their own protocol declaration
  // plays the provider-identity role, mirroring the resolver.
  return effectiveModelAlias(model, providerType ?? model.protocol);
}

/**
 * The model and thinking effort `config` gives the first lazily created
 * session when it binds `alias`, for the session-less footer and the create
 * call alike.
 */
export function lazyModelSelection(
  config: KimiConfig,
  alias: string | undefined,
): Partial<AppState> {
  // A default that disappeared from config (edited externally) clears the
  // previously hydrated value instead of passing a stale explicit model to the
  // first lazy-created session.
  const patch: Partial<AppState> =
    alias === undefined ? { model: '', maxContextTokens: 0 } : { model: alias };
  const raw = alias === undefined ? undefined : config.models?.[alias];
  if (raw?.maxContextSize !== undefined) {
    patch.maxContextTokens = raw.maxContextSize;
  }
  const effort = thinkingEffortFromConfig(config.thinking);
  if (effort !== undefined) {
    patch.thinkingEffort = effort;
  } else if (raw !== undefined) {
    // No concrete effort configured: mirror the engine, which resolves the
    // model's default effort at createSession time.
    const providerType = config.providers?.[raw.provider]?.type;
    patch.thinkingEffort = defaultThinkingEffortFor(
      effectiveModelAlias(raw, providerType ?? raw.protocol),
    );
  }
  return patch;
}

/**
 * How a model switch is saved: `session` keeps it to this session, `model`
 * saves the model as the default (and the effort only when it changed), and
 * `model-and-effort` saves both.
 */
export type ModelSwitchPersistence = 'session' | 'model' | 'model-and-effort';

export async function performModelSwitch(
  host: SlashCommandHost,
  alias: string,
  effort: ThinkingEffort,
  persist: ModelSwitchPersistence,
): Promise<boolean> {
  let session = host.session;
  if (session === undefined) {
    // A first prompt may still be inside lazy creation: wait it out so the
    // switch lands on the new session instead of being overwritten by its
    // assembly.
    await host.waitForSessionAssembly();
    session = host.session;
  }
  if (host.state.appState.streamingPhase !== 'idle') {
    host.showError('Cannot switch models while streaming — press Esc or Ctrl-C first.');
    return false;
  }

  const prevModel = host.state.appState.model;
  const prevEffort = host.state.appState.thinkingEffort;
  const modelChanged = alias !== prevModel;
  const effortChanged = effort !== prevEffort;
  const runtimeChanged = modelChanged || effortChanged;
  let effectiveAlias = alias;
  let effectiveEffort = effort;

  try {
    if (session === undefined && runtimeChanged) {
      await host.authFlow.activateModelAfterLogin(alias, effort);
    } else if (session !== undefined) {
      if (alias !== prevModel) {
        await session.setModel(alias);
      }
      if (effort !== prevEffort) {
        await session.setThinking(effort);
      }
      const status = await session.getStatus();
      effectiveAlias = status.model ?? alias;
      effectiveEffort = status.thinkingEffort;
    }
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to switch model: ${msg}`);
    return false;
  }

  if (session === undefined) {
    effectiveAlias = host.state.appState.model;
    effectiveEffort = host.state.appState.thinkingEffort;
  }
  const effectiveModelChanged = effectiveAlias !== prevModel;
  const effectiveEffortChanged = effectiveEffort !== prevEffort;
  const displayName = modelDisplayName(
    effectiveAlias,
    host.state.appState.availableModels[effectiveAlias],
  );
  host.setAppState({ model: effectiveAlias, thinkingEffort: effectiveEffort });
  if (session === undefined && runtimeChanged) {
    if (effectiveModelChanged) {
      host.track('model_switch', { model: effectiveAlias });
    }
    if (effectiveEffortChanged) {
      host.track('thinking_toggle', {
        enabled: effectiveEffort !== 'off',
        effort: effectiveEffort,
        from: prevEffort,
      });
    }
  }

  const saveDefault = persist !== 'session';
  let persisted = false;
  if (saveDefault) {
    try {
      persisted = await persistModelSelection(
        host,
        effectiveAlias,
        effectiveEffort,
        effectiveEffortChanged || persist === 'model-and-effort',
      );
    } catch (error) {
      const msg = formatErrorMessage(error);
      host.showError(`Switched to ${displayName}, but failed to save default: ${msg}`);
      return false;
    }
  }

  let status: string;
  if (effectiveModelChanged) {
    status = saveDefault
      ? `Switched to ${displayName} with thinking ${effectiveEffort}.`
      : `Switched to ${displayName} with thinking ${effectiveEffort} for this session only.`;
  } else if (effectiveEffortChanged) {
    status = saveDefault
      ? `Thinking set to ${effectiveEffort}.`
      : `Thinking set to ${effectiveEffort} for this session only.`;
  } else if (saveDefault && persisted) {
    status = `Saved ${displayName} with thinking ${effectiveEffort} as default.`;
  } else {
    status = `Already using ${displayName} with thinking ${effectiveEffort}.`;
  }
  host.showStatus(status, 'success');
  return true;
}

async function persistModelSelection(
  host: SlashCommandHost,
  alias: string,
  effort: ThinkingEffort,
  persistEffort: boolean,
): Promise<boolean> {
  const config = await host.harness.getConfig({ reload: true });
  const model = host.state.appState.availableModels[alias];
  const full = thinkingEffortToConfig(
    effort,
    model === undefined ? undefined : effectiveModelForHost(host, model),
  );
  // Ordinary /model confirmation preserves the stored effort unless it changed;
  // migration acceptance explicitly persists the target effort.
  const patch = persistEffort ? full : { enabled: full.enabled };
  if (
    config.defaultModel === alias &&
    config.thinking?.enabled === patch.enabled &&
    (!persistEffort || config.thinking?.effort === patch.effort)
  ) {
    return false;
  }
  await host.harness.setConfig({
    defaultModel: alias,
    thinking: patch,
  });
  return true;
}
