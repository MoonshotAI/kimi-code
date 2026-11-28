import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  deriveMachOUuid,
  formatUuid,
  rewriteMachOUuid,
  rewriteMachOUuidFile,
} from '../../../scripts/macho-uuid.mjs';

const require = createRequire(import.meta.url);
const configPath = require.resolve('../../../electron-builder.config.cjs') as string;
const STOCK_UUID = Buffer.from('4c4c440955553144a1c91ec111d8ed34', 'hex');
const MH_MAGIC_64 = 0xfeedfacf;
const MH_MAGIC = 0xfeedface;
const FAT_MAGIC = 0xcafebabe;
const FAT_CIGAM = 0xbebafeca;
const FAT_MAGIC_64 = 0xcafebabf;
const FAT_CIGAM_64 = 0xbfbafeca;
const LC_UUID = 0x1b;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

interface ThinFixture {
  buffer: Buffer;
  uuidOffset: number;
}

function buildThinMachO({ littleEndian = true, cpuType = CPU_TYPE_ARM64 } = {}): ThinFixture {
  const segmentBefore = 24;
  const uuidCommand = 24;
  const segmentAfter = 16;
  const sizeofcmds = segmentBefore + uuidCommand + segmentAfter;
  const total = 32 + sizeofcmds + 64;
  const buffer = Buffer.alloc(total, 0xa5);
  const write32 = (offset: number, value: number) =>
    littleEndian ? buffer.writeUInt32LE(value >>> 0, offset) : buffer.writeUInt32BE(value >>> 0, offset);

  if (littleEndian) buffer.writeUInt32LE(MH_MAGIC_64, 0);
  else buffer.writeUInt32BE(MH_MAGIC_64, 0);
  write32(4, cpuType);
  write32(8, 0);
  write32(12, 2);
  write32(16, 3);
  write32(20, sizeofcmds);
  write32(24, 0x00200085);
  write32(28, 0);

  write32(32, 0x19);
  write32(36, segmentBefore);
  buffer.fill(0x3c, 40, 32 + segmentBefore);

  const uuidCommandOffset = 32 + segmentBefore;
  write32(uuidCommandOffset, LC_UUID);
  write32(uuidCommandOffset + 4, uuidCommand);
  STOCK_UUID.copy(buffer, uuidCommandOffset + 8);

  const afterOffset = uuidCommandOffset + uuidCommand;
  write32(afterOffset, 0x2);
  write32(afterOffset + 4, segmentAfter);
  buffer.fill(0x7e, afterOffset + 8, afterOffset + segmentAfter);

  return { buffer, uuidOffset: uuidCommandOffset + 8 };
}

function buildFatMachO({
  magic = FAT_MAGIC,
  gap = 16,
}: {
  magic?: number;
  gap?: number;
} = {}): { buffer: Buffer; slices: ThinFixture[] } {
  const is64 = magic === FAT_MAGIC_64 || magic === FAT_CIGAM_64;
  const littleEndian = magic === FAT_CIGAM || magic === FAT_CIGAM_64;
  const entrySize = is64 ? 32 : 20;
  const headerSize = 8 + 2 * entrySize;
  const firstOffset = headerSize + gap;
  const arm64 = buildThinMachO({ cpuType: CPU_TYPE_ARM64 });
  const x64 = buildThinMachO({ cpuType: CPU_TYPE_X86_64 });
  const secondOffset = firstOffset + arm64.buffer.length + gap;
  const buffer = Buffer.alloc(secondOffset + x64.buffer.length, 0x5a);

  const write32 = (offset: number, value: number) =>
    littleEndian ? buffer.writeUInt32LE(value >>> 0, offset) : buffer.writeUInt32BE(value >>> 0, offset);
  const write64 = (offset: number, value: bigint) =>
    littleEndian ? buffer.writeBigUInt64LE(value, offset) : buffer.writeBigUInt64BE(value, offset);

  buffer.writeUInt32BE(magic, 0);
  write32(4, 2);
  for (const [index, cpuType, offset, size] of [
    [0, CPU_TYPE_ARM64, firstOffset, arm64.buffer.length],
    [1, CPU_TYPE_X86_64, secondOffset, x64.buffer.length],
  ] as const) {
    const entry = 8 + index * entrySize;
    write32(entry, cpuType);
    write32(entry + 4, 0);
    if (is64) {
      write64(entry + 8, BigInt(offset));
      write64(entry + 16, BigInt(size));
    } else {
      write32(entry + 8, offset);
      write32(entry + 12, size);
    }
  }
  arm64.buffer.copy(buffer, firstOffset);
  x64.buffer.copy(buffer, secondOffset);
  return {
    buffer,
    slices: [
      { buffer, uuidOffset: firstOffset + arm64.uuidOffset },
      { buffer, uuidOffset: secondOffset + x64.uuidOffset },
    ],
  };
}

function expectOnlyUuidChanged(source: Buffer, next: Buffer, uuidOffsets: number[]): void {
  expect(next.length).toBe(source.length);
  const changedOffsets: number[] = [];
  for (let index = 0; index < source.length; index++) {
    if (source[index] !== next[index]) changedOffsets.push(index);
  }
  for (const index of changedOffsets) {
    expect(uuidOffsets.some((offset) => index >= offset && index < offset + 16)).toBe(true);
  }
  for (const offset of uuidOffsets) {
    expect(next.subarray(offset, offset + 16).equals(source.subarray(offset, offset + 16))).toBe(false);
  }
}

afterEach(() => {
  delete process.env['KIMI_DESKTOP_CANARY'];
  delete process.env['KIMI_DESKTOP_PREVIEW'];
  delete require.cache[configPath];
});

describe('deriveMachOUuid', () => {
  it('derives deterministic RFC 9562 version-8 UUIDs with the RFC 4122 variant', () => {
    const first = deriveMachOUuid('com.kimi.code.desktop', 'arm64');
    const second = deriveMachOUuid('com.kimi.code.desktop', 'arm64');
    expect(first).toHaveLength(16);
    expect(first.equals(second)).toBe(true);
    expect((first[6]! >> 4) & 0x0f).toBe(8);
    expect((first[8]! >> 6) & 0x03).toBe(2);
    expect(formatUuid(first)).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-8[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
  });

  it('gives Stable, Preview, Canary, other vendors and each architecture distinct UUIDs', () => {
    const appIds = [
      'com.kimi.code.desktop',
      'com.kimi.code.desktop.preview',
      'com.kimi.code.desktop.canary',
      'com.example.other',
    ];
    const derived = appIds.flatMap((appId) => ['arm64', 'x64'].map((arch) => deriveMachOUuid(appId, arch)));
    const unique = new Set(derived.map((uuid) => uuid.toString('hex')));
    expect(unique.size).toBe(derived.length);
    expect(unique.has(STOCK_UUID.toString('hex'))).toBe(false);
  });

  it('rejects empty appId or arch', () => {
    expect(() => deriveMachOUuid('', 'arm64')).toThrow(/appId/);
    expect(() => deriveMachOUuid('com.kimi.code.desktop', '')).toThrow(/arch/);
  });
});

describe('rewriteMachOUuid', () => {
  for (const littleEndian of [true, false]) {
    it(`replaces only the 16 LC_UUID bytes in a ${littleEndian ? 'little' : 'big'}-endian 64-bit Mach-O`, () => {
      const fixture = buildThinMachO({ littleEndian });
      const original = Buffer.from(fixture.buffer);
      const result = rewriteMachOUuid(fixture.buffer, { appId: 'com.kimi.code.desktop' });
      expect(result.changed).toBe(true);
      expect(result.uuids).toHaveLength(1);
      expect(result.uuids[0]!.arch).toBe('arm64');
      expectOnlyUuidChanged(original, result.buffer, [fixture.uuidOffset]);
      expect(result.buffer.subarray(fixture.uuidOffset, fixture.uuidOffset + 16)).toEqual(
        deriveMachOUuid('com.kimi.code.desktop', 'arm64'),
      );
      expect(fixture.buffer.equals(original)).toBe(true);
    });
  }

  it('is idempotent and reproducible for the same appId and arch', () => {
    const fixture = buildThinMachO();
    const first = rewriteMachOUuid(fixture.buffer, { appId: 'com.kimi.code.desktop.canary', arch: 'arm64' });
    const second = rewriteMachOUuid(first.buffer, { appId: 'com.kimi.code.desktop.canary', arch: 'arm64' });
    const rebuilt = rewriteMachOUuid(buildThinMachO().buffer, {
      appId: 'com.kimi.code.desktop.canary',
      arch: 'arm64',
    });
    expect(second.changed).toBe(false);
    expect(second.buffer.equals(first.buffer)).toBe(true);
    expect(rebuilt.buffer.equals(first.buffer)).toBe(true);
  });

  it('rejects a thin Mach-O whose CPU type disagrees with the requested arch', () => {
    const fixture = buildThinMachO({ cpuType: CPU_TYPE_ARM64 });
    expect(() => rewriteMachOUuid(fixture.buffer, { appId: 'com.kimi.code.desktop', arch: 'x64' })).toThrow(
      /does not match build architecture x64/,
    );
  });

  for (const magic of [FAT_MAGIC, FAT_CIGAM, FAT_MAGIC_64, FAT_CIGAM_64]) {
    it(`rewrites each slice of a universal binary (0x${magic.toString(16)}) with its own arch UUID`, () => {
      const fixture = buildFatMachO({ magic });
      const original = Buffer.from(fixture.buffer);
      const result = rewriteMachOUuid(fixture.buffer, {
        appId: 'com.kimi.code.desktop.preview',
        arch: 'universal',
      });
      expect(result.changed).toBe(true);
      expect(result.uuids.map((entry) => entry.arch)).toEqual(['arm64', 'x64']);
      expectOnlyUuidChanged(
        original,
        result.buffer,
        fixture.slices.map((slice) => slice.uuidOffset),
      );
      expect(result.buffer.subarray(fixture.slices[0]!.uuidOffset, fixture.slices[0]!.uuidOffset + 16)).toEqual(
        deriveMachOUuid('com.kimi.code.desktop.preview', 'arm64'),
      );
      expect(result.buffer.subarray(fixture.slices[1]!.uuidOffset, fixture.slices[1]!.uuidOffset + 16)).toEqual(
        deriveMachOUuid('com.kimi.code.desktop.preview', 'x64'),
      );
      const again = rewriteMachOUuid(result.buffer, {
        appId: 'com.kimi.code.desktop.preview',
        arch: 'universal',
      });
      expect(again.changed).toBe(false);
      expect(again.buffer.equals(result.buffer)).toBe(true);
    });
  }

  it('rejects malformed or truncated buffers without mutating the input', () => {
    const valid = buildThinMachO().buffer;
    const noUuid = Buffer.from(valid);
    noUuid.writeUInt32LE(0x19, 56);
    const duplicateUuid = Buffer.alloc(valid.length + 24, 0xa5);
    valid.subarray(0, 96).copy(duplicateUuid);
    duplicateUuid.writeUInt32LE(4, 16);
    duplicateUuid.writeUInt32LE(88, 20);
    duplicateUuid.writeUInt32LE(LC_UUID, 96);
    duplicateUuid.writeUInt32LE(24, 100);

    const badCmdsize = Buffer.from(valid);
    badCmdsize.writeUInt32LE(4, 36);
    const misalignedCmdsize = Buffer.from(valid);
    misalignedCmdsize.writeUInt32LE(28, 36);
    const overrunningCmdsize = Buffer.from(valid);
    overrunningCmdsize.writeUInt32LE(0xffff, 36);
    const shortUuid = Buffer.from(valid);
    shortUuid.writeUInt32LE(16, 60);
    const shortHeader = Buffer.from(valid);
    shortHeader.writeUInt32LE(0xffffff, 20);
    const extraCommands = Buffer.from(valid);
    extraCommands.writeUInt32LE(4, 16);
    const unknownCpu = buildThinMachO({ cpuType: 0x0000000c }).buffer;
    const thin32 = Buffer.from(valid);
    thin32.writeUInt32LE(MH_MAGIC, 0);

    const emptyFat = Buffer.alloc(8);
    emptyFat.writeUInt32BE(FAT_MAGIC, 0);
    const truncatedFatTable = Buffer.from(buildFatMachO().buffer.subarray(0, 20));
    const overlappingHeaderFat = buildFatMachO({ gap: -4 }).buffer;
    const outOfBoundsFat = buildFatMachO().buffer;
    outOfBoundsFat.writeUInt32BE(0xffffff, 16);
    const hugeFat64 = buildFatMachO({ magic: FAT_MAGIC_64 }).buffer;
    hugeFat64.writeBigUInt64BE(2n ** 60n, 16);
    const nestedFat = buildFatMachO().buffer;
    nestedFat.writeUInt32BE(FAT_MAGIC, 64);

    const cases: Array<[string, Buffer]> = [
      ['empty', Buffer.alloc(0)],
      ['two-byte', Buffer.from([0xcf, 0xfa])],
      ['not mach-o', Buffer.from('ELF!\0\0\0\0', 'utf8')],
      ['32-bit mach-o', thin32],
      ['truncated header', valid.subarray(0, 20)],
      ['truncated uuid', valid.subarray(0, 72)],
      ['sizeofcmds past slice', shortHeader],
      ['cmdsize below header', badCmdsize],
      ['misaligned cmdsize', misalignedCmdsize],
      ['overrunning cmdsize', overrunningCmdsize],
      ['short LC_UUID', shortUuid],
      ['missing LC_UUID', noUuid],
      ['duplicate LC_UUID', duplicateUuid],
      ['ncmds mismatch', extraCommands],
      ['unsupported cpu', unknownCpu],
      ['empty fat', emptyFat],
      ['truncated fat table', truncatedFatTable],
      ['slice overlapping fat header', overlappingHeaderFat],
      ['slice past EOF', outOfBoundsFat],
      ['64-bit slice offset overflow', hugeFat64],
      ['nested fat slice', nestedFat],
    ];

    for (const [label, malformed] of cases) {
      const snapshot = Buffer.from(malformed);
      expect(() => rewriteMachOUuid(malformed, { appId: 'com.kimi.code.desktop' }), label).toThrow();
      expect(malformed.equals(snapshot), label).toBe(true);
    }
  });
});

describe('rewriteMachOUuidFile and afterPack', () => {
  it('rewrites in place without changing file size or executable permissions', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'macho-uuid-file-'));
    try {
      const filePath = join(directory, 'Kimi Code');
      const fixture = buildThinMachO();
      writeFileSync(filePath, fixture.buffer, { mode: 0o755 });
      chmodSync(filePath, 0o755);
      const before = statSync(filePath);
      const first = await rewriteMachOUuidFile(filePath, {
        appId: 'com.kimi.code.desktop',
        arch: 'arm64',
      });
      const second = await rewriteMachOUuidFile(filePath, {
        appId: 'com.kimi.code.desktop',
        arch: 'arm64',
      });
      const after = statSync(filePath);
      expect(first.changed).toBe(true);
      expect(second.changed).toBe(false);
      expect(after.size).toBe(before.size);
      expect(after.mode & 0o777).toBe(0o755);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('afterPack rewrites only Contents/MacOS/<productFilename> for darwin and leaves helpers untouched', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'macho-afterpack-'));
    try {
      const config = require(configPath) as {
        afterPack: (context: unknown) => Promise<void>;
      };
      const appDir = join(directory, 'Kimi Code.app');
      const mainExecutable = join(appDir, 'Contents', 'MacOS', 'Kimi Code');
      const helperExecutable = join(appDir, 'Contents', 'Frameworks', 'Kimi Code Helper.app', 'Contents', 'MacOS', 'Kimi Code Helper');
      const frameworkBinary = join(appDir, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework');
      for (const target of [mainExecutable, helperExecutable, frameworkBinary]) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, buildThinMachO().buffer, { mode: 0o755 });
      }

      await config.afterPack({
        electronPlatformName: 'darwin',
        appOutDir: directory,
        outDir: directory,
        arch: 3,
        targets: [],
        packager: {
          appInfo: {
            id: 'com.kimi.code.desktop',
            productFilename: 'Kimi Code',
          },
        },
      });

      const patched = rewriteMachOUuid(buildThinMachO().buffer, { appId: 'com.kimi.code.desktop', arch: 'arm64' });
      expect(readFileSync(mainExecutable).equals(patched.buffer)).toBe(true);
      expect(readFileSync(helperExecutable).equals(buildThinMachO().buffer)).toBe(true);
      expect(readFileSync(frameworkBinary).equals(buildThinMachO().buffer)).toBe(true);

      await expect(
        config.afterPack({
          electronPlatformName: 'linux',
          appOutDir: directory,
          outDir: directory,
          arch: 1,
          targets: [],
          packager: {
            appInfo: {
              id: 'com.kimi.code.desktop',
              productFilename: 'Kimi Code',
              version: '1.5.1',
            },
          },
        }),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
