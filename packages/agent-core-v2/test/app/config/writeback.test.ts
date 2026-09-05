import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IMAGE_SECTION, type ImageConfig } from '#/agent/media/configSection';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import { THINKING_SECTION } from '#/app/kosongConfig/configSection';
import { type ThinkingConfig } from '#/kosong/model/thinking';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { stubLog } from '../../_base/log/stubs';
import { stubBootstrap } from '../bootstrap/stubs';

describe('config.toml writeback preservation', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-v2-writeback-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  async function setup(toml: string, env: Record<string, string> = {}) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write('', 'config.toml', new TextEncoder().encode(toml));
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap(homeDir, env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    const readText = async (): Promise<string> => {
      const bytes = await storage.read('', 'config.toml');
      if (bytes === undefined) throw new Error('config.toml missing');
      return new TextDecoder().decode(bytes);
    };
    return { config, disposables, storage, readText };
  }

  function section(parsed: Record<string, unknown>, key: string): Record<string, unknown> {
    return parsed[key] as Record<string, unknown>;
  }

  it('preserves comments, blank lines and untouched domains byte-for-byte on set()', async () => {
    const seed = [
      '# 顶部注释：全局设置',
      'default_model = "kimi-k2"   # 行尾注释',
      '',
      '# 图片配置区块',
      '[image]',
      'max_edge_px = 1500',
      '',
      '# 自定义区域',
      '[custom]',
      'notes = """',
      '第一行',
      '[not_a_header] 这一行以左括号开头',
      '"""',
      'keep_me = "yes"',
      '',
    ].join('\n');
    const { config, disposables, readText } = await setup(seed);

    await config.set(IMAGE_SECTION, { maxEdgePx: 2000 });

    const text = await readText();
    expect(
      text.startsWith(
        '# 顶部注释：全局设置\ndefault_model = "kimi-k2"   # 行尾注释\n\n# 图片配置区块\n',
      ),
    ).toBe(true);
    expect(
      text.endsWith(
        '\n# 自定义区域\n[custom]\nnotes = """\n第一行\n[not_a_header] 这一行以左括号开头\n"""\nkeep_me = "yes"\n',
      ),
    ).toBe(true);
    const parsed = parseToml(text) as Record<string, unknown>;
    expect(section(parsed, 'image')['max_edge_px']).toBe(2000);
    expect(parsed['default_model']).toBe('kimi-k2');
    expect(section(parsed, 'custom')['keep_me']).toBe('yes');
    expect(config.get<ImageConfig>(IMAGE_SECTION)).toEqual({ maxEdgePx: 2000 });

    disposables.dispose();
  });

  it('skips the write entirely when the staged result is byte-identical', async () => {
    const { config, disposables, storage, readText } = await setup('[image]\nmax_edge_px = 1500\n');
    const writeSpy = vi.spyOn(storage, 'write');

    await config.set(IMAGE_SECTION, { maxEdgePx: 2000 });
    const afterFirst = await readText();
    expect(writeSpy).toHaveBeenCalledTimes(1);

    await config.set(IMAGE_SECTION, { maxEdgePx: 2000 });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(await readText()).toBe(afterFirst);

    disposables.dispose();
  });

  it('appends a new domain at the end with a single trailing newline', async () => {
    const seed = '# 只有图片\n[image]\nmax_edge_px = 1500\n';
    const { config, disposables, readText } = await setup(seed);

    await config.set(THINKING_SECTION, { effort: 'high' });

    const text = await readText();
    expect(text.startsWith(seed)).toBe(true);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    const parsed = parseToml(text) as Record<string, unknown>;
    expect(section(parsed, 'thinking')['effort']).toBe('high');
    expect(config.get<ThinkingConfig>(THINKING_SECTION)).toEqual({ effort: 'high' });

    disposables.dispose();
  });

  it('removes a deleted domain region while keeping neighboring trivia', async () => {
    const seed = [
      '# 头部注释',
      '[thinking]',
      'effort = "high"',
      '',
      '# 图片注释',
      '[image]',
      'max_edge_px = 1500',
      '',
      '# 尾部注释',
      '[custom]',
      'keep_me = "yes"',
      '',
    ].join('\n');
    const { config, disposables, readText } = await setup(seed);

    await config.replace(IMAGE_SECTION, null);

    const text = await readText();
    expect(text.includes('[image]')).toBe(false);
    expect(text.includes('max_edge_px')).toBe(false);
    expect(text.includes('# 头部注释\n[thinking]\neffort = "high"\n')).toBe(true);
    expect(text.includes('# 图片注释')).toBe(true);
    expect(text.includes('# 尾部注释\n[custom]\nkeep_me = "yes"\n')).toBe(true);
    const parsed = parseToml(text) as Record<string, unknown>;
    expect(parsed['image']).toBeUndefined();
    expect(section(parsed, 'thinking')['effort']).toBe('high');

    disposables.dispose();
  });

  it('preserves CRLF line endings in untouched regions', async () => {
    const seed = '# 注释\r\ndefault_model = "kimi-k2"\r\n\r\n[image]\r\nmax_edge_px = 1500\r\n';
    const { config, disposables, readText } = await setup(seed);

    await config.set(IMAGE_SECTION, { maxEdgePx: 3000 });

    const text = await readText();
    expect(text.startsWith('# 注释\r\ndefault_model = "kimi-k2"\r\n\r\n')).toBe(true);
    const parsed = parseToml(text) as Record<string, unknown>;
    expect(section(parsed, 'image')['max_edge_px']).toBe(3000);

    disposables.dispose();
  });

  it('migrates thinking effort max to high without dropping the surrounding comments', async () => {
    const seed = '# 思考配置\n[thinking]\n# 不要动我\neffort = "max"\n';
    const { config, disposables, readText } = await setup(seed);

    const text = await readText();
    expect(text.includes('# 思考配置')).toBe(true);
    expect(text.includes('effort = "high"')).toBe(true);
    expect(text.includes('effort = "max"')).toBe(false);
    expect(config.get<ThinkingConfig>(THINKING_SECTION)).toEqual({ effort: 'high' });

    disposables.dispose();
  });
});
