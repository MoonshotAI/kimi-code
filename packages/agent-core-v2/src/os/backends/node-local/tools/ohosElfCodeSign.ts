import { createHash } from 'node:crypto';

import { ErrorCodes, Error2 } from '#/errors';

const ELF_MAGIC = 0x464c457f;
const ELF_MAGIC_SIZE = 4;
const ELF_CLASS_64 = 2;
const ELF_DATA_LITTLE_ENDIAN = 1;
const ELF_HEADER_MIN_SIZE = 64;
const SECTION_HEADER_SIZE = 64;
const SHN_LORESERVE = 0xff00;
const SHN_XINDEX = 0xffff;
const SHT_PROGBITS = 1;
const CODE_SIGN_SECTION_NAME = '.codesign';

const PAGE_SIZE = 4096;
const HASH_SIZE = 32;
const HASHES_PER_BLOCK = PAGE_SIZE / HASH_SIZE;
const DESCRIPTOR_SIZE = 256;
const FS_VERITY_DESCRIPTOR_TYPE = 1;
const FS_VERITY_VERSION = 1;
const FS_VERITY_HASH_ALG_SHA256 = 1;
const FS_VERITY_LOG_BLOCK_SIZE = 12;
const ELF_CODE_SIGN_VERSION = 3;
const FLAG_SELF_SIGN = 1 << 4;
const SELF_SIGN_SIGNATURE_SIZE = HASH_SIZE;
const SIGN_BLOCK_LENGTH = DESCRIPTOR_SIZE + SELF_SIGN_SIGNATURE_SIZE;

interface Elf64SectionTable {
  readonly shoff: number;
  readonly shnum: number;
  readonly shstrndx: number;
  readonly shstrOffset: number;
  readonly shstrSize: number;
}

interface Elf64Section {
  readonly name: string;
  readonly offset: number;
  readonly size: number;
}

function invalidElf(reason: string): Error2 {
  return new Error2(ErrorCodes.OS_FS_UNAVAILABLE, `Cannot self-sign OpenHarmony ELF: ${reason}`);
}

function sha256(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}

export function isElfBinary(bytes: Uint8Array): boolean {
  return bytes.length >= ELF_MAGIC_SIZE && readU32(bytes, 0) === ELF_MAGIC;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function readU64(bytes: Uint8Array, offset: number): number {
  const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalidElf('64-bit field exceeds safe integer range');
  }
  return Number(value);
}

function readSectionTable(bytes: Uint8Array): Elf64SectionTable {
  if (bytes.length < ELF_HEADER_MIN_SIZE || !isElfBinary(bytes)) {
    throw invalidElf('not a valid ELF binary');
  }
  if (bytes[4] !== ELF_CLASS_64 || bytes[5] !== ELF_DATA_LITTLE_ENDIAN) {
    throw invalidElf('only 64-bit little-endian ELF is supported');
  }
  const shentsize = readU16(bytes, 58);
  const shnum = readU16(bytes, 60);
  const shstrndx = readU16(bytes, 62);
  if (shentsize !== SECTION_HEADER_SIZE) {
    throw invalidElf(`unexpected section header size ${String(shentsize)}`);
  }
  if (shnum === 0 || shnum >= SHN_LORESERVE || shstrndx === 0 || shstrndx >= shnum || shstrndx === SHN_XINDEX) {
    throw invalidElf('missing or extended section header table is not supported');
  }
  const shoff = readU64(bytes, 40);
  if (shoff === 0 || shoff + shnum * SECTION_HEADER_SIZE > bytes.length) {
    throw invalidElf('section header table is out of bounds');
  }
  const shstrEntry = shoff + shstrndx * SECTION_HEADER_SIZE;
  const shstrOffset = readU64(bytes, shstrEntry + 24);
  const shstrSize = readU64(bytes, shstrEntry + 32);
  if (shstrOffset + shstrSize > bytes.length) {
    throw invalidElf('section name string table is out of bounds');
  }
  return { shoff, shnum, shstrndx, shstrOffset, shstrSize };
}

function readSectionName(bytes: Uint8Array, table: Elf64SectionTable, nameOffset: number): string {
  if (nameOffset >= table.shstrSize) {
    throw invalidElf('section name offset is out of bounds');
  }
  const start = table.shstrOffset + nameOffset;
  const limit = table.shstrOffset + table.shstrSize;
  let end = start;
  while (end < limit && bytes[end] !== 0) {
    end += 1;
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset + start, end - start).toString('utf8');
}

function findCodeSignSection(bytes: Uint8Array, table: Elf64SectionTable): Elf64Section | undefined {
  for (let i = 0; i < table.shnum; i++) {
    const entry = table.shoff + i * SECTION_HEADER_SIZE;
    const name = readSectionName(bytes, table, readU32(bytes, entry));
    if (name === CODE_SIGN_SECTION_NAME) {
      return { name, offset: readU64(bytes, entry + 24), size: readU64(bytes, entry + 32) };
    }
  }
  return undefined;
}

function assertValidCodeSignSection(bytes: Uint8Array, section: Elf64Section): void {
  if (section.offset % PAGE_SIZE !== 0 || section.size < PAGE_SIZE || section.size % PAGE_SIZE !== 0) {
    throw invalidElf('.codesign section offset or size is not 4K-aligned');
  }
  if (section.offset + section.size > bytes.length) {
    throw invalidElf('.codesign section is out of bounds');
  }
}

export function hasOhosElfCodeSign(bytes: Uint8Array): boolean {
  if (!isElfBinary(bytes)) return false;
  const table = readSectionTable(bytes);
  const section = findCodeSignSection(bytes, table);
  if (section === undefined) return false;
  assertValidCodeSignSection(bytes, section);
  const base = section.offset;
  const length = readU32(bytes, base + 4);
  const signSize = readU32(bytes, base + 12);
  return (
    readU32(bytes, base) === FS_VERITY_DESCRIPTOR_TYPE &&
    length >= DESCRIPTOR_SIZE &&
    length <= section.size - 8 &&
    bytes[base + 8] === FS_VERITY_VERSION &&
    bytes[base + 10] === FS_VERITY_LOG_BLOCK_SIZE &&
    signSize > 0 &&
    signSize <= length - DESCRIPTOR_SIZE &&
    bytes[base + 8 + 255] === ELF_CODE_SIGN_VERSION
  );
}

function hashBlock(hashes: readonly Buffer[], startIndex: number): Buffer {
  const block = Buffer.alloc(PAGE_SIZE);
  for (let j = 0; j < HASHES_PER_BLOCK && startIndex + j < hashes.length; j++) {
    hashes[startIndex + j]!.copy(block, j * HASH_SIZE);
  }
  return sha256(block);
}

function computeFsVerityRootHash(bytes: Buffer, codeSignOffset: number): Buffer {
  const pageCount = Math.ceil(bytes.length / PAGE_SIZE);
  let level: Buffer[] = [];
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    if (pageIndex * PAGE_SIZE === codeSignOffset) {
      level.push(Buffer.alloc(HASH_SIZE));
      continue;
    }
    const page = Buffer.alloc(PAGE_SIZE);
    const start = pageIndex * PAGE_SIZE;
    bytes.copy(page, 0, start, Math.min(start + PAGE_SIZE, bytes.length));
    level.push(sha256(page));
  }
  if (bytes.length <= PAGE_SIZE) {
    return level[0]!;
  }
  while (level.length > HASHES_PER_BLOCK) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += HASHES_PER_BLOCK) {
      next.push(hashBlock(level, i));
    }
    level = next;
  }
  return hashBlock(level, 0);
}

function writeSelfSignBlock(bytes: Buffer, codeSignOffset: number): void {
  const rootHash = computeFsVerityRootHash(bytes, codeSignOffset);
  const descriptor = Buffer.alloc(DESCRIPTOR_SIZE);
  descriptor.writeUInt8(FS_VERITY_VERSION, 0);
  descriptor.writeUInt8(FS_VERITY_HASH_ALG_SHA256, 1);
  descriptor.writeUInt8(FS_VERITY_LOG_BLOCK_SIZE, 2);
  descriptor.writeUInt8(0, 3);
  descriptor.writeUInt32LE(0, 4);
  descriptor.writeBigUInt64LE(BigInt(bytes.length), 8);
  rootHash.copy(descriptor, 16);
  descriptor.writeUInt32LE(FLAG_SELF_SIGN, 112);
  descriptor.writeUInt8(ELF_CODE_SIGN_VERSION, 255);
  const signature = sha256(descriptor);
  descriptor.writeUInt32LE(SELF_SIGN_SIGNATURE_SIZE, 4);
  bytes.fill(0, codeSignOffset, codeSignOffset + PAGE_SIZE);
  bytes.writeUInt32LE(FS_VERITY_DESCRIPTOR_TYPE, codeSignOffset);
  bytes.writeUInt32LE(SIGN_BLOCK_LENGTH, codeSignOffset + 4);
  descriptor.copy(bytes, codeSignOffset + 8);
  signature.copy(bytes, codeSignOffset + 8 + DESCRIPTOR_SIZE);
}

export function selfSignOhosElf(bytes: Uint8Array): Buffer {
  const table = readSectionTable(bytes);
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const existing = findCodeSignSection(bytes, table);
  if (existing !== undefined) {
    assertValidCodeSignSection(bytes, existing);
    const out = Buffer.from(source);
    out.fill(0, existing.offset, existing.offset + PAGE_SIZE);
    writeSelfSignBlock(out, existing.offset);
    return out;
  }

  const nameBytes = Buffer.from(`${CODE_SIGN_SECTION_NAME}\0`, 'utf8');
  const nameOffset = table.shstrSize;
  const newShstrOff = source.length;
  const newShstrSize = table.shstrSize + nameBytes.length;
  const codeSignOffset = Math.ceil((newShstrOff + newShstrSize) / PAGE_SIZE) * PAGE_SIZE;
  const newShoff = codeSignOffset + PAGE_SIZE;
  const newShnum = table.shnum + 1;
  const newTableSize = newShnum * SECTION_HEADER_SIZE;
  const out = Buffer.alloc(newShoff + newTableSize);

  source.copy(out, 0);
  source.copy(out, newShstrOff, table.shstrOffset, table.shstrOffset + table.shstrSize);
  nameBytes.copy(out, newShstrOff + table.shstrSize);
  source.copy(out, newShoff, table.shoff, table.shoff + table.shnum * SECTION_HEADER_SIZE);

  const shstrEntry = newShoff + table.shstrndx * SECTION_HEADER_SIZE;
  out.writeBigUInt64LE(BigInt(newShstrOff), shstrEntry + 24);
  out.writeBigUInt64LE(BigInt(newShstrSize), shstrEntry + 32);

  const csEntry = newShoff + table.shnum * SECTION_HEADER_SIZE;
  out.writeUInt32LE(nameOffset, csEntry);
  out.writeUInt32LE(SHT_PROGBITS, csEntry + 4);
  out.writeBigUInt64LE(BigInt(codeSignOffset), csEntry + 24);
  out.writeBigUInt64LE(BigInt(PAGE_SIZE), csEntry + 32);
  out.writeBigUInt64LE(BigInt(PAGE_SIZE), csEntry + 48);

  out.writeBigUInt64LE(BigInt(newShoff), 40);
  out.writeUInt16LE(newShnum, 60);

  writeSelfSignBlock(out, codeSignOffset);
  return out;
}
