import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import {
  createKimiHarness,
  flushDiagnosticLogs,
  log,
  resolveGlobalLogPath,
  resolveKimiHome,
} from '@moonshot-ai/kimi-code-sdk';

type MarkerLevel = 'error' | 'warn';

interface CliValues {
  readonly help?: boolean | undefined;
  readonly home?: string | undefined;
  readonly level?: string | undefined;
  readonly message?: string | undefined;
  readonly session?: string | undefined;
}

interface Options {
  readonly sessionId: string;
  readonly homeDir?: string | undefined;
  readonly level: MarkerLevel;
  readonly marker: string;
}

const USAGE = `Usage:
  pnpm exec tsx --import ./build/register-raw-text-loader.mjs packages/node-sdk/examples/kimi-harness-log-marker.ts --session <session-id>

Options:
  -s, --session <id>   Existing session id to resume and mark
      --home <dir>     Kimi home dir; defaults to KIMI_CODE_HOME or ~/.kimi-code
      --level <level>  error | warn; defaults to error
  -m, --message <text> Marker text; defaults to MANUAL_SESSION_LOG_MARKER_<timestamp>
  -h, --help           Show this help
`;

async function main(): Promise<void> {
  const options = parseCliArgs();
  const resolvedHome = resolveKimiHome(options.homeDir);
  const harness = createKimiHarness({
    identity: { userAgentProduct: 'kimi-code-cli', version: 'log-marker' },
    homeDir: options.homeDir,
  });

  let sessionLogPath: string | undefined;
  try {
    const session = await harness.resumeSession({ id: options.sessionId });
    const sessionDir = session.summary?.sessionDir;
    if (sessionDir === undefined) {
      throw new Error(`Session "${session.id}" resumed without a sessionDir summary`);
    }

    sessionLogPath = join(sessionDir, 'logs', 'kimi-code.log');
    const payload = {
      sessionId: session.id,
      purpose: 'manual-log-marker',
      marker: options.marker,
    };
    if (options.level === 'error') {
      log.error(options.marker, payload);
    } else {
      log.warn(options.marker, payload);
    }

    await flushDiagnosticLogs();
    await harness.close();
  } catch (error) {
    await harness.close().catch(() => {});
    throw error;
  }

  const sessionLog = await readOptionalText(sessionLogPath);
  const sessionMatched = sessionLog?.includes(options.marker) === true;
  const globalLogPath = resolveGlobalLogPath(resolvedHome);
  const globalLog = await readOptionalText(globalLogPath);
  const globalMatched = globalLog?.includes(options.marker) === true;

  process.stdout.write(`marker: ${options.marker}\n`);
  process.stdout.write(`sessionLog: ${sessionLogPath}\n`);
  process.stdout.write(`globalLog: ${globalLogPath}\n`);
  process.stdout.write(`sessionLogMatched: ${String(sessionMatched)}\n`);
  process.stdout.write(`globalLogMatched: ${String(globalMatched)}\n`);

  if (!sessionMatched) {
    process.stderr.write(
      [
        'error: marker was not found in the session log.',
        'Check that KIMI_LOG_LEVEL is not "off" and that the session id exists in this KIMI_CODE_HOME.',
        '',
      ].join('\n'),
    );
    process.exitCode = 1;
  }
}

function parseCliArgs(): Options {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        home: { type: 'string' },
        level: { type: 'string' },
        message: { type: 'string', short: 'm' },
        session: { type: 'string', short: 's' },
      },
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    process.exit(1);
  }

  const values = parsed.values as CliValues;
  if (values.help === true) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const positionals = parsed.positionals;
  const sessionId = values.session ?? positionals[0];
  if (sessionId === undefined || sessionId.trim() === '') {
    process.stderr.write(`error: --session is required\n\n${USAGE}`);
    process.exit(1);
  }
  if (positionals.length > (values.session === undefined ? 1 : 0)) {
    process.stderr.write(
      `error: unexpected positional arguments: ${positionals.join(' ')}\n\n${USAGE}`,
    );
    process.exit(1);
  }

  const level = values.level ?? 'error';
  if (level !== 'error' && level !== 'warn') {
    process.stderr.write(`error: --level must be "error" or "warn"\n\n${USAGE}`);
    process.exit(1);
  }

  return {
    sessionId,
    homeDir: values.home,
    level,
    marker: values.message ?? `MANUAL_SESSION_LOG_MARKER_${Date.now().toString(36)}`,
  };
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

try {
  await main();
} catch (error: unknown) {
  console.error(error);
  process.exitCode = 1;
}
