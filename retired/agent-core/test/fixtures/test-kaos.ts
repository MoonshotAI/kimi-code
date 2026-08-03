import { LocalKaos, type Environment } from '@moonshot-ai/kaos';

export const TEST_OS_ENV: Environment = {
  osKind: 'Linux',
  osArch: 'x86_64',
  osVersion: 'test',
  shellName: 'bash',
  shellPath: '/bin/bash',
};

// `LocalKaos`'s constructor is `private` at the TS level only — at runtime
// it's just a function. Skip the singleton/async detection path and build a
// fresh instance with a stub `osEnv` so test helpers can hand a real Kaos
// directly to `RuntimeConfig`.
type LocalKaosCtor = new (osEnv: Environment) => LocalKaos;
export const testKaos: LocalKaos = new (LocalKaos as unknown as LocalKaosCtor)(TEST_OS_ENV);
