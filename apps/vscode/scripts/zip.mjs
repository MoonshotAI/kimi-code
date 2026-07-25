import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const MAX_END_RECORD_SEARCH = 65_535 + 22;

export async function extractZip(archivePath, destination) {
  const archive = await readFile(archivePath);
  const entries = readCentralDirectory(archive);

  for (const entry of entries) {
    const relativePath = safeArchivePath(entry.name);
    if (relativePath === '') continue;
    const outputPath = resolve(destination, relativePath);
    assertInside(destination, outputPath, entry.name);

    if (entry.name.endsWith('/')) {
      await mkdir(outputPath, { recursive: true });
      continue;
    }

    const content = readEntry(archive, entry);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, content);
  }

  return entries.map((entry) => entry.name);
}

function readCentralDirectory(archive) {
  const endOffset = findEndRecord(archive);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const directorySize = archive.readUInt32LE(endOffset + 12);
  const directoryOffset = archive.readUInt32LE(endOffset + 16);

  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error('ZIP64 VSIX archives are not supported by the verifier.');
  }
  if (directoryOffset + directorySize > archive.length) {
    throw new Error('VSIX central directory points outside the archive.');
  }

  const entries = [];
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY) {
      throw new Error(`Invalid VSIX central-directory entry at byte ${offset}.`);
    }
    const flags = archive.readUInt16LE(offset + 8);
    if ((flags & 0x1) !== 0) throw new Error('Encrypted VSIX entries are not supported.');

    const compression = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const name = archive.subarray(nameStart, nameStart + nameLength).toString('utf8');
    entries.push({ name, compression, compressedSize, uncompressedSize, localOffset });
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndRecord(archive) {
  const lowerBound = Math.max(0, archive.length - MAX_END_RECORD_SEARCH);
  for (let offset = archive.length - 22; offset >= lowerBound; offset -= 1) {
    if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error('VSIX is not a readable ZIP archive: end record is missing.');
}

function readEntry(archive, entry) {
  if (archive.readUInt32LE(entry.localOffset) !== LOCAL_FILE_HEADER) {
    throw new Error(`Invalid local header for VSIX entry ${entry.name}.`);
  }
  const nameLength = archive.readUInt16LE(entry.localOffset + 26);
  const extraLength = archive.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > archive.length) throw new Error(`Truncated VSIX entry ${entry.name}.`);

  const compressed = archive.subarray(dataStart, dataEnd);
  let content;
  if (entry.compression === 0) {
    content = compressed;
  } else if (entry.compression === 8) {
    content = inflateRawSync(compressed);
  } else {
    throw new Error(`Unsupported compression method ${entry.compression} for ${entry.name}.`);
  }
  if (content.length !== entry.uncompressedSize) {
    throw new Error(
      `Unexpected uncompressed size for ${entry.name}: ${content.length}, expected ${entry.uncompressedSize}.`,
    );
  }
  return content;
}

function safeArchivePath(name) {
  const normalized = name.replaceAll('\\', '/');
  const segments = normalized.split('/').filter((segment) => segment !== '');
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    segments.some((segment) => segment === '..')
  ) {
    throw new Error(`Unsafe path in VSIX archive: ${name}`);
  }
  return segments.join(sep);
}

function assertInside(destination, outputPath, archiveName) {
  const root = resolve(destination);
  if (outputPath === root || outputPath.startsWith(`${root}${sep}`)) return;
  throw new Error(`Unsafe path in VSIX archive: ${archiveName}`);
}
