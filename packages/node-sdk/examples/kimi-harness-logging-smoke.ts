import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createKimiHarness, log } from '@moonshot-ai/kimi-code-sdk';

const SESSION_LOG = 'logs/kimi-code.log';
const GLOBAL_LOG = 'logs/global/kimi-code.log';
const MAIN_WIRE = 'agents/main/wire.jsonl';
const TEST_HOME = join(homedir(), '.kimi-code-test');
const MAX_LOG_BYTES = 4096;

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function expectEntry(entries: readonly string[], name: string): void {
  assert(entries.includes(name), `missing ${name} from export`);
}

function isSessionLogEntry(entry: string): boolean {
  return entry === SESSION_LOG || entry.startsWith(`${SESSION_LOG}.`);
}

async function readSessionLogs(sessionDir: string): Promise<{
  readonly files: readonly string[];
  readonly text: string;
}> {
  const logsDir = join(sessionDir, 'logs');
  const files = (await readdir(logsDir))
    .filter((file) => file === 'kimi-code.log' || file.startsWith('kimi-code.log.'))
    .toSorted();
  const chunks = await Promise.all(files.map((file) => readFile(join(logsDir, file), 'utf-8')));
  return { files, text: chunks.join('\n') };
}

async function assertRotatedFilesStayBounded(sessionDir: string, files: readonly string[]): Promise<void> {
  assert(files.includes('kimi-code.log.1'), 'session log did not rotate after exceeding max bytes');
  assert(!files.includes('kimi-code.log.2'), 'session log kept more archives than configured');
  for (const file of files) {
    const size = (await stat(join(sessionDir, 'logs', file))).size;
    assert(size <= MAX_LOG_BYTES, `${file} exceeded ${MAX_LOG_BYTES} bytes: ${size}`);
  }
}

async function describeFiles(dir: string, files: readonly string[]): Promise<string[]> {
  return Promise.all(
    files.map(async (file) => {
      const size = (await stat(join(dir, file))).size;
      return `  - ${file} (${size} bytes)`;
    }),
  );
}

async function main(): Promise<void> {
  process.env['KIMI_CODE_HOME'] = TEST_HOME;
  process.env['KIMI_LOG_LEVEL'] = 'warn';
  process.env['KIMI_LOG_SESSION_MAX_BYTES'] = String(MAX_LOG_BYTES);
  process.env['KIMI_LOG_SESSION_FILES'] = '2';
  process.env['KIMI_LOG_GLOBAL_MAX_BYTES'] = String(MAX_LOG_BYTES);
  process.env['KIMI_LOG_GLOBAL_FILES'] = '2';

  await rm(TEST_HOME, { recursive: true, force: true });
  await mkdir(TEST_HOME, { recursive: true });
  const workDir = join(TEST_HOME, 'work');
  await mkdir(workDir, { recursive: true });
  const runId = Date.now().toString(36);
  const sessionId = `ses_logging_smoke_${runId}`;
  const evictedEntry = `SMOKE_EVICTED_SHOULD_NOT_APPEAR_${runId}`;
  const warning = `SMOKE_SESSION_WARNING_${runId}`;
  const failure = `SMOKE_SESSION_ERROR_${runId}`;
  const globalOnly = `SMOKE_GLOBAL_ONLY_${runId}`;
  const longEntry = `SMOKE_LONG_TRUNCATED_${runId}`;
  const finalEntry = `SMOKE_FINAL_AFTER_ROTATION_SHOULD_APPEAR_${runId}`;
  const harness = createKimiHarness({
    identity: { userAgentProduct: 'kimi-code-cli', version: '0.1.1' },
    homeDir: TEST_HOME,
  });

  try {
    const session = await harness.createSession({ id: sessionId, workDir });
    const summary = (await harness.listSessions({ workDir })).find((s) => s.id === session.id);
    assert(summary !== undefined, 'created session missing from listSessions');

    log.warn(evictedEntry, {
      sessionId: session.id,
      chunk: 'e'.repeat(300),
    });
    for (let i = 0; i < 60; i++) {
      log.warn(`SMOKE_ROTATION_FILLER_${runId}_${i}`, {
        sessionId: session.id,
        chunk: 'r'.repeat(300),
      });
    }
    log.warn(warning, {
      sessionId: session.id,
      code: 'SMOKE_WARN',
      token: 'must-not-leak',
    });
    log.error(failure, {
      sessionId: session.id,
      authorization: 'Bearer must-not-leak',
      error: new Error('SMOKE_ERROR'),
    });
    log.warn(globalOnly);
    log.warn(longEntry, {
      sessionId: session.id,
      cookie: 'must-not-leak',
      chunk: 'x'.repeat(2000),
    });
    log.warn(finalEntry, { sessionId: session.id });

    const sessionOnly = await harness.exportSession({
      id: session.id,
      outputPath: join(workDir, 'logging-session.zip'),
      version: '1.0.0-test',
    });
    expectEntry(sessionOnly.entries, 'manifest.json');
    expectEntry(sessionOnly.entries, MAIN_WIRE);
    const exportedSessionLogs = sessionOnly.entries.filter(isSessionLogEntry);
    assert(exportedSessionLogs.length > 0, 'default export did not include any session log files');
    assert(!sessionOnly.entries.includes(GLOBAL_LOG), 'default export included global log');
    if (sessionOnly.entries.includes(SESSION_LOG)) {
      assert(sessionOnly.manifest.sessionLogPath === SESSION_LOG, 'bad sessionLogPath');
    } else {
      assert(sessionOnly.manifest.sessionLogPath === undefined, 'manifest pointed at a missing active session log');
    }
    assert(sessionOnly.manifest.globalLogPath === undefined, 'default export set globalLogPath');

    const sessionLogs = await readSessionLogs(summary.sessionDir);
    await assertRotatedFilesStayBounded(summary.sessionDir, sessionLogs.files);
    const sessionLog = sessionLogs.text;
    assert(sessionLog.includes(warning), 'session log missed warning');
    assert(sessionLog.includes(failure), 'session log missed error');
    assert(!sessionLog.includes(globalOnly), 'session log included global-only entry');
    assert(!sessionLog.includes(evictedEntry), 'oldest session log entry was not evicted');
    assert(!sessionLog.includes('must-not-leak'), 'session log leaked sensitive value');
    assert(sessionLog.includes('[REDACTED]'), 'session log did not redact sensitive value');
    assert(sessionLog.includes(longEntry), 'session log missed long-entry marker');
    assert(sessionLog.includes('…'), 'session log did not show truncation for long entry');
    assert(sessionLog.includes(finalEntry), 'session log missed final entry after rotation');

    const withGlobal = await harness.exportSession({
      id: session.id,
      outputPath: join(workDir, 'logging-with-global.zip'),
      includeGlobalLog: true,
      version: '1.0.0-test',
    });
    expectEntry(withGlobal.entries, GLOBAL_LOG);
    assert(withGlobal.manifest.globalLogPath === GLOBAL_LOG, 'bad globalLogPath');

    const globalFiles = (await readdir(join(TEST_HOME, 'logs')))
      .filter((file) => file === 'kimi-code.log' || file.startsWith('kimi-code.log.'))
      .toSorted();
    const globalLog = (
      await Promise.all(globalFiles.map((file) => readFile(join(TEST_HOME, 'logs', file), 'utf-8')))
    ).join('\n');
    assert(globalLog.includes(globalOnly), 'global log missed global-only entry');
    assert(globalLog.includes(warning), 'global log missed session warning');

    const resultPath = join(TEST_HOME, 'SMOKE_RESULT.txt');
    const sessionSizeLines = await describeFiles(join(summary.sessionDir, 'logs'), sessionLogs.files);
    const globalSizeLines = await describeFiles(join(TEST_HOME, 'logs'), globalFiles);
    await writeFile(
      resultPath,
      [
        'local logging smoke: PASS',
        '',
        `homeDir: ${TEST_HOME}`,
        `workDir: ${workDir}`,
        `sessionDir: ${summary.sessionDir}`,
        `sessionExport: ${sessionOnly.zipPath}`,
        `globalExport: ${withGlobal.zipPath}`,
        '',
        `smoke log cap: ${MAX_LOG_BYTES} bytes per file`,
        'production defaults are larger; this small cap is only for rotation testing.',
        '',
        'Open these files:',
        '  - logs/kimi-code.log',
        '  - logs/kimi-code.log.1',
        `  - ${summary.sessionDir}/logs/kimi-code.log`,
        `  - ${summary.sessionDir}/logs/kimi-code.log.1`,
        '',
        'Rotation evidence:',
        `  - should NOT appear in session logs: ${evictedEntry}`,
        `  - should appear in session logs: ${finalEntry}`,
        '  - kimi-code.log.1 exists',
        '  - kimi-code.log.2 does not exist',
        '',
        'Export evidence:',
        '  - logging-session.zip includes session logs and wire.jsonl',
        '  - logging-session.zip does not include logs/global/kimi-code.log',
        '  - logging-with-global.zip includes only the active global log at logs/global/kimi-code.log',
        '  - global rotated logs such as ~/.kimi-code-test/logs/kimi-code.log.1 are intentionally not bundled',
        '',
        'Redaction evidence:',
        '  - must-not-leak should NOT appear',
        '  - [REDACTED] should appear',
        '',
        'Session log files:',
        ...sessionSizeLines,
        '',
        'Global log files:',
        ...globalSizeLines,
        '',
      ].join('\n'),
      'utf-8',
    );

    process.stdout.write(`logging smoke passed\nhomeDir=${TEST_HOME}\nworkDir=${workDir}\n`);
    process.stdout.write(`sessionExport=${sessionOnly.zipPath}\n`);
    process.stdout.write(`globalExport=${withGlobal.zipPath}\n`);
    process.stdout.write(`result=${resultPath}\n`);
    process.stdout.write(`openCommand=open ${TEST_HOME}\n`);
  } finally {
    await harness.close().catch(() => {});
  }
}

try {
  await main();
} catch (error: unknown) {
  console.error(error);
  process.exitCode = 1;
}
