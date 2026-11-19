import { describe, expect, it, beforeEach } from 'vitest';
import { DaemonApiError } from '@moonshot-ai/app-core/api';
import {
  computeGateVerdict,
  mapDaemonAuthError,
  resolveChatModel,
  type ChatGateInput,
} from '../src/lib/chatGate';
import { modelsStore } from '../src/stores/models';

const models = [
  { id: 'managed:kimi-code/kimi-k2', model: 'kimi-k2' },
  { id: 'openai/gpt-4o', model: 'gpt-4o' },
];

describe('resolveChatModel', () => {
  it('resolves the session model first when it is valid in the models table', () => {
    expect(resolveChatModel('openai/gpt-4o', 'managed:kimi-code/kimi-k2', 'managed:kimi-code/kimi-k2', models)).toBe('openai/gpt-4o');
  });

  it('matches a bare model name as well as the full id', () => {
    expect(resolveChatModel('kimi-k2', null, null, models)).toBe('kimi-k2');
  });

  it('falls through session → draft → default in order', () => {
    expect(resolveChatModel('', 'openai/gpt-4o', 'managed:kimi-code/kimi-k2', models)).toBe('openai/gpt-4o');
    expect(resolveChatModel(null, null, 'managed:kimi-code/kimi-k2', models)).toBe('managed:kimi-code/kimi-k2');
    expect(resolveChatModel(undefined, undefined, 'managed:kimi-code/kimi-k2', models)).toBe('managed:kimi-code/kimi-k2');
  });

  it('returns null when the chain has no candidate', () => {
    expect(resolveChatModel(null, null, null, models)).toBeNull();
    expect(resolveChatModel('', null, null, models)).toBeNull();
  });

  it('returns null when the candidate is not in the models table (dangling alias)', () => {
    expect(resolveChatModel('deleted/model', null, null, models)).toBeNull();
    expect(resolveChatModel(null, 'deleted/model', null, models)).toBeNull();
    expect(resolveChatModel(null, null, 'deleted/model', models)).toBeNull();
  });

  it('returns null while the models cache is still empty (cold load window)', () => {
    expect(resolveChatModel(null, null, 'managed:kimi-code/kimi-k2', [])).toBeNull();
  });

  it('an empty-string draft falls through to the default (`||` semantics, not `??`)', () => {
    expect(resolveChatModel(null, '', 'managed:kimi-code/kimi-k2', models)).toBe('managed:kimi-code/kimi-k2');
    expect(resolveChatModel('', '', 'managed:kimi-code/kimi-k2', models)).toBe('managed:kimi-code/kimi-k2');
  });
});

describe('modelsStore.resolveSendModel — the shared send-facing resolver', () => {
  beforeEach(() => {
    modelsStore().setModels(models as never);
    modelsStore().setDraftModel(null);
    modelsStore().setDefaultModel(null);
  });

  it('the session model wins while valid; a dangling session model never falls to another draft', () => {
    modelsStore().setDraftModel('openai/gpt-4o');
    expect(modelsStore().resolveSendModel('managed:kimi-code/kimi-k2')).toBe('managed:kimi-code/kimi-k2');
    expect(modelsStore().resolveSendModel('deleted/model')).toBeNull();
    expect(modelsStore().resolveSendModel('')).toBeNull();
    expect(modelsStore().resolveSendModel('', { includeDraft: true })).toBe('openai/gpt-4o');
  });

  it('an empty draft falls to the default', () => {
    modelsStore().setDefaultModel('openai/gpt-4o');
    expect(modelsStore().resolveSendModel('deleted/model')).toBe('openai/gpt-4o');
    expect(modelsStore().resolveSendModel(null)).toBe('openai/gpt-4o');
    expect(modelsStore().resolveSendModel(undefined)).toBe('openai/gpt-4o');
  });

  it('a dangling draft/default never leaks through (validity is catalog-checked)', () => {
    modelsStore().setDraftModel('deleted/draft');
    modelsStore().setDefaultModel('deleted/default');
    expect(modelsStore().resolveSendModel('managed:kimi-code/kimi-k2')).toBe('managed:kimi-code/kimi-k2');
    expect(modelsStore().resolveSendModel(null)).toBeNull();
  });

  it('returns null when nothing resolves (empty catalog)', () => {
    modelsStore().setModels([]);
    modelsStore().setDraftModel('openai/gpt-4o');
    modelsStore().setDefaultModel('openai/gpt-4o');
    expect(modelsStore().resolveSendModel('managed:kimi-code/kimi-k2')).toBeNull();
  });

  it('a bare model name (alias) resolves like the canonical id', () => {
    expect(modelsStore().resolveSendModel('gpt-4o')).toBe('gpt-4o');
  });
});

describe('computeGateVerdict — the §2.3 matrix', () => {
  function input(over: Partial<ChatGateInput>): ChatGateInput {
    return {
      chatModel: null,
      chatModelManaged: false,
      modelsReady: false,
      hasModels: false,
      signedIn: false,
      isFree: false,
      ...over,
    };
  }

  it('login when signed out with no models', () => {
    expect(computeGateVerdict(input({}))).toBe('login');
  });

  it('ok when a model resolves, regardless of sign-in', () => {
    expect(computeGateVerdict(input({ chatModel: 'openai/gpt-4o' }))).toBe('ok');
    expect(computeGateVerdict(input({ chatModel: 'openai/gpt-4o', signedIn: true, isFree: true }))).toBe('ok');
  });

  it('upgrade when a free account resolves a managed subscription model', () => {
    expect(
      computeGateVerdict(
        input({ chatModel: 'managed:kimi-code/kimi-k2', chatModelManaged: true, signedIn: true, isFree: true }),
      ),
    ).toBe('upgrade');
  });

  it('ok on a managed model when membership is paid or not yet known', () => {
    expect(
      computeGateVerdict(input({ chatModel: 'managed:kimi-code/kimi-k2', chatModelManaged: true, signedIn: true })),
    ).toBe('ok');
    expect(computeGateVerdict(input({ chatModel: 'managed:kimi-code/kimi-k2', chatModelManaged: true }))).toBe('ok');
  });

  it('pick-model when models exist but none resolves, signed out', () => {
    expect(computeGateVerdict(input({ hasModels: true }))).toBe('pick-model');
  });

  it('pick-model when signed in with models but none resolves', () => {
    expect(computeGateVerdict(input({ signedIn: true, hasModels: true }))).toBe('pick-model');
  });

  it('upgrade when signed in, confirmed free, no models', () => {
    expect(computeGateVerdict(input({ signedIn: true, isFree: true }))).toBe('upgrade');
  });

  it('pick-model when signed in free with models', () => {
    expect(computeGateVerdict(input({ signedIn: true, isFree: true, hasModels: true }))).toBe('pick-model');
  });

  it('configure-model when signed in (member or unknown membership) with no models', () => {
    expect(computeGateVerdict(input({ signedIn: true }))).toBe('configure-model');
  });

  it('ok when the server snapshot reports modelsReady even with an empty local cache', () => {
    expect(computeGateVerdict(input({ modelsReady: true }))).toBe('ok');
    expect(computeGateVerdict(input({ modelsReady: true, hasModels: true }))).toBe('ok');
  });

  it('chatModel beats modelsReady; hasModels beats login; login beats upgrade', () => {
    expect(computeGateVerdict(input({ chatModel: 'x', modelsReady: true }))).toBe('ok');
    expect(computeGateVerdict(input({ hasModels: true, signedIn: false }))).toBe('pick-model');
    expect(computeGateVerdict(input({ signedIn: false, isFree: true }))).toBe('login');
  });
});

describe('mapDaemonAuthError', () => {
  function authError(code: number, details?: unknown): DaemonApiError {
    return new DaemonApiError({ code, msg: `auth error ${code}`, requestId: 'req_1', details });
  }

  it('40110 provisioning_required → configure-model', () => {
    expect(mapDaemonAuthError(authError(40110), { hasModels: true })).toBe('configure-model');
    expect(mapDaemonAuthError(authError(40110), { hasModels: false })).toBe('configure-model');
  });

  it('40111 token_missing on the managed provider → login', () => {
    expect(mapDaemonAuthError(authError(40111, { provider_id: 'managed:kimi-code' }), { hasModels: true })).toBe('login');
  });

  it('40111 token_missing on a custom provider → configure-model', () => {
    expect(mapDaemonAuthError(authError(40111, { provider_id: 'openai' }), { hasModels: true })).toBe('configure-model');
  });

  it('40111 with missing / non-object / unknown details falls back to configure-model', () => {
    expect(mapDaemonAuthError(authError(40111), { hasModels: true })).toBe('configure-model');
    expect(mapDaemonAuthError(authError(40111, null), { hasModels: true })).toBe('configure-model');
    expect(mapDaemonAuthError(authError(40111, 'managed:kimi-code'), { hasModels: true })).toBe('configure-model');
    expect(mapDaemonAuthError(authError(40111, { provider_id: 42 }), { hasModels: true })).toBe('configure-model');
    expect(mapDaemonAuthError(authError(40111, { provider_id: 'unknown:id' }), { hasModels: true })).toBe('configure-model');
  });

  it('40112 token_unauthorized → login (independent of the /auth probe)', () => {
    expect(mapDaemonAuthError(authError(40112, { provider_id: 'openai' }), { hasModels: true })).toBe('login');
  });

  it('40113 model_not_resolved → pick-model with models, configure-model without', () => {
    expect(mapDaemonAuthError(authError(40113, { model_id: 'gone/model' }), { hasModels: true })).toBe('pick-model');
    expect(mapDaemonAuthError(authError(40113, { model_id: 'gone/model' }), { hasModels: false })).toBe('configure-model');
  });

  it('returns null for non-auth errors and non-daemon errors', () => {
    expect(mapDaemonAuthError(authError(40401), { hasModels: true })).toBeNull();
    expect(mapDaemonAuthError(authError(40901), { hasModels: false })).toBeNull();
    expect(mapDaemonAuthError(new Error('network down'), { hasModels: true })).toBeNull();
    expect(mapDaemonAuthError('40110', { hasModels: true })).toBeNull();
    expect(mapDaemonAuthError(null, { hasModels: true })).toBeNull();
  });
});
