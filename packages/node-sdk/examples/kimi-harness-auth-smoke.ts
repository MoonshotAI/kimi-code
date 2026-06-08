import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createKimiHarness, type KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { smokeIdentityFromEnv, runPromptToEnd } from './runtime-smoke-helpers';

const MANAGED_KIMI_CODE_PROVIDER = 'managed:kimi-code';

async function main(): Promise<void> {
  const explicitHomeDir = process.env['KIMI_SDK_AUTH_SMOKE_HOME'];
  const explicitWorkDir = process.env['KIMI_SDK_AUTH_SMOKE_WORK_DIR'];
  const homeDir = explicitHomeDir ?? (await mkdtemp(join(tmpdir(), 'kimi-sdk-auth-smoke-home-')));
  const workDir = explicitWorkDir ?? (await mkdtemp(join(tmpdir(), 'kimi-sdk-auth-smoke-work-')));
  const keepToken = shouldKeepToken(explicitHomeDir !== undefined);
  const forceLogin = process.env['KIMI_SDK_AUTH_SMOKE_FORCE_LOGIN'] === '1';
  const prompt =
    process.env['KIMI_SDK_AUTH_SMOKE_PROMPT'] ?? 'Reply with exactly: Kimi SDK auth smoke ok';
  const harness = createKimiHarness({ homeDir, identity: smokeIdentityFromEnv() });

  process.stdout.write(`home: ${homeDir}\n`);
  process.stdout.write(`workDir: ${workDir}\n`);

  try {
    if (forceLogin) {
      await harness.auth.logout(MANAGED_KIMI_CODE_PROVIDER);
      process.stdout.write('cleared existing smoke token\n');
    }

    const login = await harness.auth.login(undefined, { onDeviceCode: printDeviceCode });
    const config = await harness.getConfig({ reload: true });
    const status = await harness.auth.status(MANAGED_KIMI_CODE_PROVIDER);
    const usage = await harness.auth.getManagedUsage(MANAGED_KIMI_CODE_PROVIDER);

    if (login.defaultModel === undefined || config.defaultModel === undefined) {
      throw new Error('login did not provision a default model');
    }
    if (status.providers[0]?.hasToken !== true) {
      throw new Error('status did not report a stored token after login');
    }
    if (config.providers[MANAGED_KIMI_CODE_PROVIDER]?.oauth?.key !== 'oauth/kimi-code') {
      throw new Error('managed provider oauth config was not written');
    }

    process.stdout.write(`provider: ${login.providerName}\n`);
    process.stdout.write(`default model: ${config.defaultModel}\n`);
    printUsage(usage);

    const session = await harness.createSession({
      workDir,
      model: config.defaultModel,
    });
    const ended = await runPromptToEnd(session, prompt);
    if (ended.type !== 'turn.ended' || ended.reason !== 'completed') {
      throw new Error(`Expected completed turn, got ${ended.type}`);
    }

    process.stdout.write(`auth smoke passed: ${session.id}\n`);
  } finally {
    if (!keepToken) {
      await harness.auth.logout(MANAGED_KIMI_CODE_PROVIDER).catch(() => {});
    }
    await harness.close();
    if (explicitHomeDir === undefined && !keepToken) {
      await rm(homeDir, { recursive: true, force: true });
    }
    if (explicitWorkDir === undefined) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

function printDeviceCode(auth: {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresIn: number | null;
}): void {
  process.stdout.write(
    [
      'Complete Kimi OAuth device login:',
      `  URL: ${auth.verificationUriComplete || auth.verificationUri}`,
      `  Code: ${auth.userCode}`,
      auth.expiresIn === null ? undefined : `  Expires in: ${String(auth.expiresIn)}s`,
      '',
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n'),
  );
}

function printUsage(usage: Awaited<ReturnType<KimiHarness['auth']['getManagedUsage']>>): void {
  if (usage.kind === 'error') {
    process.stderr.write(`usage request returned: ${usage.message}\n`);
    return;
  }
  const summary = usage.summary;
  if (summary === null) {
    process.stdout.write(`usage: no summary, limits=${String(usage.limits.length)}\n`);
    return;
  }
  process.stdout.write(
    `usage: ${summary.label} ${String(summary.used)}/${String(summary.limit)}\n`,
  );
}

function shouldKeepToken(hasExplicitHomeDir: boolean): boolean {
  const value = process.env['KIMI_SDK_AUTH_SMOKE_KEEP_TOKEN'];
  if (value !== undefined) return value === '1' || value === 'true';
  return hasExplicitHomeDir;
}

try {
  await main();
} catch (error: unknown) {
  console.error(error);
  process.exitCode = 1;
}
