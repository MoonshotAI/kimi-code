/**
 * `SkillService` — implementation of `ISkillService`.
 */

import { Disposable, InstantiationType, registerSingleton } from '../../_base/di';
import { ErrorCodes, KimiError } from '../../errors';
import type { SkillDescriptor } from '@moonshot-ai/protocol';

import type { CoreRPC } from '../../rpc';
import { ICoreRuntime } from '#/coreProcess';
import { SessionNotFoundError } from '#/session';
import {
  ISkillService,
  SkillNotActivatableError,
  SkillNotFoundError,
  toProtocolSkill,
} from './skill';

/** Matches the convention used elsewhere in services (prompt-service uses 'main'). */
const MAIN_AGENT_ID = 'main';

/**
 * Narrow in-process CoreAPI accessor supplied by the concrete
 * `CoreProcessService` (the sole production `ICoreRuntime`). Routed
 * through a structural cast so the public `ICoreRuntime` facade — and
 * the many test doubles that implement it across the suite — stay unchanged.
 * The daemon-side adapter always provides `getCoreApi()`; see
 * `CoreProcessService.getCoreApi` for the zero-serialization rationale.
 */
type InProcessCoreApi = { getCoreApi(): CoreRPC };

export class SkillService extends Disposable implements ISkillService {
  readonly _serviceBrand: undefined;

  constructor(@ICoreRuntime private readonly core: ICoreRuntime) {
    super();
  }

  async list(sessionId: string): Promise<readonly SkillDescriptor[]> {
    await this._requireLoadedSession(sessionId);
    const raw = await this.coreApi().listSkills({ sessionId });
    return raw.map(toProtocolSkill);
  }

  async activate(sessionId: string, skillName: string, args?: string): Promise<void> {
    await this._requireLoadedSession(sessionId);
    try {
      await this.coreApi().activateSkill({
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
   * Validate the session exists, then make sure it is loaded into the active
   * session map (idempotent when already loaded) so the SessionAPI dispatch
   * below cannot miss after a daemon restart. Same pattern as
   * `PromptService.submit` / `SessionService.undo`.
   */
  private async _requireLoadedSession(sessionId: string): Promise<void> {
    const all = await this.coreApi().listSessions({});
    if (!all.some((s) => s.id === sessionId)) {
      throw new SessionNotFoundError(sessionId);
    }
    await this.coreApi().resumeSession({ sessionId });
  }

  /**
   * In-process CoreAPI handle — the same methods as `this.core.rpc` but
   * dispatched directly on the in-process `KimiCore`, skipping the
   * `createRPC` JSON serialize/deserialize hop. Method signatures and return
   * shapes are identical to the `rpc` proxy; only the serialization is
   * removed. The cast is localized here so every call site above reads
   * `this.coreApi().<method>(...)`.
   */
  private coreApi(): CoreRPC {
    return (this.core as unknown as InProcessCoreApi).getCoreApi();
  }
}

// Self-register under the global singleton registry. All ctor deps are
// `@I…`-injected; `staticArguments = []`. `supportsDelayedInstantiation =
// false` preserves current reverse-dispose semantics.
registerSingleton(ISkillService, SkillService, InstantiationType.Delayed);
