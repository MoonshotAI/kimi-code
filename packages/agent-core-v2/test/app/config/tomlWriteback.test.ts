import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IMAGE_SECTION, type ImageConfig } from '#/agent/media/configSection';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import { planConfigWriteback, replaceThinkingEffortMax, type DomainUpdate } from '#/app/config/tomlWriteback';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { stubLog } from '../../_base/log/stubs';
import { stubBootstrap } from '../bootstrap/stubs';

describe('planConfigWriteback', () => {
  function edit(
    text: string,
    snakeKey: string,
    previousValue: unknown,
    nextValue: unknown,
    expected: Record<string, unknown>,
  ): string | undefined {
    const update: DomainUpdate = { snakeKey, previousValue, nextValue };
    return planConfigWriteback(text, [update], expected);
  }

  it('rewrites only the changed statement and keeps adjacent comments and key formatting', () => {
    const text = ['[image]', '# keep me', 'max_edge_px   =   1500', 'quality = "high"', ''].join('\n');
    const result = edit(text, 'image', { max_edge_px: 1500, quality: 'high' }, { max_edge_px: 2000, quality: 'high' }, {
      image: { max_edge_px: 2000, quality: 'high' },
    });
    expect(result).toBe('[image]\n# keep me\nmax_edge_px   =   2000\nquality = "high"\n');
  });

  it('keeps the trailing comment of a changed statement', () => {
    const text = 'default_model = "kimi-k2"   # pick one\n';
    const result = edit(text, 'default_model', 'kimi-k2', 'kimi-k3', { default_model: 'kimi-k3' });
    expect(result).toBe('default_model = "kimi-k3"   # pick one\n');
  });

  it('appends a new key after the last statement of its block, before trailing trivia', () => {
    const text = ['[image]', 'max_edge_px = 1500', '# tail note', ''].join('\n');
    const result = edit(text, 'image', { max_edge_px: 1500 }, { max_edge_px: 1500, read_byte_budget: 5000 }, {
      image: { max_edge_px: 1500, read_byte_budget: 5000 },
    });
    expect(result).toBe('[image]\nmax_edge_px = 1500\nread_byte_budget = 5000\n# tail note\n');
  });

  it('inserts into an empty table right after its header', () => {
    const text = '[image]\n';
    const result = edit(text, 'image', {}, { max_edge_px: 1500 }, { image: { max_edge_px: 1500 } });
    expect(result).toBe('[image]\nmax_edge_px = 1500\n');
  });

  it('deletes only the removed key line and keeps surrounding comments', () => {
    const text = ['[image]', '# about edge', 'max_edge_px = 1500', 'quality = "high"', ''].join('\n');
    const result = edit(text, 'image', { max_edge_px: 1500, quality: 'high' }, { quality: 'high' }, {
      image: { quality: 'high' },
    });
    expect(result).toBe('[image]\n# about edge\nquality = "high"\n');
  });

  it('edits one provider in place, drops a removed provider block and appends a new one', () => {
    const text = [
      '[providers]',
      '',
      '# acme provider',
      '[providers.acme]',
      'base_url = "https://acme.example.com"',
      'api_key = "acme-key"',
      '',
      '[providers.beta]',
      'base_url = "https://beta.example.com"',
      'api_key = "beta-key"',
      '',
    ].join('\n');
    const gamma = { base_url: 'https://gamma.example.com', api_key: 'gamma-key' };
    const result = edit(
      text,
      'providers',
      {
        acme: { base_url: 'https://acme.example.com', api_key: 'acme-key' },
        beta: { base_url: 'https://beta.example.com', api_key: 'beta-key' },
      },
      {
        acme: { base_url: 'https://acme.example.com', api_key: 'acme-key-2' },
        gamma,
      },
      {
        providers: {
          acme: { base_url: 'https://acme.example.com', api_key: 'acme-key-2' },
          gamma,
        },
      },
    );
    expect(result).toBe(
      [
        '[providers]',
        '',
        '# acme provider',
        '[providers.acme]',
        'base_url = "https://acme.example.com"',
        'api_key = "acme-key-2"',
        '',
        '[providers.gamma]',
        'base_url = "https://gamma.example.com"',
        'api_key = "gamma-key"',
        '',
      ].join('\n'),
    );
  });

  it('edits nested sub-tables without touching sibling lines', () => {
    const text = [
      '[providers.acme.limits]',
      'rpm = 100',
      '',
      '[providers.acme]',
      'base_url = "https://acme.example.com"',
      '',
    ].join('\n');
    const result = edit(
      text,
      'providers',
      { acme: { limits: { rpm: 100 }, base_url: 'https://acme.example.com' } },
      { acme: { limits: { rpm: 200 }, base_url: 'https://acme.example.com' } },
      { providers: { acme: { limits: { rpm: 200 }, base_url: 'https://acme.example.com' } } },
    );
    expect(result).toBe(
      ['[providers.acme.limits]', 'rpm = 200', '', '[providers.acme]', 'base_url = "https://acme.example.com"', ''].join(
        '\n',
      ),
    );
  });

  it('falls back to re-serializing a dotted-key domain while preserving other domains', () => {
    const text = 'a.b = 1\n\n[cool]\nx = 1\n';
    const result = edit(text, 'a', { b: 1 }, { b: 2 }, { a: { b: 2 }, cool: { x: 1 } });
    expect(result).toBe('[a]\nb = 2\n\n[cool]\nx = 1\n');
  });

  it('re-serializes a changed array-of-tables domain and keeps untouched ones byte-for-byte', () => {
    const text = ['[[models]]', 'name = "m1"', '', '[[pinned]]', 'x = 1', ''].join('\n');
    const result = edit(text, 'models', [{ name: 'm1' }], [{ name: 'm1' }, { name: 'm2' }], {
      models: [{ name: 'm1' }, { name: 'm2' }],
      pinned: [{ x: 1 }],
    });
    expect(result).toBe(['[[models]]', 'name = "m1"', '', '[[models]]', 'name = "m2"', '', '[[pinned]]', 'x = 1', ''].join('\n'));
  });

  it('does not treat multiline string bodies or bracketed array items as table headers', () => {
    const text = [
      '[custom]',
      'notes = """',
      '[fake]',
      '"""',
      'list = [ "]", "[" ]',
      '',
      '[image]',
      'max_edge_px = 1500',
      '',
    ].join('\n');
    const result = edit(text, 'image', { max_edge_px: 1500 }, { max_edge_px: 2000 }, {
      custom: { notes: '[fake]\n', list: [']', '['] },
      image: { max_edge_px: 2000 },
    });
    expect(result).toBe(
      [
        '[custom]',
        'notes = """',
        '[fake]',
        '"""',
        'list = [ "]", "[" ]',
        '',
        '[image]',
        'max_edge_px = 2000',
        '',
      ].join('\n'),
    );
  });

  it('preserves CRLF everywhere and writes the edited statement with CRLF', () => {
    const text = '# note\r\n[image]\r\nmax_edge_px = 1500\r\n';
    const result = edit(text, 'image', { max_edge_px: 1500 }, { max_edge_px: 2000 }, {
      image: { max_edge_px: 2000 },
    });
    expect(result).toBe('# note\r\n[image]\r\nmax_edge_px = 2000\r\n');
  });

  it('returns the original text unchanged when nothing differs', () => {
    const text = '[image]\nmax_edge_px = 1500\n';
    const result = edit(text, 'image', { max_edge_px: 1500 }, { max_edge_px: 1500 }, {
      image: { max_edge_px: 1500 },
    });
    expect(result).toBe(text);
  });

  it('appends a new domain to a file without a trailing newline', () => {
    const text = '[image]\nmax_edge_px = 1500';
    const result = edit(text, 'thinking', undefined, { effort: 'high' }, {
      image: { max_edge_px: 1500 },
      thinking: { effort: 'high' },
    });
    expect(result).toBe('[image]\nmax_edge_px = 1500\n[thinking]\neffort = "high"\n');
  });

  it('removes a deleted domain region and keeps neighboring trivia', () => {
    const text = ['# head', '[image]', 'max_edge_px = 1500', '', '# tail', '[tail]', 'x = 1', ''].join('\n');
    const result = edit(text, 'image', { max_edge_px: 1500 }, undefined, { tail: { x: 1 } });
    expect(result).toBe('# head\n\n# tail\n[tail]\nx = 1\n');
  });

  it('replaces a multiline array statement wholesale', () => {
    const text = 'override_models = [\n  "a",\n  "b",\n]\n';
    const result = edit(text, 'override_models', ['a', 'b'], ['a', 'c'], { override_models: ['a', 'c'] });
    expect(result).toBe('override_models = [ "a", "c" ]\n');
  });

  it('declines to plan when the file contains constructs it cannot map', () => {
    const text = '"weird key" = 1\n';
    expect(edit(text, 'weird_key', 1, 2, { weird_key: 2 })).toBeUndefined();
  });

  it('declines to plan when the data and the text disagree about a domain', () => {
    const text = '[image]\nmax_edge_px = 1500\n';
    expect(edit(text, 'image', undefined, { max_edge_px: 2000 }, { image: { max_edge_px: 2000 } })).toBeUndefined();
  });

  it('preserves a quoted sub-table header and its comments on an unrelated write', () => {
    const text = '[models."acme/m1"]\n# model note\nname = "m1"\n\n[image]\nmax_edge_px = 1500\n';
    const result = edit(text, 'image', { max_edge_px: 1500 }, { max_edge_px: 2000 }, {
      models: { 'acme/m1': { name: 'm1' } },
      image: { max_edge_px: 2000 },
    });
    expect(result).toBe('[models."acme/m1"]\n# model note\nname = "m1"\n\n[image]\nmax_edge_px = 2000\n');
  });

  it('preserves a literal-quoted sub-table header on an unrelated write', () => {
    const text = "[models.'acme/m1']\nname = \"m1\"\n\n[image]\nmax_edge_px = 1500\n";
    const result = edit(text, 'image', { max_edge_px: 1500 }, { max_edge_px: 2000 }, {
      models: { 'acme/m1': { name: 'm1' } },
      image: { max_edge_px: 2000 },
    });
    expect(result).toBe("[models.'acme/m1']\nname = \"m1\"\n\n[image]\nmax_edge_px = 2000\n");
  });

  it('preserves a whitespace-padded quoted header and a quoted root key holding a dot', () => {
    const text = '[ models . "acme/m1" ]\nname = "m1"\n\n["x.y"]\nv = 1\n\n[image]\nmax_edge_px = 1500\n';
    const result = edit(text, 'image', { max_edge_px: 1500 }, { max_edge_px: 2000 }, {
      models: { 'acme/m1': { name: 'm1' } },
      'x.y': { v: 1 },
      image: { max_edge_px: 2000 },
    });
    expect(result).toBe('[ models . "acme/m1" ]\nname = "m1"\n\n["x.y"]\nv = 1\n\n[image]\nmax_edge_px = 2000\n');
  });

  it('edits inside a quoted sub-table region at key level', () => {
    const text = '[models."acme/m1"]\n# keep\nname = "m1"\nmax_context_size = 1000\n';
    const result = edit(
      text,
      'models',
      { 'acme/m1': { name: 'm1', max_context_size: 1000 } },
      { 'acme/m1': { name: 'm1x', max_context_size: 1000 } },
      { models: { 'acme/m1': { name: 'm1x', max_context_size: 1000 } } },
    );
    expect(result).toBe('[models."acme/m1"]\n# keep\nname = "m1x"\nmax_context_size = 1000\n');
  });

  it('removes one quoted model entry and appends another with a quoted header', () => {
    const text = '[models."acme/m1"]\nname = "m1"\n';
    const result = edit(text, 'models', { 'acme/m1': { name: 'm1' } }, { 'beta/m2': { name: 'm2' } }, {
      models: { 'beta/m2': { name: 'm2' } },
    });
    expect(result).toBe('[models."beta/m2"]\nname = "m2"\n');
  });

  it('handles escaped quotes inside quoted header segments', () => {
    const text = '[models."a\\"b"]\nname = "m1"\n\n[image]\nmax_edge_px = 1500\n';
    const preserved = edit(text, 'image', { max_edge_px: 1500 }, { max_edge_px: 2000 }, {
      models: { 'a"b': { name: 'm1' } },
      image: { max_edge_px: 2000 },
    });
    expect(preserved).toBe('[models."a\\"b"]\nname = "m1"\n\n[image]\nmax_edge_px = 2000\n');
    const result = edit(
      '[models."a\\"b"]\nname = "m1"\n',
      'models',
      { 'a"b': { name: 'm1' } },
      { 'a"b': { name: 'm2' } },
      { models: { 'a"b': { name: 'm2' } } },
    );
    expect(result).toBe('[models."a\\"b"]\nname = "m2"\n');
  });

  it('declines to plan on malformed quoted headers', () => {
    const expected = { image: { max_edge_px: 2000 } };
    expect(edit('[""]\nv = 1\n', 'image', { max_edge_px: 1500 }, { max_edge_px: 2000 }, expected)).toBeUndefined();
    expect(
      edit('[models."unterminated]\nname = "m1"\n', 'image', { max_edge_px: 1500 }, { max_edge_px: 2000 }, expected),
    ).toBeUndefined();
    expect(
      edit('[models."a\\qb"]\nname = "m1"\n', 'image', { max_edge_px: 1500 }, { max_edge_px: 2000 }, expected),
    ).toBeUndefined();
  });
});

describe('replaceThinkingEffortMax', () => {
  it('replaces effort = "max" with "high" inside the thinking region', () => {
    const text = '# thinking config\n[thinking]\n# do not touch\neffort = "max"\n';
    expect(replaceThinkingEffortMax(text)).toBe('# thinking config\n[thinking]\n# do not touch\neffort = "high"\n');
  });

  it('keeps the trailing comment on the effort line', () => {
    const text = '[thinking]\neffort = "max"  # legacy\n';
    expect(replaceThinkingEffortMax(text)).toBe('[thinking]\neffort = "high"  # legacy\n');
  });

  it('handles CRLF files', () => {
    const text = '[thinking]\r\neffort = "max"\r\n';
    expect(replaceThinkingEffortMax(text)).toBe('[thinking]\r\neffort = "high"\r\n');
  });

  it('returns undefined when there is no single thinking region', () => {
    expect(replaceThinkingEffortMax('[other]\nx = 1\n')).toBeUndefined();
    expect(replaceThinkingEffortMax('[thinking]\neffort = "high"\n[thinking]\neffort = "max"\n')).toBeUndefined();
  });

  it('returns undefined when effort is not a plain "max" literal', () => {
    expect(replaceThinkingEffortMax('[thinking]\neffort = "medium"\n')).toBeUndefined();
    expect(replaceThinkingEffortMax('[thinking]\neffort = """\nmax\n"""\n')).toBeUndefined();
  });
});

describe('ConfigService key-level writeback', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-v2-keyedit-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('keeps an adjacent comment inside [image] when setting maxEdgePx', async () => {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    const seed = ['[image]', '# do not touch', 'max_edge_px   =   1500', 'extra = "keep"', ''].join('\n');
    await storage.write('', 'config.toml', new TextEncoder().encode(seed));
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap(homeDir));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    await config.set(IMAGE_SECTION, { maxEdgePx: 2000 });

    const bytes = await storage.read('', 'config.toml');
    const text = new TextDecoder().decode(bytes!);
    expect(text).toBe('[image]\n# do not touch\nmax_edge_px   =   2000\nextra = "keep"\n');
    const parsed = parseToml(text) as Record<string, unknown>;
    expect(parsed['image']).toEqual({ max_edge_px: 2000, extra: 'keep' });
    expect(config.get<ImageConfig>(IMAGE_SECTION)).toEqual({ maxEdgePx: 2000 });

    disposables.dispose();
  });
});
