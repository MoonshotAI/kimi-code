import { tmpdir } from 'node:os';

import { probeHostEnvironmentFromNode } from '@moonshot-ai/agent-core-v2/_base/execEnv/environmentProbe';
import { applyLoginShellPathFromNode } from '@moonshot-ai/agent-core-v2/_base/execEnv/loginShellPath';

import type { RemoteEnvironmentInfo } from '#/protocol/methods';

// The login-shell PATH probe mutates process.env.PATH so spawned children
// inherit a usable baseline even under a stripped sshd/docker exec environment.
export async function probeExecutorEnvironment(): Promise<RemoteEnvironmentInfo> {
  const [info] = await Promise.all([
    probeHostEnvironmentFromNode(),
    applyLoginShellPathFromNode(),
  ]);
  return { ...info, cwd: process.cwd(), tempDir: tmpdir() };
}
