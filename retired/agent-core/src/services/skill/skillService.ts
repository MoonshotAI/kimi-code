/**
 * `SkillService` — implementation of `ISkillService`.
 */

import { Disposable, InstantiationType, registerSingleton } from '../../di';
import { ErrorCodes, KimiError } from '../../errors';
import type { SkillDescriptor } from '@moonshot-ai/protocol';

import { ICoreProcessService } from '../coreProcess/coreProcess';
import { SessionNotFoundError } from '../session/session';
import {
  ISkillService,
  SkillNotActivatableError,
  SkillNotFoundError,
  toProtocolSkill,
} from './skill';

/** Matches the convention used elsewhere in services (prompt-service uses 'main'). */
const MAIN_AGENT_ID = 'main';

export class SkillService extends Disposable implements ISkillService {
  readonly _serviceBrand: undefined;

  constructor(@ICoreProcessService private readonly core: ICoreProcessService) {
    super();
  }

  async list(sessionId: string): Promise<readonly SkillDescriptor[]> {
    await this._requireLoadedSession(sessionId);
    const raw = await this.core.rpc.listSkills({ sessionId });
    return raw.map(toProtocolSkill);
  }

  async listForWorkDir(workDir: string): Promise<readonly SkillDescriptor[]> {
    const raw = await this.core.rpc.listWorkspaceSkills({ workDir });
    return raw.map(toProtocolSkill);
  }

  async activate(sessionId: string, skillName: string, args?: string): Promise<void> {
    await this._requireLoadedSession(sessionId);
    try {
      await this.core.rpc.activateSkill({
        sessionId,
        agentId: MAIN_AGENT_ID,
        name: skillName,
        args,
      });
    } catch (error) {
      if (error instanceof KimiError) {
        if (error.code === ErrorCodes.SKILL_NOT_FOUND || error.code === ErrorCodes.SKILL_NAME_EMPTY) {
          throw new SkillNotFoundError(skillName, error.message);
        }
        if (error.code === ErrorCodes.SKILL_TYPE_UNSUPPORTED) {
          throw new SkillNotActivatableError(skillName, error.message);
        }
      }
      throw error;
    }
  }

  /**
   * Resume a session, translating a not-found `KimiError` from the RPC layer
   * into `SessionNotFoundError` so route error handlers keep matching by class
   * identity. Replaces the prior `listSessions` + `resumeSession` pair,
   * avoiding a redundant `listSessions` round-trip.
   */
  private async _requireLoadedSession(sessionId: string): Promise<void> {
    try {
      await this.core.rpc.resumeSession({ sessionId });
    } catch (err) {
      if (err instanceof KimiError && err.code === ErrorCodes.SESSION_NOT_FOUND) {
        throw new SessionNotFoundError(sessionId);
      }
      throw err;
    }
  }
}

// Self-register under the global singleton registry. All ctor deps are
// `@I…`-injected; `staticArguments = []`. `supportsDelayedInstantiation =
// false` preserves current reverse-dispose semantics.
registerSingleton(ISkillService, SkillService, InstantiationType.Delayed);
