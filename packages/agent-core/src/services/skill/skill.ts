/**
 * `ISkillService` — daemon-facing skill surface.
 *
 * Wraps `ICoreProcessService.rpc.{listSkills, activateSkill}` and adapts the
 * agent-core `SkillSummary` shape (camelCase) into the wire `SkillDescriptor`
 * (snake_case). The adapter helper (`toProtocolSkill`) is co-located here.
 *
 * **CoreAPI surface used**:
 *   - `core.rpc.listSkills({sessionId}) => readonly SkillSummary[]`
 *     (packages/agent-core/src/rpc/core-api.ts, SessionAPI) — session-scoped.
 *   - `core.rpc.listWorkspaceSkills({workDir}) => Promise<readonly SkillSummary[]>`
 *     (CoreAPI) — workspace-cwd-scoped, no session required; mirrors the roots
 *     a new session would scan.
 *   - `core.rpc.activateSkill({sessionId, agentId, name, args})`
 *     (AgentAPI) — renders the skill prompt and starts a turn with a
 *     `skill_activation` origin (trigger 'user-slash'), mirroring the TUI's
 *     slash-command path. It does NOT go through `IPromptService`, so no
 *     `prompt_id` is minted; clients observe progress via `skill.activated` +
 *     `turn.*` events on the WS stream.
 *
 * **Scoping**: the skill registry is per-session (project skills are
 * discovered from the session cwd). `list`/`activate` are session-scoped, so
 * the impl resumes the session before dispatching — sessions that exist on
 * disk but are not in the active map after a daemon restart still resolve.
 * `listForWorkDir` is workspace-cwd-scoped instead: it scans the same roots a
 * new session would, without creating or resuming one.
 *
 * **Error model**:
 *   - `SkillSessionNotFoundError` is NOT defined here — the impl throws the
 *     shared `SessionNotFoundError` (→ 40401).
 *   - `SkillNotFoundError` (→ 40415) when agent-core reports `skill.not_found`.
 *   - `SkillNotActivatableError` (→ 40912) when agent-core reports
 *     `skill.type_unsupported` (e.g. `reference`-type skills).
 *
 * **Anti-corruption**: imports `@moonshot-ai/agent-core` only for the
 * `createDecorator` value and the `SkillSummary` type.
 */

import { createDecorator } from '../../di';
import type { SkillSummary as AgentCoreSkillSummary } from '../../rpc';
import type { SkillDescriptor } from '@moonshot-ai/protocol';

// ---------------------------------------------------------------------------
// Adapter helpers
// ---------------------------------------------------------------------------

export function toProtocolSkill(info: AgentCoreSkillSummary): SkillDescriptor {
  const base: SkillDescriptor = {
    name: info.name,
    description: info.description,
    path: info.path,
    source: info.source,
  };
  return {
    ...base,
    ...(info.type !== undefined ? { type: info.type } : {}),
    ...(info.disableModelInvocation !== undefined
      ? { disable_model_invocation: info.disableModelInvocation }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Interface + errors
// ---------------------------------------------------------------------------

export interface ISkillService {
  readonly _serviceBrand: undefined;

  /**
   * Return the skills available to a session (project + user + extra +
   * builtin). Throws `SessionNotFoundError` (→ 40401) for unknown sessions.
   */
  list(sessionId: string): Promise<readonly SkillDescriptor[]>;

  /**
   * Return the skills available for a workspace working directory (project +
   * user + extra + builtin) without requiring a session. Used to populate the
   * composer skill menu before a session is created.
   */
  listForWorkDir(workDir: string): Promise<readonly SkillDescriptor[]>;

  /**
   * Activate a skill by name in a session — the REST analogue of typing
   * `/<skill> <args>`. Starts a turn on the session's main agent. Throws
   * `SessionNotFoundError` (→ 40401), `SkillNotFoundError` (→ 40415) or
   * `SkillNotActivatableError` (→ 40912).
   */
  activate(sessionId: string, skillName: string, args?: string): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ISkillService = createDecorator<ISkillService>('skillService');

/**
 * Sentinel — daemon's route layer catches this and maps to envelope `code:
 * 40415 skill.not_found`. Other thrown errors fall through to
 * `installErrorHandler` (→ 50001).
 */
export class SkillNotFoundError extends Error {
  readonly skillName: string;
  constructor(skillName: string, message?: string) {
    super(message ?? `skill ${skillName} does not exist`);
    this.name = 'SkillNotFoundError';
    this.skillName = skillName;
  }
}

/**
 * Sentinel — maps to envelope `code: 40912 skill.not_activatable`. Raised when
 * the skill exists but its type cannot be user-activated (e.g. `reference`).
 */
export class SkillNotActivatableError extends Error {
  readonly skillName: string;
  constructor(skillName: string, message?: string) {
    super(message ?? `skill ${skillName} cannot be activated`);
    this.name = 'SkillNotActivatableError';
    this.skillName = skillName;
  }
}

void ISkillService;
