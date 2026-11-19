import { pathToFileURL } from 'node:url';

import { testEnv } from '#/fixtures/env';
import { osHomeEnv, type TestHome } from '#/fixtures/home';
import type { FetchStub } from '#/fixtures/network';
import type { NodeCommand } from '#/fixtures/process';
import { repoPath } from '#/fixtures/repo';

export const KIMI_SERVICE_URL = 'http://kimi-services.example.test';

export function kimiServiceStubs(): FetchStub[] {
  return ['client_configs', 'resource_configs'].map((name) => ({ method: 'POST', url: `${KIMI_SERVICE_URL}/${name}`, status: 404 }));
}

export function kimiCliCommand(): NodeCommand {
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
