import { isAbsolute } from 'node:path';

import { isWindowsAbsolutePath } from '#/_base/utils/paths';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { AGENT_WIRE_RECORD_KEY, isWireRecord } from '#/wire/record';
import { agentScopeOf } from '#/workspace/sessionLifecycle/internal/addressing';

export function isAbsoluteLocalCwd(cwd: string): boolean {
  return process.platform === 'win32' ? isWindowsAbsolutePath(cwd) : isAbsolute(cwd);
}

export function hasRelativeLocalWorkdir(environmentId?: string, cwd?: string): boolean {
  return (environmentId ?? LOCAL_ENVIRONMENT_ID) === LOCAL_ENVIRONMENT_ID && cwd !== undefined && !isAbsoluteLocalCwd(cwd);
}

export async function readLegacyLocalWorkdir(logs: IAppendLogStore, sessionScope: string): Promise<string | undefined> {
  const records = logs.read<unknown>(agentScopeOf(sessionScope, MAIN_AGENT_ID), AGENT_WIRE_RECORD_KEY);
  let sawBinding = false;
  for await (const record of records) {
    if (!isWireRecord(record) || record['agentId'] !== MAIN_AGENT_ID) continue;
    if (record.type === 'environment.set_binding') {
      if (sawBinding || record['environmentId'] !== LOCAL_ENVIRONMENT_ID) return undefined;
      sawBinding = true;
      continue;
    }
    if (record.type !== 'profile.bind') continue;
    const disclosure = record['environmentDisclosure'];
    if (typeof disclosure !== 'object' || disclosure === null || !('cwd' in disclosure)) return undefined;
    return typeof disclosure.cwd === 'string' && isAbsoluteLocalCwd(disclosure.cwd) ? disclosure.cwd : undefined;
  }
  return undefined;
}
