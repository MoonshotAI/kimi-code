import { describe, expect, it } from 'vitest';

import type { CoreRPC, ResumeSessionResult, SessionSummary } from '../../src';
import { ErrorCodes, KimiError } from '../../src/errors';
import {
  type ICoreProcessService,
  SkillNotActivatableError,
  SkillService,
} from '../../src/services';

function fakeSession(id: string): SessionSummary {
  return {
    id,
    workDir: '/tmp/workspace',
    sessionDir: `/tmp/session-${id}`,
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeCore(activateError: KimiError): ICoreProcessService {
  const rpc: Partial<CoreRPC> = {
    listSessions: async () => [fakeSession('session-1')],
    resumeSession: async () =>
      ({ ...fakeSession('session-1'), sessionMetadata: {}, agents: {} }) as ResumeSessionResult,
    activateSkill: async () => {
      throw activateError;
    },
  };

  return {
    rpc: rpc as CoreRPC,
    ready: async () => undefined,
    dispose: () => undefined,
    _serviceBrand: undefined,
  };
}

describe('SkillService.activate', () => {
  it('maps a disabled skill to SkillNotActivatableError', async () => {
    const service = new SkillService(
      makeCore(new KimiError(ErrorCodes.SKILL_DISABLED, 'skill is disabled')),
    );

    await expect(service.activate('session-1', 'disabled-skill')).rejects.toBeInstanceOf(
      SkillNotActivatableError,
    );
  });
});
