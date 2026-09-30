import { describe, expect, it } from 'vitest';

import type { ExportSessionResult } from '@moonshot-ai/harness-core';
import type { KimiConfigFacade } from '@moonshot-ai/kimi-code-sdk';

import { handleExport, type ExportDeps } from '#/cli/sub/export';
import { handleFork, type ForkDeps } from '#/cli/sub/fork';
import {
  handleProviderAdd,
  handleProviderAddRegistry,
  handleProviderList,
  handleProviderRemove,
  handleProviderSetDefault,
  type ProviderDeps,
} from '#/cli/sub/provider';
import {
  handleSessionDelete,
  handleSessionList,
  handleSessionRename,
  type SessionDeps,
} from '#/cli/sub/session';
import type { SessionListEntry } from '#/utils/sessions';

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit(${String(code)})`);
  }
}

function writer() {
  let text = '';
  return {
    write: (chunk: string) => {
      text += chunk;
      return true;
    },
    text: () => text,
  };
}

function exit() {
  return (code: number): never => {
    throw new ExitCalled(code);
  };
}

function entry(id: string, title?: string, updatedAtMs = 0): SessionListEntry {
  return { id, title, updatedAtMs };
}

function exportResult(zipPath: string): ExportSessionResult {
  return {
    zipPath,
    entries: [],
    sessionDir: `/sessions/${zipPath}`,
    manifest: { sessionId: 's1', exportedAt: '', kimiCodeVersion: '0.0.0', os: '', nodejsVersion: '' },
  };
}

function memoryConfig(initial: Record<string, unknown>): KimiConfigFacade {
  const state = new Map(Object.entries(initial));
  return {
    get: <T,>(name: string) => state.get(name) as T,
    set: async (name, value) => {
      state.set(name, value);
    },
    replace: async (sections) => {
      for (const [name, value] of Object.entries(sections)) {
        if (value === undefined || value === null) state.delete(name);
        else state.set(name, value);
      }
    },
    reload: async () => {},
    diagnostics: () => [],
  };
}

function providerDeps(overrides: Partial<ProviderDeps>) {
  const stdout = writer();
  const stderr = writer();
  return {
    config: memoryConfig({}),
    modelsDev: {
      getProvider: async () => {
        throw new Error('not found');
      },
      importProvider: async () => {
        throw new Error('not implemented');
      },
      importRegistry: async () => {
        throw new Error('not implemented');
      },
    },
    setDefaultModel: async () => {},
    env: {},
    exit: exit(),
    ...overrides,
    stdout,
    stderr,
  };
}

describe('kimi export', () => {
  function exportDeps(overrides: Partial<ExportDeps>) {
    const stdout = writer();
    const stderr = writer();
    return {
      listSessions: async () => [],
      exportSession: async () => exportResult('/tmp/out.zip'),
      confirmPreviousSession: async () => true,
      getInstallSource: async () => 'npm',
      getShellEnv: () => ({ term: 'xterm' }),
      exit: exit(),
      ...overrides,
      stdout,
      stderr,
    };
  }

  it('exports an explicit session id without confirmation', async () => {
    const exported: Array<{ id: string; opts: unknown }> = [];
    const deps = exportDeps({
      exportSession: async (id, opts) => {
        exported.push({ id, opts });
        return exportResult('/tmp/ses-1.zip');
      },
      confirmPreviousSession: async () => {
        throw new Error('must not confirm for an explicit id');
      },
    });

    await handleExport(deps, 'ses-1', '/tmp/custom.zip', { yes: false, includeGlobalLog: false });

    expect(exported).toEqual([
      {
        id: 'ses-1',
        opts: {
          outputPath: '/tmp/custom.zip',
          includeGlobalLog: false,
          installSource: 'npm',
          shellEnv: { term: 'xterm' },
        },
      },
    ]);
    expect(deps.stdout.text()).toBe('/tmp/ses-1.zip\n');
  });

  it('exports the most recent session after confirmation', async () => {
    const deps = exportDeps({
      listSessions: async () => [entry('ses-latest', 'Fix bug'), entry('ses-older')],
      exportSession: async (id) => exportResult(`/tmp/${id}.zip`),
    });

    await handleExport(deps, undefined, undefined, { yes: false, includeGlobalLog: true });

    expect(deps.stdout.text()).toBe('/tmp/ses-latest.zip\n');
  });

  it('cancels when the previous-session confirmation is declined', async () => {
    let exportCalled = false;
    const deps = exportDeps({
      listSessions: async () => [entry('ses-latest')],
      confirmPreviousSession: async () => false,
      exportSession: async () => {
        exportCalled = true;
        return exportResult('/tmp/unused.zip');
      },
    });

    await handleExport(deps, undefined, undefined, { yes: false, includeGlobalLog: true });

    expect(exportCalled).toBe(false);
    expect(deps.stdout.text()).toBe('Export cancelled.\n');
  });

  it('fails when there is no previous session', async () => {
    const deps = exportDeps({});

    await expect(
      handleExport(deps, undefined, undefined, { yes: true, includeGlobalLog: true }),
    ).rejects.toBeInstanceOf(ExitCalled);
    expect(deps.stderr.text()).toContain('No previous session found to export.');
  });
});

describe('kimi fork', () => {
  function forkDeps(overrides: Partial<ForkDeps>) {
    const stdout = writer();
    const stderr = writer();
    return {
      listSessions: async () => [],
      forkSession: async (id: string) => `${id}-fork`,
      confirmPreviousSession: async () => true,
      exit: exit(),
      ...overrides,
      stdout,
      stderr,
    };
  }

  it('forks an explicit session id and prints the new id', async () => {
    const deps = forkDeps({});

    await handleFork(deps, 'ses-1', { yes: false });

    expect(deps.stdout.text()).toBe('Forked to ses-1-fork\n');
  });

  it('forks the most recent session after confirmation', async () => {
    const forked: string[] = [];
    const deps = forkDeps({
      listSessions: async () => [entry('ses-latest'), entry('ses-older')],
      forkSession: async (id) => {
        forked.push(id);
        return 'ses-new';
      },
    });

    await handleFork(deps, undefined, { yes: false });

    expect(forked).toEqual(['ses-latest']);
    expect(deps.stdout.text()).toBe('Forked to ses-new\n');
  });

  it('fails when there is no previous session', async () => {
    const deps = forkDeps({});

    await expect(handleFork(deps, undefined, { yes: true })).rejects.toBeInstanceOf(ExitCalled);
    expect(deps.stderr.text()).toContain('No previous session found to fork.');
  });
});

describe('kimi session', () => {
  function sessionDeps(overrides: Partial<SessionDeps>) {
    const stdout = writer();
    const stderr = writer();
    return {
      listSessions: async () => [],
      deleteSession: async () => {},
      renameSession: async () => {},
      exit: exit(),
      ...overrides,
      stdout,
      stderr,
    };
  }

  it('lists sessions with timestamps and titles', async () => {
    const deps = sessionDeps({
      listSessions: async () => [
        entry('ses-1', 'Fix\nbug', new Date('2026-09-01T10:30:00').getTime()),
        entry('ses-2', undefined, new Date('2026-09-01T09:00:00').getTime()),
      ],
    });

    await handleSessionList(deps, { json: false });

    const lines = deps.stdout.text().split('\n');
    expect(lines[0]).toContain('ses-1');
    expect(lines[0]).toContain('Fix bug');
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    expect(lines[1]).toContain('ses-2');
  });

  it('limits and emits JSON', async () => {
    const entries = [entry('ses-1'), entry('ses-2'), entry('ses-3')];
    const deps = sessionDeps({ listSessions: async () => entries });

    await handleSessionList(deps, { json: true, limit: 2 });

    const parsed = JSON.parse(deps.stdout.text()) as unknown[];
    expect(parsed).toHaveLength(2);
  });

  it('deletes a session', async () => {
    const deleted: string[] = [];
    const deps = sessionDeps({
      deleteSession: async (id) => {
        deleted.push(id);
      },
    });

    await handleSessionDelete(deps, 'ses-1');

    expect(deleted).toEqual(['ses-1']);
    expect(deps.stdout.text()).toContain('Deleted session ses-1.');
  });

  it('renames a session and reports failures on stderr', async () => {
    const ok = sessionDeps({
      renameSession: async () => {},
    });
    await handleSessionRename(ok, 'ses-1', 'New title');
    expect(ok.stdout.text()).toContain('Renamed session ses-1.');

    const failing = sessionDeps({
      renameSession: async () => {
        throw new Error('Session title is empty.');
      },
    });
    await expect(handleSessionRename(failing, 'ses-1', ' ')).rejects.toBeInstanceOf(ExitCalled);
    expect(failing.stderr.text()).toContain('Session title is empty.');
  });
});

describe('kimi provider', () => {
  it('lists providers with model counts and the default model', async () => {
    const deps = providerDeps({
      config: memoryConfig({
        providers: { anthropic: { type: 'anthropic' }, openai: { type: 'openai' } },
        models: { 'anthropic/claude': {}, 'openai/gpt': {}, 'openai/o1': {} },
        defaultModel: 'openai/gpt',
      }),
    });

    await handleProviderList(deps, { json: false });

    const out = deps.stdout.text();
    expect(out).toContain('anthropic  models=1');
    expect(out).toContain('openai  models=2');
    expect(out).toContain('Default model: openai/gpt');
  });

  it('prints a hint when no providers are configured', async () => {
    const deps = providerDeps({});

    await handleProviderList(deps, { json: false });

    expect(deps.stdout.text()).toContain('No providers configured.');
  });

  it('imports a catalog provider and notes a guessed protocol', async () => {
    const imported: unknown[] = [];
    const deps = providerDeps({
      modelsDev: {
        getProvider: async (catalogId: string) => ({
          id: catalogId,
          name: 'OpenAI',
          wire_type: 'openai',
          guessed: true,
          needs_base_url: false,
          rejected: false,
          reject_reason: null,
          env_key: 'OPENAI_API_KEY',
          models: [],
        }),
        importProvider: async (options: unknown) => {
          imported.push(options);
          return {
            provider: { id: 'openai', type: 'openai', has_api_key: true, models: ['gpt'] },
            models_imported: 1,
          };
        },
        importRegistry: async () => {
          throw new Error('not implemented');
        },
      },
    });

    await handleProviderAdd(deps, 'openai', { apiKey: 'sk-test' });

    expect(imported).toEqual([{ catalogId: 'openai', apiKey: 'sk-test', baseUrl: undefined }]);
    expect(deps.stdout.text()).toContain('Imported OpenAI (openai) with 1 model.');
    expect(deps.stdout.text()).toContain('protocol guessed as "openai"');
  });

  it('rejects a catalog provider the catalog marks unsupported', async () => {
    const deps = providerDeps({
      modelsDev: {
        getProvider: async (catalogId: string) => ({
          id: catalogId,
          name: 'Bedrock',
          wire_type: null,
          guessed: false,
          needs_base_url: false,
          rejected: true,
          reject_reason: 'proprietary-sdk',
          env_key: null,
          models: [],
        }),
        importProvider: async () => {
          throw new Error('must not import');
        },
        importRegistry: async () => {
          throw new Error('not implemented');
        },
      },
    });

    await expect(handleProviderAdd(deps, 'bedrock', {})).rejects.toBeInstanceOf(ExitCalled);
    expect(deps.stderr.text()).toContain('cannot be imported: proprietary-sdk');
  });

  it('requires --base-url when the catalog declares no endpoint', async () => {
    const deps = providerDeps({
      modelsDev: {
        getProvider: async (catalogId: string) => ({
          id: catalogId,
          name: 'Custom',
          wire_type: 'openai',
          guessed: false,
          needs_base_url: true,
          rejected: false,
          reject_reason: null,
          env_key: null,
          models: [],
        }),
        importProvider: async () => {
          throw new Error('must not import');
        },
        importRegistry: async () => {
          throw new Error('not implemented');
        },
      },
    });

    await expect(handleProviderAdd(deps, 'custom', {})).rejects.toBeInstanceOf(ExitCalled);
    expect(deps.stderr.text()).toContain('Pass --base-url <url>.');
  });

  it('imports a custom registry and lists the providers', async () => {
    const deps = providerDeps({
      modelsDev: {
        getProvider: async () => {
          throw new Error('not implemented');
        },
        importProvider: async () => {
          throw new Error('not implemented');
        },
        importRegistry: async (options: { url: string }) => ({
          providers: [
            { id: 'one', type: 'openai', has_api_key: false, models: [] },
            { id: 'two', type: 'openai', has_api_key: false, models: [] },
          ],
          models_imported: 3,
          url: options.url,
        }),
      },
    });

    await handleProviderAddRegistry(deps, 'https://example.com/api.json', {});

    const out = deps.stdout.text();
    expect(out).toContain('Imported 2 providers (3 models) from https://example.com/api.json');
    expect(out).toContain('- one');
    expect(out).toContain('- two');
  });

  it('removes a provider with its model aliases and a matching default model', async () => {
    const config = memoryConfig({
      providers: { openai: { type: 'openai' }, anthropic: { type: 'anthropic' } },
      models: { 'openai/gpt': {}, 'anthropic/claude': {} },
      defaultModel: 'openai/gpt',
    });
    const deps = providerDeps({ config });

    await handleProviderRemove(deps, 'openai');

    expect(config.get('providers')).toEqual({ anthropic: { type: 'anthropic' } });
    expect(config.get('models')).toEqual({ 'anthropic/claude': {} });
    expect(config.get<string | undefined>('defaultModel')).toBeUndefined();
    expect(deps.stdout.text()).toContain('Removed provider "openai".');
  });

  it('keeps the default model when removing an unrelated provider', async () => {
    const config = memoryConfig({
      providers: { openai: { type: 'openai' }, anthropic: { type: 'anthropic' } },
      models: { 'openai/gpt': {}, 'anthropic/claude': {} },
      defaultModel: 'anthropic/claude',
    });
    const deps = providerDeps({ config });

    await handleProviderRemove(deps, 'openai');

    expect(config.get('defaultModel')).toBe('anthropic/claude');
  });

  it('fails to remove an unknown provider', async () => {
    const deps = providerDeps({});

    await expect(handleProviderRemove(deps, 'missing')).rejects.toBeInstanceOf(ExitCalled);
    expect(deps.stderr.text()).toContain('Provider "missing" not found.');
  });

  it('sets the default model', async () => {
    const aliases: string[] = [];
    const deps = providerDeps({
      setDefaultModel: async (alias) => {
        aliases.push(alias);
      },
    });

    await handleProviderSetDefault(deps, 'openai/gpt');

    expect(aliases).toEqual(['openai/gpt']);
    expect(deps.stdout.text()).toContain('Default model set to openai/gpt.');
  });
});
