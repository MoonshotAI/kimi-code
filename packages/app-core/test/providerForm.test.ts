import { describe, expect, it } from 'vitest';
import {
  buildAddProviderInput,
  buildUpdateProviderInput,
  emptyModelRow,
  fetchedModelToRow,
  isManagedOAuthProvider,
  PROVIDER_TYPES,
  providerModelRows,
  validateProviderForm,
  type ModelRow,
  type ProviderFormState,
} from '../src/lib/providerForm';

function modelRow(overrides: Partial<ModelRow> = {}): ModelRow {
  return {
    model: 'gpt-4.1',
    maxContextSize: '1047576',
    displayName: '',
    capabilities: ['tool_use', 'thinking'],
    supportEfforts: [],
    adaptiveThinking: true,
    ...overrides,
  };
}

function validForm(overrides: Partial<ProviderFormState> = {}): ProviderFormState {
  return {
    id: 'my-openai',
    type: 'openai',
    apiKey: 'sk-test',
    baseUrl: 'https://api.openai.com/v1',
    models: [modelRow()],
    ...overrides,
  };
}

describe('PROVIDER_TYPES', () => {
  it('matches the daemon wire protocols', () => {
    expect(PROVIDER_TYPES).toEqual([
      'kimi',
      'openai',
      'openai_responses',
      'anthropic',
      'google-genai',
      'vertexai',
    ]);
  });
});

describe('validateProviderForm', () => {
  it('accepts a valid form', () => {
    expect(validateProviderForm(validForm())).toBeNull();
  });

  it('requires the provider id', () => {
    expect(validateProviderForm(validForm({ id: '  ' }))).toBe('idRequired');
  });

  it('enforces the server id pattern', () => {
    expect(validateProviderForm(validForm({ id: 'bad!id' }))).toBe('idInvalid');
    expect(validateProviderForm(validForm({ id: '-lead-dash' }))).toBe('idInvalid');
    expect(validateProviderForm(validForm({ id: 'ok-id_2' }))).toBeNull();
    expect(validateProviderForm(validForm({ id: '测试 Kimi' }))).toBeNull();
    expect(validateProviderForm(validForm({ id: 'My OpenAI' }))).toBeNull();
  });

  it('requires the api key and base url only when the caller asks (add path)', () => {
    expect(
      validateProviderForm(validForm({ apiKey: '  ' }), { requireApiKey: true, requireBaseUrl: true }),
    ).toBe('apiKeyRequired');
    expect(
      validateProviderForm(validForm({ baseUrl: ' ' }), { requireApiKey: true, requireBaseUrl: true }),
    ).toBe('baseUrlRequired');
    expect(validateProviderForm(validForm({ apiKey: '  ', baseUrl: ' ' }))).toBeNull();
  });

  it('requires at least one model row with a model id', () => {
    expect(validateProviderForm(validForm({ models: [] }))).toBe('modelRequired');
    expect(
      validateProviderForm(validForm({ models: [modelRow({ model: ' ', maxContextSize: '128000' })] })),
    ).toBe('modelRequired');
  });

  it('requires a positive integer max context size', () => {
    const withSize = (maxContextSize: string) =>
      validateProviderForm(validForm({ models: [modelRow({ maxContextSize })] }));
    expect(withSize('')).toBe('contextSizeRequired');
    expect(withSize('abc')).toBe('contextSizeInvalid');
    expect(withSize('12.5')).toBe('contextSizeInvalid');
    expect(withSize('0')).toBe('contextSizeInvalid');
    expect(withSize('128000')).toBeNull();
  });
});

describe('buildAddProviderInput', () => {
  it('trims fields, parses the context size, and drops blank optionals', () => {
    const input = buildAddProviderInput(
      validForm({
        id: ' my-openai ',
        apiKey: '  ',
        baseUrl: ' ',
        models: [
          modelRow({ model: ' gpt-4.1 ', displayName: ' ', capabilities: [], adaptiveThinking: undefined }),
          modelRow({ model: 'gpt-4.1-mini', displayName: ' Mini ' }),
        ],
      }),
    );
    expect(input).toEqual({
      id: 'my-openai',
      type: 'openai',
      models: [
        { model: 'gpt-4.1', maxContextSize: 1047576 },
        {
          model: 'gpt-4.1-mini',
          maxContextSize: 1047576,
          displayName: 'Mini',
          capabilities: ['tool_use', 'thinking'],
          adaptiveThinking: true,
        },
      ],
    });
  });
});

describe('buildUpdateProviderInput', () => {
  const existing = {
    id: 'my-openai',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4.1',
    hasApiKey: true,
    status: 'connected' as const,
  };

  it('omits a blank api key (keep the stored one) and a blank base url', () => {
    const input = buildUpdateProviderInput(validForm({ apiKey: ' ', baseUrl: '' }), existing);
    expect(input).not.toHaveProperty('apiKey');
    expect(input).not.toHaveProperty('baseUrl');
  });

  it('sends a blank api key as a clear once the stored key was loaded into the form', () => {
    const input = buildUpdateProviderInput(
      validForm({ apiKey: ' ' }),
      existing,
      { includeBlankApiKey: true },
    );
    expect(input.apiKey).toBe('');
  });

  it('sends a newly entered api key and the trimmed base url', () => {
    const input = buildUpdateProviderInput(
      validForm({ apiKey: ' sk-new ', baseUrl: ' https://gw.example.com/v1 ' }),
      existing,
    );
    expect(input.apiKey).toBe('sk-new');
    expect(input.baseUrl).toBe('https://gw.example.com/v1');
  });

  it('sends new_id only when the name changed', () => {
    expect(
      buildUpdateProviderInput(validForm({ id: 'renamed' }), existing).newId,
    ).toBe('renamed');
    expect(
      buildUpdateProviderInput(validForm({ id: 'my-openai' }), existing).newId,
    ).toBeUndefined();
  });

  it('preserves the configured default model only while it matches a model row', () => {
    expect(
      buildUpdateProviderInput(validForm(), existing, {
        existingDefaultModel: 'my-openai/gpt-4.1',
      }).defaultModel,
    ).toBe('gpt-4.1');
    expect(
      buildUpdateProviderInput(
        validForm({ models: [modelRow({ model: 'gpt-4.1-mini' })] }),
        existing,
        { existingDefaultModel: 'my-openai/gpt-4.1' },
      ).defaultModel,
    ).toBeUndefined();
    expect(
      buildUpdateProviderInput(validForm(), {
        ...existing,
        defaultModel: 'my-openai/gpt-4.1',
      }).defaultModel,
    ).toBeUndefined();
    expect(
      buildUpdateProviderInput(validForm({ models: [modelRow({ model: 'openai/gpt-4o' })] }), existing, {
        existingDefaultModel: 'openrouter/openai/gpt-4o',
      }).defaultModel,
    ).toBe('openai/gpt-4o');
  });
});

describe('isManagedOAuthProvider', () => {
  it('flags only the fixed managed id + kimi type pair', () => {
    expect(isManagedOAuthProvider({ id: 'managed:kimi-code', type: 'kimi' })).toBe(true);
    expect(isManagedOAuthProvider({ id: 'managed:kimi-code', type: 'openai' })).toBe(false);
    expect(isManagedOAuthProvider({ id: 'my-kimi', type: 'kimi' })).toBe(false);
    expect(isManagedOAuthProvider({ id: 'my-openai', type: 'openai' })).toBe(false);
  });
});

describe('providerModelRows', () => {
  const provider = {
    id: 'mock-anthropic',
    type: 'anthropic',
    hasApiKey: true,
    status: 'connected' as const,
  };

  it('builds rows from config model records with bare model ids (never the alias)', () => {
    const rows = providerModelRows(provider, {
      'mock/kimi-highspeed': {
        provider: 'mock-anthropic',
        model: 'mock kimi',
        maxContextSize: 262144,
        displayName: 'Mock Anthropic (local)',
        capabilities: ['thinking', 'always_thinking', 'tool_use'],
        supportEfforts: ['low', 'max'],
        adaptiveThinking: true,
      },
      'other/x': { provider: 'other', model: 'x', max_context_size: 1 },
    });
    expect(rows).toEqual([
      {
        model: 'mock kimi',
        maxContextSize: '262144',
        displayName: 'Mock Anthropic (local)',
        capabilities: ['thinking', 'always_thinking', 'tool_use'],
        supportEfforts: ['low', 'max'],
        adaptiveThinking: true,
      },
    ]);
  });

  it('ignores other providers and tolerates missing record fields', () => {
    expect(providerModelRows(provider, { 'a/b': { provider: 'other', model: 'b' } })).toEqual([]);
    expect(providerModelRows(provider, { 'a/b': { provider: 'mock-anthropic' } })).toEqual([
      { model: '', maxContextSize: '', displayName: '', capabilities: [], supportEfforts: [] },
    ]);
    expect(providerModelRows(provider, undefined)).toEqual([]);
  });
});

describe('emptyModelRow', () => {
  it('starts blank with tool_use + thinking on and adaptive thinking defaulted', () => {
    expect(emptyModelRow()).toEqual({
      model: '',
      maxContextSize: '',
      displayName: '',
      capabilities: ['tool_use', 'thinking'],
      supportEfforts: [],
      adaptiveThinking: true,
    });
  });
});

describe('fetchedModelToRow', () => {
  it('carries fetched vision capabilities, context size, and efforts into the provider payload', () => {
    const row = fetchedModelToRow(
      {
        id: 'example-vision-pro',
        displayName: 'Example Vision Pro',
        maxContextSize: 1048576,
        capabilities: ['thinking', 'always_thinking', 'image_in', 'video_in', 'tool_use'],
        supportEfforts: ['low', 'high', 'max'],
      },
      '256000',
    );
    const input = buildAddProviderInput(validForm({ models: [row] }));
    expect(input.models).toEqual([
      {
        model: 'example-vision-pro',
        maxContextSize: 1048576,
        displayName: 'Example Vision Pro',
        capabilities: ['thinking', 'always_thinking', 'image_in', 'video_in', 'tool_use'],
        supportEfforts: ['low', 'high', 'max'],
        adaptiveThinking: true,
      },
    ]);
  });

  it('keeps the existing defaults when the endpoint returns only model ids', () => {
    const row = fetchedModelToRow({ id: 'gpt-4.1', ownedBy: 'openai' }, '256000');
    expect(row).toEqual({
      model: 'gpt-4.1',
      maxContextSize: '256000',
      displayName: '',
      capabilities: ['tool_use', 'thinking'],
      supportEfforts: [],
      adaptiveThinking: true,
    });
  });

  it('clears adaptiveThinking when fetched capabilities explicitly omit thinking', () => {
    const row = fetchedModelToRow(
      { id: 'vision-plain', capabilities: ['image_in', 'tool_use'] },
      '256000',
    );
    expect(row.adaptiveThinking).toBe(false);
    const input = buildAddProviderInput(validForm({ type: 'anthropic', models: [row] }));
    expect(input.models).toEqual([
      {
        model: 'vision-plain',
        maxContextSize: 256000,
        capabilities: ['image_in', 'tool_use'],
        adaptiveThinking: false,
      },
    ]);
  });
});
