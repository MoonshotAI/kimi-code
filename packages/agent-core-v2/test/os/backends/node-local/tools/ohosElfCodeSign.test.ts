import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  hasOhosElfCodeSign,
  isElfBinary,
  selfSignOhosElf,
} from '#/os/backends/node-local/tools/ohosElfCodeSign';

const PAGE_SIZE = 4096;
const SECTION_HEADER_SIZE = 64;

function sha256(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}

function buildElf64(text: Buffer): Buffer {
  const shstr = Buffer.from('\0.text\0.shstrtab\0', 'utf8');
  const textOffset = 64;
  const shstrOffset = textOffset + text.length;
  const shoff = shstrOffset + shstr.length;
  const shnum = 3;
  const elf = Buffer.alloc(shoff + shnum * SECTION_HEADER_SIZE);

  elf.writeUInt32LE(0x464c457f, 0);
  elf.writeUInt8(2, 4);
  elf.writeUInt8(1, 5);
  elf.writeUInt8(1, 6);
  elf.writeUInt16LE(3, 16);
  elf.writeUInt16LE(183, 18);
  elf.writeUInt32LE(1, 20);
  elf.writeBigUInt64LE(BigInt(shoff), 40);
  elf.writeUInt16LE(64, 52);
  elf.writeUInt16LE(SECTION_HEADER_SIZE, 58);
  elf.writeUInt16LE(shnum, 60);
  elf.writeUInt16LE(2, 62);

  text.copy(elf, textOffset);
  shstr.copy(elf, shstrOffset);

  const textEntry = shoff + SECTION_HEADER_SIZE;
  elf.writeUInt32LE(1, textEntry);
  elf.writeUInt32LE(1, textEntry + 4);
  elf.writeBigUInt64LE(BigInt(textOffset), textEntry + 24);
  elf.writeBigUInt64LE(BigInt(text.length), textEntry + 32);
  elf.writeBigUInt64LE(16n, textEntry + 48);

  const shstrEntry = shoff + 2 * SECTION_HEADER_SIZE;
  elf.writeUInt32LE(7, shstrEntry);
  elf.writeUInt32LE(3, shstrEntry + 4);
  elf.writeBigUInt64LE(BigInt(shstrOffset), shstrEntry + 24);
  elf.writeBigUInt64LE(BigInt(shstr.length), shstrEntry + 32);
  elf.writeBigUInt64LE(1n, shstrEntry + 48);

  return elf;
}

function zeroedPageHash(page: Uint8Array): Buffer {
  const padded = Buffer.alloc(PAGE_SIZE);
  padded.set(page);
  return sha256(padded);
}

describe('ohosElfCodeSign', () => {
  it('distinguishes ELF binaries from scripts and non-ELF files', () => {
    expect(isElfBinary(buildElf64(Buffer.from('code')))).toBe(true);
    expect(isElfBinary(Buffer.from('#!/bin/sh\nexec rg "$@"\n'))).toBe(false);
    expect(isElfBinary(Buffer.from([0x7f, 0x45, 0x4c]))).toBe(false);
  });

  it('adds an aligned .codesign section with an OpenHarmony v3 self-sign block', () => {
    const text = Buffer.from('ohos rg text segment');
    const original = buildElf64(text);
    expect(hasOhosElfCodeSign(original)).toBe(false);

    const signed = selfSignOhosElf(original);
    expect(hasOhosElfCodeSign(signed)).toBe(true);
    expect(signed.subarray(64, 64 + text.length)).toEqual(text);

    const shoff = Number(signed.readBigUInt64LE(40));
    const shnum = signed.readUInt16LE(60);
    const shstrndx = signed.readUInt16LE(62);
    expect(shnum).toBe(4);
    expect(shoff % SECTION_HEADER_SIZE).toBe(0);

    const shstrEntry = shoff + shstrndx * SECTION_HEADER_SIZE;
    const shstrOff = Number(signed.readBigUInt64LE(shstrEntry + 24));
    const shstrSize = Number(signed.readBigUInt64LE(shstrEntry + 32));
    const shstr = signed.subarray(shstrOff, shstrOff + shstrSize).toString('utf8');
    expect(shstr.endsWith('.codesign\0')).toBe(true);

    const csEntry = shoff + 3 * SECTION_HEADER_SIZE;
    const csOff = Number(signed.readBigUInt64LE(csEntry + 24));
    const csSize = Number(signed.readBigUInt64LE(csEntry + 32));
    const csAlign = Number(signed.readBigUInt64LE(csEntry + 48));
    expect(csOff).toBe(PAGE_SIZE);
    expect(csSize).toBe(PAGE_SIZE);
    expect(csAlign).toBe(PAGE_SIZE);

    const block = signed.subarray(csOff, csOff + PAGE_SIZE);
    expect(block.readUInt32LE(0)).toBe(1);
    expect(block.readUInt32LE(4)).toBe(288);
    const descriptor = Buffer.from(block.subarray(8, 8 + 256));
    const signature = block.subarray(8 + 256, 8 + 256 + 32);
    expect(descriptor.readUInt8(0)).toBe(1);
    expect(descriptor.readUInt8(1)).toBe(1);
    expect(descriptor.readUInt8(2)).toBe(12);
    expect(descriptor.readUInt8(3)).toBe(0);
    expect(descriptor.readUInt32LE(4)).toBe(32);
    expect(descriptor.readBigUInt64LE(8)).toBe(BigInt(signed.length));
    expect(descriptor.readUInt32LE(112)).toBe(16);
    expect(descriptor.readUInt8(255)).toBe(3);

    const leaf0 = zeroedPageHash(signed.subarray(0, PAGE_SIZE));
    const leaf2 = zeroedPageHash(signed.subarray(PAGE_SIZE * 2));
    const topBlock = Buffer.alloc(PAGE_SIZE);
    leaf0.copy(topBlock, 0);
    leaf2.copy(topBlock, 64);
    expect(descriptor.subarray(16, 48)).toEqual(sha256(topBlock));

    descriptor.writeUInt32LE(0, 4);
    expect(signature).toEqual(sha256(descriptor));
    expect(block.subarray(8 + 288).every((b) => b === 0)).toBe(true);
  });

  it('produces identical bytes when re-signing an already self-signed ELF', () => {
    const once = selfSignOhosElf(buildElf64(Buffer.from('idempotent')));
    const twice = selfSignOhosElf(once);
    expect(twice).toEqual(once);
  });

  it('updates the signature when any executable byte changes', () => {
    const original = buildElf64(Buffer.alloc(PAGE_SIZE * 130, 0x5a));
    const tampered = Buffer.from(original);
    tampered[100] = 0x5b;

    const signedOriginal = selfSignOhosElf(original);
    const signedTampered = selfSignOhosElf(tampered);
    expect(hasOhosElfCodeSign(signedOriginal)).toBe(true);
    expect(hasOhosElfCodeSign(signedTampered)).toBe(true);
    const shoff = Number(signedOriginal.readBigUInt64LE(40));
    const csOff = Number(signedOriginal.readBigUInt64LE(shoff + 3 * SECTION_HEADER_SIZE + 24));
    expect(signedOriginal.subarray(csOff + 24, csOff + 56)).not.toEqual(
      signedTampered.subarray(csOff + 24, csOff + 56),
    );
  });

  it('rejects non-ELF, truncated, non-64-bit, and big-endian inputs', () => {
    expect(() => selfSignOhosElf(Buffer.from('#!/bin/sh\n'))).toThrow(/not a valid ELF binary/);
    expect(() => selfSignOhosElf(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))).toThrow(/not a valid ELF binary/);

    const elf32 = buildElf64(Buffer.from('x'));
    elf32[4] = 1;
    expect(() => selfSignOhosElf(elf32)).toThrow(/64-bit little-endian/);

    const bigEndian = buildElf64(Buffer.from('x'));
    bigEndian[5] = 2;
    expect(() => selfSignOhosElf(bigEndian)).toThrow(/64-bit little-endian/);
  });

  it('rejects out-of-bounds section tables and unaligned existing .codesign sections', () => {
    const badShoff = buildElf64(Buffer.from('x'));
    badShoff.writeBigUInt64LE(BigInt(badShoff.length + 4096), 40);
    expect(() => selfSignOhosElf(badShoff)).toThrow(/section header table is out of bounds/);

    const unaligned = selfSignOhosElf(buildElf64(Buffer.from('x')));
    const shoff = Number(unaligned.readBigUInt64LE(40));
    const csEntry = shoff + 3 * SECTION_HEADER_SIZE;
    unaligned.writeBigUInt64LE(BigInt(PAGE_SIZE + 16), csEntry + 24);
    expect(() => selfSignOhosElf(unaligned)).toThrow(/not 4K-aligned/);
  });
});
