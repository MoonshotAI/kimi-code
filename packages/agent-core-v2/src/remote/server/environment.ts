import { tmpdir } from 'node:os';

import { probeHostEnvironmentFromNode } from '#/_base/execEnv/environmentProbe';
import { applyLoginShellPathFromNode } from '#/_base/execEnv/loginShellPath';

import type { RemoteEnvironmentInfo } from '#/remote/protocol/methods';

export async function probeExecutorEnvironment(): Promise<RemoteEnvironmentInfo> {
  const [info] = await Promise.all([
    probeHostEnvironmentFromNode(),
    applyLoginShellPathFromNode(),
  ]);
  return { ...info, cwd: process.cwd(), tempDir: tmpdir() };
}
