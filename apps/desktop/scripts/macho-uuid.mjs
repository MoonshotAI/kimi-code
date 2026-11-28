import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM_64 = 0xcffaedfe;
const FAT_MAGIC = 0xcafebabe;
const FAT_CIGAM = 0xbebafeca;
const FAT_MAGIC_64 = 0xcafebabf;
const FAT_CIGAM_64 = 0xbfbafeca;
const LC_UUID = 0x1b;
const MACH_HEADER_64_SIZE = 32;
const LOAD_COMMAND_HEADER_SIZE = 8;
const UUID_COMMAND_SIZE = 24;
const UUID_SIZE = 16;
const FAT_HEADER_SIZE = 8;
const FAT_ARCH_SIZE = 20;
const FAT_ARCH_64_SIZE = 32;
const UUID_DOMAIN = 'kimi-code-desktop:macho-lc-uuid:v1';
const ARCH_BY_CPU_TYPE = new Map([
  [0x01000007, 'x64'],
  [0x0100000c, 'arm64'],
]);

export function deriveMachOUuid(appId, arch) {
  if (typeof appId !== 'string' || appId.trim() === '') {
    throw new Error('Mach-O UUID derivation requires a non-empty appId');
  }
  if (typeof arch !== 'string' || arch.trim() === '') {
    throw new Error('Mach-O UUID derivation requires a non-empty arch');
  }
  const uuid = Buffer.from(
    createHash('sha256').update(`${UUID_DOMAIN}:${appId}:${arch}`, 'utf8').digest().subarray(0, UUID_SIZE),
  );
  uuid[6] = (uuid[6] & 0x0f) | 0x80;
  uuid[8] = (uuid[8] & 0x3f) | 0x80;
  return uuid;
}

export function formatUuid(uuid) {
  if (uuid.length !== UUID_SIZE) {
    throw new Error(`Expected ${UUID_SIZE} UUID bytes, received ${uuid.length}`);
  }
  const hex = Buffer.from(uuid).toString('hex').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertRange(buffer, offset, size, label) {
  if (!Number.isInteger(offset) || !Number.isInteger(size) || offset < 0 || size < 0 || offset > buffer.length - size) {
    throw new Error(`Invalid Mach-O: ${label} is truncated or out of bounds`);
  }
}

function assertDisjointRanges(ranges, label) {
  const sorted = [...ranges].sort((a, b) => a.offset - b.offset);
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous.offset + previous.size > current.offset) {
      throw new Error(`Invalid Mach-O: overlapping ${label}`);
    }
  }
}

function resolveSliceArch(cpuType, expectedArch) {
  const cpuArch = ARCH_BY_CPU_TYPE.get(cpuType);
  if (cpuArch === undefined) {
    throw new Error(`Unsupported Mach-O CPU type 0x${(cpuType >>> 0).toString(16)}`);
  }
  if ((expectedArch === 'x64' || expectedArch === 'arm64') && expectedArch !== cpuArch) {
    throw new Error(`Mach-O CPU architecture ${cpuArch} does not match build architecture ${expectedArch}`);
  }
  return cpuArch;
}

function collectThinPatches(buffer, slice, appId, expectedArch, patches) {
  const { offset: sliceOffset, size: sliceSize } = slice;
  assertRange(buffer, sliceOffset, MACH_HEADER_64_SIZE, '64-bit header');
  if (sliceSize < MACH_HEADER_64_SIZE) {
    throw new Error('Invalid Mach-O: slice is smaller than a 64-bit header');
  }
  const magic = buffer.readUInt32LE(sliceOffset);
  if (magic !== MH_MAGIC_64 && magic !== MH_CIGAM_64) {
    throw new Error('Unsupported Mach-O slice: expected a 64-bit Mach-O image');
  }
  const readUInt32 = magic === MH_MAGIC_64
    ? (offset) => buffer.readUInt32LE(offset)
    : (offset) => buffer.readUInt32BE(offset);
  const arch = resolveSliceArch(readUInt32(sliceOffset + 4), expectedArch);
  const ncmds = readUInt32(sliceOffset + 16);
  const sizeofcmds = readUInt32(sliceOffset + 20);
  if (sizeofcmds > sliceSize - MACH_HEADER_64_SIZE) {
    throw new Error('Invalid Mach-O: sizeofcmds exceeds the slice size');
  }
  const commandsStart = sliceOffset + MACH_HEADER_64_SIZE;
  const commandsEnd = commandsStart + sizeofcmds;
  assertRange(buffer, commandsStart, sizeofcmds, 'load commands');

  let cursor = commandsStart;
  let uuidOffset;
  for (let index = 0; index < ncmds; index++) {
    if (cursor + LOAD_COMMAND_HEADER_SIZE > commandsEnd) {
      throw new Error(`Invalid Mach-O: load command ${index} exceeds sizeofcmds`);
    }
    const cmd = readUInt32(cursor);
    const cmdsize = readUInt32(cursor + 4);
    if (cmdsize < LOAD_COMMAND_HEADER_SIZE || cmdsize % 8 !== 0 || cmdsize > commandsEnd - cursor) {
      throw new Error(`Invalid Mach-O: load command ${index} has invalid cmdsize ${cmdsize}`);
    }
    if (cmd === LC_UUID) {
      if (cmdsize < UUID_COMMAND_SIZE) {
        throw new Error(`Invalid Mach-O: LC_UUID cmdsize ${cmdsize} is smaller than ${UUID_COMMAND_SIZE}`);
      }
      if (uuidOffset !== undefined) {
        throw new Error('Invalid Mach-O: multiple LC_UUID load commands in one slice');
      }
      uuidOffset = cursor + LOAD_COMMAND_HEADER_SIZE;
    }
    cursor += cmdsize;
  }
  if (cursor !== commandsEnd) {
    throw new Error('Invalid Mach-O: ncmds does not cover sizeofcmds');
  }
  if (uuidOffset === undefined) {
    throw new Error('Invalid Mach-O: missing LC_UUID load command');
  }
  patches.push({ offset: uuidOffset, arch, uuid: deriveMachOUuid(appId, arch) });
}

function toSafeNumber(value, label) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Invalid Mach-O: ${label} exceeds the safe integer range`);
  }
  return Number(value);
}

function collectFatPatches(buffer, magic, appId, expectedArch, patches) {
  assertRange(buffer, 0, FAT_HEADER_SIZE, 'fat header');
  const is64 = magic === FAT_MAGIC_64 || magic === FAT_CIGAM_64;
  const littleEndian = magic === FAT_CIGAM || magic === FAT_CIGAM_64;
  const readUInt32 = littleEndian
    ? (offset) => buffer.readUInt32LE(offset)
    : (offset) => buffer.readUInt32BE(offset);
  const readUInt64 = littleEndian
    ? (offset) => buffer.readBigUInt64LE(offset)
    : (offset) => buffer.readBigUInt64BE(offset);
  const entrySize = is64 ? FAT_ARCH_64_SIZE : FAT_ARCH_SIZE;
  const nfatArch = readUInt32(4);
  if (nfatArch === 0) {
    throw new Error('Invalid Mach-O: universal binary has no slices');
  }
  assertRange(buffer, FAT_HEADER_SIZE, nfatArch * entrySize, 'fat architecture table');
  const tableEnd = FAT_HEADER_SIZE + nfatArch * entrySize;

  const slices = [];
  for (let index = 0; index < nfatArch; index++) {
    const entry = FAT_HEADER_SIZE + index * entrySize;
    const arch = resolveSliceArch(readUInt32(entry), expectedArch);
    const offset = is64
      ? toSafeNumber(readUInt64(entry + 8), `slice ${index} offset`)
      : readUInt32(entry + 8);
    const size = is64
      ? toSafeNumber(readUInt64(entry + 16), `slice ${index} size`)
      : readUInt32(entry + 12);
    if (offset < tableEnd) {
      throw new Error(`Invalid Mach-O: slice ${index} overlaps the fat header`);
    }
    assertRange(buffer, offset, size, `slice ${index}`);
    slices.push({ offset, size, arch });
  }
  assertDisjointRanges(slices, 'universal slices');
  for (const slice of slices) {
    collectThinPatches(buffer, slice, appId, slice.arch, patches);
  }
}

export function rewriteMachOUuid(source, { appId, arch }) {
  const input = Buffer.isBuffer(source) ? source : Buffer.from(source);
  assertRange(input, 0, 4, 'magic');
  const patches = [];
  const magicBE = input.readUInt32BE(0);
  if (magicBE === FAT_MAGIC || magicBE === FAT_CIGAM || magicBE === FAT_MAGIC_64 || magicBE === FAT_CIGAM_64) {
    collectFatPatches(input, magicBE, appId, arch, patches);
  } else {
    collectThinPatches(input, { offset: 0, size: input.length }, appId, arch, patches);
  }
  assertDisjointRanges(
    patches.map((patch) => ({ offset: patch.offset, size: UUID_SIZE })),
    'LC_UUID fields',
  );

  const buffer = Buffer.from(input);
  let changed = false;
  for (const patch of patches) {
    if (!input.subarray(patch.offset, patch.offset + UUID_SIZE).equals(patch.uuid)) {
      changed = true;
    }
    patch.uuid.copy(buffer, patch.offset);
  }
  return {
    buffer,
    changed,
    uuids: patches.map(({ arch: sliceArch, uuid }) => ({ arch: sliceArch, uuid: Buffer.from(uuid) })),
  };
}

export async function rewriteMachOUuidFile(filePath, options) {
  const source = await readFile(filePath);
  const { buffer, changed, uuids } = rewriteMachOUuid(source, options);
  if (changed) {
    await writeFile(filePath, buffer);
  }
  return { changed, uuids };
}
