import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';
import { ZipFile } from 'yazl';

import { importSessionZip, isImportId, listImportedIds, readImportMeta, deleteImported } from '../../src/lib/import-store';
import { resolveSafeTarget } from '../../src/lib/zip-import';

/** Build an in-memory zip from a {path: contents} map (yazl refuses to emit
 *  `..` entries, so traversal is tested via resolveSafeTarget directly). */
function buildZip(entries: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    for (const [name, data] of Object.entries(entries)) {
      zip.addBuffer(Buffer.from(data, 'utf8'), name);
    }
    zip.end();
    const chunks: Buffer[] = [];
    (zip.outputStream as NodeJS.ReadableStream).on('data', (c: Buffer) => chunks.push(c));
    (zip.outputStream as NodeJS.ReadableStream).on('end', () => { resolve(Buffer.concat(chunks)); });
    (zip.outputStream as NodeJS.ReadableStream).on('error', reject);
  });
}

const META_LINE = JSON.stringify({ type: 'metadata', protocol_version: '1.4', created_at: 1 });
const WIRE = `${META_LINE}\n`;

function validBundle(): Record<string, string> {
  return {
    'manifest.json': JSON.stringify({ sessionId: 'session_orig', kimiCodeVersion: '0.20.2', workspaceDir: '/home/u/proj', title: 'imported demo' }),
    'state.json': JSON.stringify({ createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T01:00:00.000Z', title: 'imported demo', agents: { main: { homedir: '/orig/agents/main', type: 'main', parentAgentId: null } }, custom: {} }),
    'agents/main/wire.jsonl': WIRE,
    'logs/kimi-code.log': '2026-06-01T00:00:00.000Z INFO  hello  k=v\n',
  };
}

describe('import-store', () => {
  let home: string | null = null;
  afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); home = null; });

  it('imports a valid bundle and lists it with manifest metadata', async () => {
    home = await mkdtemp(join(tmpdir(), 'vis-import-'));
    const zip = await buildZip(validBundle());
    const meta = await importSessionZip(home, zip, 'demo.zip', new Date('2026-06-29T00:00:00.000Z'));

    expect(isImportId(meta.importId)).toBe(true);
    expect(meta.originalName).toBe('demo.zip');
    expect(meta.manifest?.sessionId).toBe('session_orig');
    expect(meta.manifest?.workspaceDir).toBe('/home/u/proj');

    // Extracted to imported/<id>/ with the session shape intact.
    const dir = join(home, 'imported', meta.importId);
    expect((await stat(join(dir, 'agents', 'main', 'wire.jsonl'))).isFile()).toBe(true);
    expect((await stat(join(dir, 'logs', 'kimi-code.log'))).isFile()).toBe(true);

    const ids = await listImportedIds(home);
    expect(ids).toContain(meta.importId);
    const reread = await readImportMeta(home, meta.importId);
    expect(reread?.importId).toBe(meta.importId);
  });

  it('rejects a zip with no main wire and cleans up', async () => {
    home = await mkdtemp(join(tmpdir(), 'vis-import-'));
    const zip = await buildZip({ 'manifest.json': '{}', 'state.json': '{}' });
    await expect(importSessionZip(home, zip, null, new Date())).rejects.toThrow(/session bundle/);
    // No partial directory left behind.
    expect(await listImportedIds(home)).toEqual([]);
  });

  it('deletes an imported bundle', async () => {
    home = await mkdtemp(join(tmpdir(), 'vis-import-'));
    const meta = await importSessionZip(home, await buildZip(validBundle()), null, new Date());
    expect(await deleteImported(home, meta.importId)).toBe(true);
    expect(await listImportedIds(home)).toEqual([]);
    expect(await deleteImported(home, meta.importId)).toBe(false);
  });

  it('isImportId only matches the imp_ scheme', () => {
    expect(isImportId('imp_0123456789ab')).toBe(true);
    expect(isImportId('session_abc')).toBe(false);
    expect(isImportId('imp_xyz')).toBe(false);
    expect(isImportId('../escape')).toBe(false);
  });
});

describe('resolveSafeTarget (zip-slip guard)', () => {
  const root = '/tmp/imp/abc';
  it('accepts in-tree paths', () => {
    expect(resolveSafeTarget(root, 'state.json')).toBe('/tmp/imp/abc/state.json');
    expect(resolveSafeTarget(root, 'agents/main/wire.jsonl')).toBe('/tmp/imp/abc/agents/main/wire.jsonl');
  });
  it('rejects traversal and absolute escapes', () => {
    expect(resolveSafeTarget(root, '../evil')).toBeNull();
    expect(resolveSafeTarget(root, '../../etc/passwd')).toBeNull();
    expect(resolveSafeTarget(root, 'a/../../b')).toBeNull();
    expect(resolveSafeTarget(root, '/etc/passwd')).toBeNull();
  });
});
