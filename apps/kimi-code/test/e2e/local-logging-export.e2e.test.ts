import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerExportCommand } from '#/cli/sub/export';
import { createKimiCodeHostIdentity } from '#/cli/version';
import { createKimiHarness } from '#/cli/prompt-harness-local';

const ENABLED = process.env['KIMI_E2E'] === '1';

let homeDir: string;
let workDir: string;
let oldHome: string | undefined;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'kimi-cli-log-home-'));
  workDir = await mkdtemp(join(tmpdir(), 'kimi-cli-log-work-'));
  oldHome = process.env['KIMI_CODE_HOME'];
  process.env['KIMI_CODE_HOME'] = homeDir;
});

afterEach(async () => {
  if (oldHome === undefined) {
    delete process.env['KIMI_CODE_HOME'];
  } else {
    process.env['KIMI_CODE_HOME'] = oldHome;
  }
  await rm(homeDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

describe.skipIf(!ENABLED)('kimi export e2e', () => {
  it('exports the engine archive: manifest + wire records + session files', async () => {
    const harness = createKimiHarness({
      homeDir,
      identity: createKimiCodeHostIdentity('0.1.1'),
    });
    try {
      const session = await harness.createSession({
        id: 'ses_cli_export',
        workDir,
      });

      const zipPath = join(workDir, 'default.zip');
      await runKimiExport([session.id, '-o', zipPath]);
      const entries = readZipEntries(await readFile(zipPath));

      // Engine export semantics (G-2/G-6): the archive carries
      // `manifest.json`, the session's wire records as `wire.json`, and the
      // session-directory files. The legacy SDK export bundled host logs
      // (logs/kimi-code.log) with manifest sessionLogPath/globalLogPath —
      // the Rust engine does not collect host logs (retired with the SDK).
      expect(entries.has('manifest.json')).toBe(true);
      expect(entries.has('wire.json')).toBe(true);
      const manifest = JSON.parse(
        entries.get('manifest.json')!.toString('utf-8'),
      ) as Record<string, unknown>;
      expect(manifest['sessionId']).toBe(session.id);
      expect(typeof manifest['protocolVersion']).toBe('number');
    } finally {
      await harness.close().catch(() => {});
    }
  }, 15_000);
});

async function runKimiExport(args: string[]): Promise<void> {
  const program = new Command('kimi');
  const stdout: string[] = [];
  const stderr: string[] = [];
  registerExportCommand(program, {
    stdout: {
      write: (chunk) => {
        stdout.push(chunk);
        return true;
      },
    },
    stderr: {
      write: (chunk) => {
        stderr.push(chunk);
        return true;
      },
    },
    exit: (code: number): never => {
      throw new Error(`kimi export exited ${code}: ${stderr.join('')}`);
    },
  });
  await program.parseAsync(['node', 'kimi', 'export', ...args]);
}

function readZipEntries(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('zip eocd not found');
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  let pos = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('bad cd entry');
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const fnameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const lfhOffset = buf.readUInt32LE(pos + 42);
    const filename = buf.toString('utf8', pos + 46, pos + 46 + fnameLen);
    if (buf.readUInt32LE(lfhOffset) !== 0x04034b50) throw new Error('bad lfh');
    const lfhFnameLen = buf.readUInt16LE(lfhOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(lfhOffset + 28);
    const dataStart = lfhOffset + 30 + lfhFnameLen + lfhExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? compressed : method === 8 ? zlib.inflateRawSync(compressed) : null;
    if (data === null) throw new Error('unsupported compression');
    entries.set(filename, data);
    pos += 46 + fnameLen + extraLen + commentLen;
  }
  return entries;
}
