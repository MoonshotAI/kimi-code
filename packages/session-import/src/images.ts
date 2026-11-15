import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { ImageReference } from '#/types';

const imageTypes = new Set(['image', 'input_image', 'local_image', 'image_url']);
const HARD_LINK_UNSUPPORTED = new Set(['ENOTSUP', 'ENOSYS', 'EPERM']);
const formats = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);
const pendingWrites = new Map<string, Promise<void>>();

export interface ImageContext {
  sourceLine?: number;
  cwd?: string;
}

export interface ImageCounters {
  embeddedReferences: number;
  savedFiles: number;
  reusedFiles: number;
  pathReferences: number;
  urlReferences: number;
  unresolvedReferences: number;
  contentReferences: number;
  metadataReferences: number;
  decodedBytes: number;
}

interface ImageSource {
  location: 'metadata' | 'content';
  payload?: unknown;
  reference?: unknown;
  mimeType?: unknown;
  embedded?: boolean;
}

type ImageTarget = Omit<ImageReference, 'sourceLine' | 'location' | 'metadataOnly' | 'text'>;

function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function verifyExisting(path: string, expectedHash: string): Promise<void> {
  let before = await lstat(path);
  for (let attempt = 0; before.isFile() && before.nlink === 2 && attempt < 20; attempt++) {
    await delay(10);
    before = await lstat(path);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw failure('IMAGE_FILE_UNSAFE', 'Existing attachment must be a regular file with one link.');
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const existing = await handle.stat();
    if (!existing.isFile() || existing.nlink !== 1 || existing.ino !== before.ino || existing.dev !== before.dev) {
      throw failure('IMAGE_FILE_UNSAFE', 'Existing attachment changed while opening it.');
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
    if (digest.digest('hex') !== expectedHash) {
      throw failure('IMAGE_FILE_MISMATCH', 'Existing attachment bytes do not match the imported content.');
    }
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

export async function writeAttachmentFile(
  directory: string,
  filename: string,
  bytes: Uint8Array | AsyncIterable<Uint8Array>,
): Promise<{ path: string; reused: boolean }> {
  if (!directory) throw failure('IMAGE_DIRECTORY_REQUIRED', 'An attachment directory is required.');
  if (!filename || filename === '.' || filename === '..' || /[/\\\0]/.test(filename)) {
    throw failure('IMAGE_FILE_UNSAFE', 'Attachment filename must be a single path component.');
  }
  const destination = resolve(directory);
  const path = join(destination, filename);
  const previous = pendingWrites.get(path);
  let release: () => void = () => {};
  const pending = new Promise<void>((done) => { release = done; });
  pendingWrites.set(path, pending);
  await previous;
  try {
    try {
      await mkdir(destination, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw failure('IMAGE_DIRECTORY_UNSAFE', `Cannot create attachment directory (${errorCode(error) ?? 'unknown error'}).`);
    }
    const directoryStat = await lstat(destination);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw failure('IMAGE_DIRECTORY_UNSAFE', 'Attachment directory must be a real directory.');
    }
    await chmod(destination, 0o700);
    const digest = createHash('sha256');
    const chunks = bytes instanceof Uint8Array ? [bytes] : bytes;
    const temporaryPath = join(destination, `.import-${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try {
        for await (const chunk of chunks) {
          digest.update(chunk);
          await handle.writeFile(chunk);
        }
        await handle.chmod(0o600);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const expectedHash = digest.digest('hex');
      try {
        await link(temporaryPath, path).catch(async (error: unknown) => {
          if (!HARD_LINK_UNSUPPORTED.has(errorCode(error) ?? '')) throw error;
          await copyFile(temporaryPath, path, constants.COPYFILE_EXCL);
        });
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        await verifyExisting(path, expectedHash);
        return { path, reused: true };
      }
    } finally {
      await unlink(temporaryPath);
    }
    return { path, reused: false };
  } finally {
    release();
    if (pendingWrites.get(path) === pending) pendingWrites.delete(path);
  }
}

function detectMime(bytes: Buffer): string {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) return 'image/webp';
  throw failure('INVALID_IMAGE_SIGNATURE', 'Embedded image has no supported PNG, JPEG, GIF, or WebP signature.');
}

function decodeImage(payload: unknown, declaredMime: unknown): { bytes: Buffer; mimeType: string; sha256: string } {
  if (typeof payload !== 'string' || payload.length === 0) throw failure('INVALID_IMAGE_BASE64', 'Embedded image payload is missing.');
  if (declaredMime !== undefined && typeof declaredMime !== 'string') throw failure('INVALID_IMAGE_TYPE', 'Embedded image MIME type must be a string.');
  let encoded = payload;
  let mimeType = declaredMime?.toLowerCase();
  if (/^data:/i.test(payload)) {
    const match = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(payload);
    if (!match?.[1] || match[2] === undefined) throw failure('INVALID_IMAGE_DATA_URL', 'Embedded image data URL must contain a MIME type and base64 data.');
    if (mimeType && mimeType !== match[1].toLowerCase()) throw failure('INVALID_IMAGE_TYPE', 'Embedded image MIME declarations disagree.');
    mimeType = match[1].toLowerCase();
    encoded = match[2];
  }
  if (mimeType && !formats.has(mimeType)) throw failure('INVALID_IMAGE_TYPE', `Unsupported embedded image MIME type: ${mimeType}.`);
  const compact = encoded.replaceAll(/[\t\n\r\f\v ]/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) throw failure('INVALID_IMAGE_BASE64', 'Embedded image contains invalid base64 characters.');
  const unpadded = compact.replace(/=+$/, '');
  const padding = compact.length - unpadded.length;
  const expectedPadding = (4 - unpadded.length % 4) % 4;
  if (unpadded.length % 4 === 1 || (padding && (compact.length % 4 !== 0 || padding !== expectedPadding))) {
    throw failure('INVALID_IMAGE_BASE64', 'Embedded image contains invalid base64 padding.');
  }
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== unpadded) throw failure('INVALID_IMAGE_BASE64', 'Embedded image contains non-canonical base64 bits.');
  const detected = detectMime(bytes);
  if (mimeType && mimeType !== detected) throw failure('INVALID_IMAGE_TYPE', 'Embedded image MIME type does not match its bytes.');
  return { bytes, mimeType: detected, sha256: hash(bytes) };
}

function imageSource(node: Record<string, unknown>): ImageSource {
  const file = record(node['file']);
  if (node['type'] === 'image' && file) {
    return {
      location: 'metadata',
      payload: file['base64'],
      reference: file['path'] ?? file['filePath'] ?? file['url'],
      mimeType: file['media_type'] ?? file['mime_type'] ?? file['mimeType'] ?? node['media_type'],
    };
  }
  const source = record(node['source']);
  if (source?.['type'] === 'base64') {
    return { location: 'content', payload: source['data'], mimeType: source['media_type'] ?? source['mime_type'] ?? source['mimeType'], embedded: true };
  }
  return {
    location: 'content',
    reference: source?.['url'] ?? source?.['path'] ?? source?.['filePath'] ?? record(node['image_url'])?.['url'] ?? node['image_url'] ?? node['path'] ?? node['url'],
  };
}

function localReference(reference: string, cwd?: string): { path: string; unresolved?: boolean } {
  if (/^file:/i.test(reference)) {
    try { return { path: fileURLToPath(reference) }; }
    catch { return { path: reference, unresolved: true }; }
  }
  if (isAbsolute(reference) || win32.isAbsolute(reference)) return { path: reference };
  if (reference.startsWith('~')) return { path: reference, unresolved: true };
  if (!cwd || (!isAbsolute(cwd) && !win32.isAbsolute(cwd))) return { path: reference, unresolved: true };
  return { path: win32.isAbsolute(cwd) && !isAbsolute(cwd) ? win32.resolve(cwd, reference) : resolve(cwd, reference) };
}

function referenceText(reference: ImageTarget): string {
  const target = JSON.stringify(reference.path ?? reference.url).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  if (reference.unresolved) return `[Imported image reference: ${target}; unresolved source reference; image has not been read]`;
  if (reference.kind === 'url') return `[Imported image reference: ${target}; open this URL to view the image]`;
  return `[Imported image reference: ${target}; read this file to view the image]`;
}

export async function createImageStore({ directory, cwd }: { directory: string; cwd?: string }) {
  const references: ImageReference[] = [];
  const counters: ImageCounters = {
    embeddedReferences: 0,
    savedFiles: 0,
    reusedFiles: 0,
    pathReferences: 0,
    urlReferences: 0,
    unresolvedReferences: 0,
    contentReferences: 0,
    metadataReferences: 0,
    decodedBytes: 0,
  };

  async function saveImage(payload: unknown, mimeType: unknown): Promise<ImageTarget> {
    const decoded = decodeImage(payload, mimeType);
    const { path, reused } = await writeAttachmentFile(directory, `${decoded.sha256}.${formats.get(decoded.mimeType)}`, decoded.bytes);
    counters.embeddedReferences++;
    counters.decodedBytes += decoded.bytes.length;
    counters[reused ? 'reusedFiles' : 'savedFiles']++;
    return { kind: 'embedded', path, sha256: decoded.sha256, bytes: decoded.bytes.length, mimeType: decoded.mimeType };
  }

  async function rewrite<T>(value: T, context: ImageContext = {}): Promise<T> {
    async function visit(node: unknown, location = '$', metadataContext = false): Promise<unknown> {
      if (node === null || typeof node !== 'object') return node;
      if (Array.isArray(node)) {
        const result: unknown[] = [];
        for (let index = 0; index < node.length; index++) result.push(await visit(node[index], `${location}[${index}]`, metadataContext));
        return result;
      }
      const object = node as Record<string, unknown>;
      if (typeof object['type'] === 'string' && imageTypes.has(object['type'])) {
        const source = imageSource(object);
        let target: ImageTarget;
        if (source.embedded || source.payload !== undefined) {
          target = await saveImage(source.payload, source.mimeType);
        } else if (typeof source.reference !== 'string' || !source.reference) {
          throw failure('INVALID_IMAGE_REFERENCE', 'Image node contains neither embedded image bytes nor a nonempty path or URL.');
        } else if (/^data:/i.test(source.reference)) {
          target = await saveImage(source.reference, source.mimeType);
        } else if (/^https?:\/\//i.test(source.reference)) {
          target = { kind: 'url', url: source.reference };
          counters.urlReferences++;
        } else if (/^[a-z][a-z0-9+.-]*:/i.test(source.reference) && !/^file:/i.test(source.reference) && !win32.isAbsolute(source.reference)) {
          target = { kind: 'url', url: source.reference, unresolved: true };
          counters.urlReferences++;
        } else {
          target = { kind: 'path', ...localReference(source.reference, context.cwd ?? cwd) };
          counters.pathReferences++;
        }
        const reference: ImageReference = {
          ...target,
          sourceLine: context.sourceLine,
          location,
          metadataOnly: metadataContext || source.location === 'metadata',
          text: referenceText(target),
        };
        if (reference.unresolved) counters.unresolvedReferences++;
        counters[reference.metadataOnly ? 'metadataReferences' : 'contentReferences']++;
        references.push(reference);
        if (source.location === 'metadata') {
          const file = { ...record(object['file']) };
          delete file['base64'];
          const result: Record<string, unknown> = {};
          for (const [key, child] of Object.entries(object)) {
            if (key !== 'file') Object.defineProperty(result, key, { value: await visit(child, `${location}.${key}`, true), enumerable: true, writable: true, configurable: true });
          }
          result['file'] = { ...record(await visit(file, `${location}.file`, true)), path: reference.path, url: reference.url };
          result['importedImage'] = { ...reference };
          return result;
        }
        return { type: object['type'] === 'input_image' ? 'input_text' : 'text', text: reference.text, importedImage: { ...reference } };
      }
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(object)) {
        const childLocation = /^[a-z_$][a-z0-9_$]*$/i.test(key) ? `${location}.${key}` : `${location}[${JSON.stringify(key)}]`;
        const childMetadata = metadataContext || /metadata/i.test(key) || key === 'toolUseResult';
        let transformed: unknown;
        if (object['type'] === 'user_message' && (key === 'images' || key === 'local_images') && Array.isArray(child)) {
          const items: unknown[] = [];
          for (let index = 0; index < child.length; index++) {
            const image: unknown = child[index];
            const imageObject = record(image);
            const imageNode = typeof imageObject?.['type'] === 'string' && imageTypes.has(imageObject['type']) ? image : key === 'images'
              ? { type: 'input_image', image_url: typeof image === 'string' ? image : imageObject?.['url'] ?? imageObject?.['image_url'] }
              : { type: 'local_image', path: typeof image === 'string' ? image : imageObject?.['path'] };
            items.push(await visit(imageNode, `${childLocation}[${index}]`, childMetadata));
          }
          transformed = items;
        } else if (key === 'arguments' || (key === 'input' && (object['type'] === 'tool_use' || object['type'] === 'server_tool_use'))) {
          transformed = child;
        } else transformed = await visit(child, childLocation, childMetadata);
        Object.defineProperty(result, key, { value: transformed, enumerable: true, writable: true, configurable: true });
      }
      return result;
    }
    return await visit(value) as T;
  }

  async function saveManifest(): Promise<string | undefined> {
    if (references.length === 0) return undefined;
    const bytes = Buffer.from(JSON.stringify(references, null, 2) + '\n');
    return (await writeAttachmentFile(directory, `references-${hash(bytes)}.json`, bytes)).path;
  }

  return { rewrite, saveManifest, report: () => ({ ...counters }), manifest: () => references.map((reference) => ({ ...reference })) };
}
