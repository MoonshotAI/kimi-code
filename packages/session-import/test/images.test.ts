import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createImageStore, writeAttachmentFile } from '#/images';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6d8AAAAASUVORK5CYII=', 'base64');
const encoded = png.toString('base64');
const digest = createHash('sha256').update(png).digest('hex');
const embedded = (data = encoded, mime = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type: mime, data } });
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(cwd?: string) {
  const root = await mkdtemp(join(tmpdir(), 'session-import-images-'));
  roots.push(root);
  const directory = join(root, 'attachments');
  return { root, directory, store: await createImageStore({ directory, cwd }) };
}

test('extracts exact image bytes in place and leaves the source object untouched', async () => {
  const { directory, store } = await fixture();
  const input = { content: [{ type: 'text', text: 'before' }, embedded(), { type: 'text', text: 'after' }] };
  const actual = await store.rewrite(input, { sourceLine: 12 });
  const path = join(directory, `${digest}.png`);
  expect(actual).toEqual({ content: [
    input.content[0],
    { type: 'text', text: `[Imported image reference: ${JSON.stringify(path)}; read this file to view the image]`, importedImage: expect.objectContaining({ sha256: digest, sourceLine: 12, path }) },
    input.content[2],
  ] });
  expect(await readFile(path)).toEqual(png);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(input.content[1]).toEqual(embedded());
  expect(JSON.stringify(actual)).not.toContain(encoded);
  expect(store.report().savedFiles).toBe(1);
});

test('deduplicates content data URLs and tool metadata while preserving metadata', async () => {
  const { directory, store } = await fixture();
  const input = {
    message: { content: [embedded(), { type: 'input_image', image_url: `DATA:IMAGE/PNG;BASE64,${encoded}` }] },
    toolUseResult: { type: 'image', file: { base64: encoded, dimensions: { width: 1, height: 1 }, filePath: '/example/original.png' }, note: 'kept' },
  };
  const actual = await store.rewrite(input);
  expect(actual.message.content[1]).toMatchObject({ type: 'input_text' });
  expect(actual.toolUseResult).toMatchObject({
    type: 'image', note: 'kept',
    file: { dimensions: { width: 1, height: 1 }, filePath: '/example/original.png', path: join(directory, `${digest}.png`) },
  });
  expect(actual.toolUseResult.file).not.toHaveProperty('base64');
  expect(await readdir(directory)).toHaveLength(1);
  expect(store.report()).toEqual({ embeddedReferences: 3, savedFiles: 1, reusedFiles: 2, pathReferences: 0, urlReferences: 0, unresolvedReferences: 0, contentReferences: 2, metadataReferences: 1, decodedBytes: png.length * 3 });
  expect(store.manifest()).toHaveLength(3);
  expect(JSON.stringify(store.manifest())).not.toContain(encoded);
});

test('accepts normalized MIME, unpadded base64 and ASCII whitespace without altering bytes', async () => {
  const { store, directory } = await fixture();
  await store.rewrite(embedded(encoded.replace(/=+$/, ''), 'IMAGE/PNG'));
  await store.rewrite(embedded(Array.from(encoded).join(' \n\t')));
  expect(store.report()).toMatchObject({ savedFiles: 1, reusedFiles: 1 });
  expect(await readFile(join(directory, `${digest}.png`))).toEqual(png);
});

test('preserves path and URL references without opening or fetching them', async () => {
  const { directory, store } = await fixture('/example/source');
  await store.rewrite([
    { type: 'local_image', path: './pictures/missing image.png' },
    { type: 'image', source: { type: 'url', url: 'https://example.test/image.png?token=example' } },
    { type: 'input_image', image_url: { url: '/example/missing.png' } },
    { type: 'local_image', path: 'file:///example/missing%20image.png' },
  ]);
  expect(store.manifest()).toMatchObject([
    { path: '/example/source/pictures/missing image.png' },
    { url: 'https://example.test/image.png?token=example' },
    { path: '/example/missing.png' },
    { path: '/example/missing image.png' },
  ]);
  expect(store.report()).toMatchObject({ pathReferences: 3, urlReferences: 1 });
  await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('uses record cwd, preserves Windows paths and marks relative paths without cwd unresolved', async () => {
  const { store, directory } = await fixture('/example/default');
  await store.rewrite({ type: 'local_image', path: '../image.png' }, { cwd: '/example/record' });
  await store.rewrite({ type: 'local_image', path: 'image.png' }, { cwd: 'C:\\example' });
  await store.rewrite({ type: 'local_image', path: 'C:\\example\\image.png' });
  expect(store.manifest()).toMatchObject([{ path: '/example/image.png' }, { path: 'C:\\example\\image.png' }, { path: 'C:\\example\\image.png' }]);
  const isolated = await createImageStore({ directory });
  expect(await isolated.rewrite({ type: 'local_image', path: 'relative/image.png' })).toMatchObject({
    importedImage: { path: 'relative/image.png', unresolved: true },
    text: expect.stringContaining('unresolved source reference'),
  });
  expect(isolated.report().unresolvedReferences).toBe(1);
});

test('keeps unsupported references explicit rather than expanding home or using process cwd', async () => {
  const { store } = await fixture();
  await store.rewrite([
    { type: 'local_image', path: '~/example.png' },
    { type: 'input_image', image_url: 'custom://example/image.png' },
    { type: 'local_image', path: 'file://example.test/image.png' },
  ]);
  expect(store.manifest()).toMatchObject([
    { path: '~/example.png', unresolved: true },
    { url: 'custom://example/image.png', unresolved: true },
    { path: 'file://example.test/image.png', unresolved: true },
  ]);
});

test('does not interpret ordinary text, tool arguments or unknown binary fields as images', async () => {
  const { store } = await fixture();
  const input = { text: `data:image/png;base64,${encoded}`, arguments: JSON.stringify(embedded()), other: { base64: encoded, type: 'file' }, content: [{ type: 'text', text: encoded }], calls: [
    { type: 'tool_use', input: { type: 'image', prompt: 'Draw a tree' } },
    { type: 'server_tool_use', input: { type: 'image', path: 'tree.png', prompt: 'Draw a tree' } },
    { type: 'McpToolCall', arguments: embedded() },
    { invocation: { arguments: [{ type: 'local_image', path: 'tree.png' }] } },
  ] };
  expect(await store.rewrite(input)).toEqual(input);
  expect(store.manifest()).toEqual([]);
});

test.each([
  [embedded(''), 'INVALID_IMAGE_BASE64'],
  [embedded('not@base64'), 'INVALID_IMAGE_BASE64'],
  [embedded(`${encoded}=`), 'INVALID_IMAGE_BASE64'],
  [embedded('a'), 'INVALID_IMAGE_BASE64'],
  [embedded('Zh=='), 'INVALID_IMAGE_BASE64'],
  [embedded(Buffer.from('plain text').toString('base64')), 'INVALID_IMAGE_SIGNATURE'],
  [embedded(encoded, 'image/jpeg'), 'INVALID_IMAGE_TYPE'],
  [embedded(encoded, 'image/svg+xml'), 'INVALID_IMAGE_TYPE'],
  [{ type: 'image', source: { type: 'base64', media_type: 42, data: encoded } }, 'INVALID_IMAGE_TYPE'],
  [embedded(`data:image/jpeg;base64,${encoded}`), 'INVALID_IMAGE_TYPE'],
  [{ type: 'input_image', image_url: 'data:image/png,notbase64' }, 'INVALID_IMAGE_DATA_URL'],
  [{ type: 'input_image' }, 'INVALID_IMAGE_REFERENCE'],
  [{ type: 'image', source: { type: 'base64' } }, 'INVALID_IMAGE_BASE64'],
] as const)('rejects malformed image input %# without creating attachments', async (input, code) => {
  const { directory, store } = await fixture();
  await expect(store.rewrite(input)).rejects.toMatchObject({ code });
  expect(store.report().savedFiles).toBe(0);
  await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

test.each([
  [png, 'image/png', 'png'],
  [Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]), 'image/jpeg', 'jpg'],
  [Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'), 'image/gif', 'gif'],
  [Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64'), 'image/webp', 'webp'],
] as const)('recognizes %s signature and uses a canonical extension', async (bytes, mime, extension) => {
  const { store, directory } = await fixture();
  await store.rewrite(embedded(bytes.toString('base64'), mime));
  const path = join(directory, `${createHash('sha256').update(bytes).digest('hex')}.${extension}`);
  expect(store.manifest()).toMatchObject([{ path }]);
  expect(await readFile(path)).toEqual(bytes);
});

test('refuses to overwrite a same-name file whose bytes differ', async () => {
  const { directory, store } = await fixture();
  await mkdir(directory);
  const path = join(directory, `${digest}.png`);
  await writeFile(path, 'existing unrelated file');
  await expect(store.rewrite(embedded())).rejects.toMatchObject({ code: 'IMAGE_FILE_MISMATCH' });
  expect(await readFile(path, 'utf8')).toBe('existing unrelated file');
  expect(store.report().savedFiles).toBe(0);
  expect(await readdir(directory)).toEqual([`${digest}.png`]);
});

test('refuses symlink files and destination directories', async () => {
  const { root, directory, store } = await fixture();
  const outside = join(root, 'outside.png');
  await writeFile(outside, png);
  await mkdir(directory);
  await symlink(outside, join(directory, `${digest}.png`));
  await expect(store.rewrite(embedded())).rejects.toMatchObject({ code: 'IMAGE_FILE_UNSAFE' });
  expect(await readFile(outside)).toEqual(png);
  const target = join(root, 'linked-directory');
  await symlink(directory, target);
  const linkedStore = await createImageStore({ directory: target });
  await expect(linkedStore.rewrite(embedded())).rejects.toMatchObject({ code: 'IMAGE_DIRECTORY_UNSAFE' });
});

test('refuses hardlinked files and reuses verified files across stores', async () => {
  const { root, directory, store } = await fixture();
  await store.rewrite(embedded());
  const second = await createImageStore({ directory });
  await second.rewrite(embedded());
  expect(second.report().reusedFiles).toBe(1);
  await link(join(directory, `${digest}.png`), join(root, 'hardlinked.png'));
  await expect(store.rewrite(embedded())).rejects.toMatchObject({ code: 'IMAGE_FILE_UNSAFE' });
});

test('manifest and report snapshots cannot mutate store state', async () => {
  const { store } = await fixture();
  const actual = await store.rewrite<Record<string, unknown>>(embedded());
  const imported = actual['importedImage'];
  if (!imported || typeof imported !== 'object' || !('path' in imported)) throw new Error('Expected rewritten image.');
  imported.path = '/example/replaced';
  const first = store.manifest()[0];
  if (!first) throw new Error('Expected image reference.');
  first.path = '/example/other';
  store.report().savedFiles = 999;
  expect(store.report().savedFiles).toBe(1);
  expect(store.manifest()[0]?.path).not.toBe('/example/other');
  expect(store.manifest()[0]?.path).not.toBe('/example/replaced');
});

test('manifest index is stable, private, complete and refuses modified same-name files', async () => {
  const { store } = await fixture();
  expect(await store.saveManifest()).toBeUndefined();
  await store.rewrite({ message: { content: [embedded()] } }, { sourceLine: 7 });
  const first = await store.saveManifest();
  if (!first) throw new Error('Expected image index.');
  expect(await store.saveManifest()).toBe(first);
  expect(JSON.parse(await readFile(first, 'utf8'))).toEqual(JSON.parse(JSON.stringify(store.manifest())));
  expect(store.manifest()).toMatchObject([{ sourceLine: 7, location: '$.message.content[0]', metadataOnly: false }]);
  expect((await stat(first)).mode & 0o777).toBe(0o600);
  expect(store.report().savedFiles).toBe(1);
  await writeFile(first, 'changed');
  await expect(store.saveManifest()).rejects.toMatchObject({ code: 'IMAGE_FILE_MISMATCH' });
  expect(await readFile(first, 'utf8')).toBe('changed');
});

test('legacy image arrays retain field order and textual references', async () => {
  const { store } = await fixture('/example/source');
  const actual = await store.rewrite({ type: 'user_message', message: 'Original text', images: [`data:image/png;base64,${encoded}`, 'https://example.test/image.png'], local_images: ['relative.png', { path: '/example/other.png' }] });
  expect(actual).toMatchObject({ message: 'Original text', images: [{ type: 'input_text' }, { importedImage: { url: 'https://example.test/image.png' } }], local_images: [{ importedImage: { path: '/example/source/relative.png' } }, { type: 'text' }] });
  expect(store.manifest()[0]?.location).toBe('$.images[0]');
  expect(store.manifest()[2]?.location).toBe('$.local_images[0]');
  expect(store.report().contentReferences).toBe(4);
});

test('quotes newlines, quotes, brackets and Unicode separators in reference paths', async () => {
  const { store } = await fixture();
  const path = '/example/line\nquote"bracket]\u2028separator\u2029.png';
  await store.rewrite({ type: 'local_image', path });
  const text = store.manifest()[0]?.text;
  expect(text).toContain(JSON.stringify(path).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029'));
  expect(text?.split('\n')).toHaveLength(1);
});

test('counts typed content images under metadata as metadata references', async () => {
  const { store } = await fixture();
  const actual = await store.rewrite({ content: [embedded()], internal_chat_message_metadata_passthrough: { source_image: embedded() }, metadata: { image: embedded() }, toolUseResult: { content: [embedded()] } });
  expect(store.report()).toMatchObject({ contentReferences: 1, metadataReferences: 3, savedFiles: 1 });
  expect(actual.metadata.image).toMatchObject({ type: 'text', importedImage: { metadataOnly: true } });
  expect(store.manifest()[1]?.location).toBe('$.internal_chat_message_metadata_passthrough.source_image');
});

test('concurrent identical writes across stores reuse complete image and index files', async () => {
  const { directory } = await fixture();
  const stores = await Promise.all(Array.from({ length: 20 }, () => createImageStore({ directory })));
  await Promise.all(stores.map((store) => store.rewrite(embedded())));
  expect(stores.reduce((total, store) => total + store.report().savedFiles, 0)).toBe(1);
  expect(stores.reduce((total, store) => total + store.report().reusedFiles, 0)).toBe(19);
  const indexes = await Promise.all(stores.map((store) => store.saveManifest()));
  expect(new Set(indexes).size).toBe(1);
  expect(await readFile(join(directory, `${digest}.png`))).toEqual(png);
  expect(await readdir(directory)).toHaveLength(2);
});

test('concurrent processes wait for another writer to finish publishing a complete file', async () => {
  const { directory } = await fixture();
  const moduleUrl = new URL('../src/images.ts', import.meta.url).href;
  const script = `import { writeAttachmentFile } from ${JSON.stringify(moduleUrl)}; await writeAttachmentFile(process.argv[1], 'shared.bin', Buffer.alloc(1024 * 1024, 42));`;
  await Promise.all(Array.from({ length: 16 }, () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { errors += chunk; });
    child.on('error', reject);
    child.on('close', (code) => { if (code === 0) resolve(); else reject(new Error(errors)); });
  })));
  expect(await readFile(join(directory, 'shared.bin'))).toEqual(Buffer.alloc(1024 * 1024, 42));
  expect(await readdir(directory)).toEqual(['shared.bin']);
}, 15_000);

test('publishes streamed attachments only after all bytes are written', async () => {
  const { directory } = await fixture();
  let reached: () => void = () => {};
  let proceed: () => void = () => {};
  const ready = new Promise<void>((done) => { reached = done; });
  const resume = new Promise<void>((done) => { proceed = done; });
  async function* chunks() {
    yield Buffer.from('first\n');
    reached();
    await resume;
    yield Buffer.from('last\n');
  }
  const writing = writeAttachmentFile(directory, 'history.jsonl', chunks());
  await ready;
  const path = join(directory, 'history.jsonl');
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  const temporary = await readdir(directory);
  expect(temporary).toHaveLength(1);
  expect(temporary[0]).toMatch(/^\.import-.*\.tmp$/);
  proceed();
  await expect(writing).resolves.toEqual({ path, reused: false });
  expect(await readFile(path, 'utf8')).toBe('first\nlast\n');
  expect(await readdir(directory)).toEqual(['history.jsonl']);
  await expect(writeAttachmentFile(directory, 'history.jsonl', chunks())).resolves.toEqual({ path, reused: true });
});

test('failed input streams remove staging files without publishing partial output', async () => {
  const { directory } = await fixture();
  async function* chunks() {
    yield Buffer.from('partial');
    throw new Error('source failed');
  }
  await expect(writeAttachmentFile(directory, 'history.jsonl', chunks())).rejects.toThrow('source failed');
  expect(await readdir(directory)).toEqual([]);
});

test('publishes by exclusive copy on filesystems without hard links', async () => {
  const { directory } = await fixture();
  vi.resetModules();
  vi.doMock('node:fs/promises', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:fs/promises')>()),
    link: async () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); },
  }));
  try {
    const { writeAttachmentFile: writeWithoutLinks } = await import('#/images');
    const path = join(directory, 'history.jsonl');
    await expect(writeWithoutLinks(directory, 'history.jsonl', Buffer.from('content'))).resolves.toEqual({ path, reused: false });
    expect(await readFile(path, 'utf8')).toBe('content');
    expect(await readdir(directory)).toEqual(['history.jsonl']);
    await expect(writeWithoutLinks(directory, 'history.jsonl', Buffer.from('content'))).resolves.toEqual({ path, reused: true });
  } finally {
    vi.doUnmock('node:fs/promises');
    vi.resetModules();
  }
});

test.each(['../outside.json', '/outside.json', '..\\outside.json', '.', '..', 'file\0.json'])('rejects unsafe attachment filename %s', async (name) => {
  const { directory } = await fixture();
  await expect(writeAttachmentFile(directory, name, png)).rejects.toMatchObject({ code: 'IMAGE_FILE_UNSAFE' });
  await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('preserves unusual JSON keys without changing prototypes', async () => {
  const { store } = await fixture();
  const input: unknown = JSON.parse('{"__proto__":{"flag":"retained"},"constructor":{"type":"local_image","path":"/example/image.png"}}');
  const actual = await store.rewrite(input);
  expect(Object.getOwnPropertyDescriptor(actual, '__proto__')?.value).toEqual({ flag: 'retained' });
  expect(Object.getPrototypeOf(actual)).toBe(Object.prototype);
  expect(store.manifest()[0]?.location).toBe('$.constructor');
});
