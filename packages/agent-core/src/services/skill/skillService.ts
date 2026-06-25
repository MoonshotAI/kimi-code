/**
 * `SkillService` — implementation of `ISkillService`.
 */

import { Disposable, InstantiationType, registerSingleton } from '../../di';
import { ErrorCodes, KimiError } from '../../errors';
import type { SkillDescriptor } from '@moonshot-ai/protocol';

import {
  IAgentRuntimeService,
} from '../agentRuntime/agentRuntime';
import type { ISessionRPCService } from '../agent/rpc/rpc';
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

  private readonly agentRuntimes: IAgentRuntimeService;

  constructor(@IAgentRuntimeService agentRuntimes: IAgentRuntimeService) {
    super();
    this.agentRuntimes = agentRuntimes;
  }

  async list(sessionId: string): Promise<readonly SkillDescriptor[]> {
    const rpc = await this.requireSessionRPC(sessionId);
    const raw = await rpc.listSkills({});
    return raw.map(toProtocolSkill);
  }

  async activate(sessionId: string, skillName: string, args?: string): Promise<void> {
    const rpc = await this.requireSessionRPC(sessionId);
    try {
      await rpc.activateSkill({
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

  private async requireSessionRPC(sessionId: string): Promise<ISessionRPCService> {
    const summary = await this.agentRuntimes.getSessionSummary(sessionId);
    if (summary === undefined) {
      throw new SessionNotFoundError(sessionId);
    }
    return this.agentRuntimes.requireSessionRPC(sessionId);
  }
}

// Self-register under the global singleton registry. All ctor deps are
// `@I…`-injected; `staticArguments = []`. `supportsDelayedInstantiation =
// false` preserves current reverse-dispose semantics.
registerSingleton(ISkillService, SkillService, InstantiationType.Delayed);
