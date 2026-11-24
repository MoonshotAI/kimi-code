import { pathToFileURL } from 'node:url';

import { TestkitError } from '#/errors';
import { testEnv } from '#/fixtures/env';
import { osHomeEnv, type TestHome } from '#/fixtures/home';
import type { FetchStub } from '#/fixtures/network';
import type { NodeCommand } from '#/fixtures/process';
import { repoPath } from '#/fixtures/repo';

export const KIMI_SERVICE_URL = 'http://kimi-services.example.test';

export const CLI_BUILD_ENV = 'TESTKIT_CLI_BUILD';

export type KimiCliBuild = 'source' | 'dist';

export function kimiServiceStubs(): FetchStub[] {
  return ['client_configs', 'resource_configs'].map((name) => ({ method: 'POST', url: `${KIMI_SERVICE_URL}/${name}`, status: 404 }));
}

export function kimiCliBuild(value: string | undefined = process.env[CLI_BUILD_ENV]): KimiCliBuild {
  if (value === undefined || value === '' || value === 'source') return 'source';
  if (value === 'dist') return 'dist';
  throw new TestkitError(`${CLI_BUILD_ENV} must be "source" or "dist", got ${JSON.stringify(value)}`);
}

export function kimiCliCommand(build: KimiCliBuild = kimiCliBuild()): NodeCommand {
  if (build === 'dist') return { entry: repoPath('apps', 'kimi-code', 'dist', 'main.mjs') };
  return {
    entry: repoPath('apps', 'kimi-code', 'src', 'main.ts'),
    imports: [import.meta.resolve('tsx'), pathToFileURL(repoPath('build', 'register-raw-text-loader.mjs')).href],
    env: {
      TSX_TSCONFIG_PATH: repoPath('apps', 'kimi-code', 'tsconfig.dev.json'),
      KIMI_CODE_DEV_SERVER: '1',
    },
  };
}

export function kimiCliEnv(home: TestHome, set: Readonly<Record<string, string | undefined>> = {}): Record<string, string> {
  return testEnv({
    set: {
      ...osHomeEnv(home.home),
      KIMI_CODE_HOME: home.dataDir,
      KIMI_CODE_BASE_URL: KIMI_SERVICE_URL,
      KIMI_CODE_NO_AUTO_UPDATE: '1',
      KIMI_CODE_TRUST_WORKSPACE: '1',
      ...set,
    },
  });
}
