import { homedir } from 'node:os';
import { join } from 'node:path';

import { LOCAL_ENVIRONMENT_ID, type Environment } from './environment';

export function isRemoteEnvironment(environment: Environment | undefined): environment is Environment {
  return environment !== undefined && environment.identity.environmentId !== LOCAL_ENVIRONMENT_ID;
}

export function getShareBinRgPath(): string {
  const override = process.env['KIMI_CODE_HOME'];
  if (override !== undefined && override !== '') return join(override, 'bin', rgBinaryName());
  return join(homedir(), '.kimi-code', 'bin', rgBinaryName());
}

export function shareBinRgPath(environment: Environment | undefined): string {
  if (isRemoteEnvironment(environment)) {
    const homeDir = environment.host?.homeDir;
    if (homeDir !== undefined) return `${homeDir}/.kimi-code/bin/rg`;
  }
  return getShareBinRgPath();
}

function rgBinaryName(): string {
  return process.platform === 'win32' ? 'rg.exe' : 'rg';
}
