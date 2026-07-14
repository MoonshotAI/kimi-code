/**
 * `sessionInit` domain (L6) — `ISessionInitService` implementation.
 *
 * Runs `/init` against the session's main agent: resolves `main` through
 * `agentLifecycle`, spawns a `coder` subagent bound to the main agent's own
 * model / thinking level / cwd (inheriting the main agent's permission mode),
 * drives one init-brief turn via `lifecycle.run`, and mirrors the run onto the
 * main agent's record stream (`emitAgentRunSpawned` + `mirrorAgentRun`) so the
 * UI shows the nested transcript and the `subagent.*` records fire. Once the
 * subagent finishes, reloads `AGENTS.md` through the `profile` context helper
 * (over the os `hostFs` + host home dir, with the `bootstrap` brand dir) and
 * appends an `init`-variant system reminder to the main agent via
 * `systemReminder`, then flushes the main agent's `wireRecord` log. Bound at
 * Session scope.
 *
 * Port of v1 `Session.generateAgentsMd()`. The main-agent lookup is a hard
 * precondition (`AGENT_NOT_FOUND`, like v1's `requireMainAgent`); only the
 * spawn / reload / reminder path is wrapped into `SESSION_INIT_FAILED`.
 * `cancelInit` aborts the in-flight run through the same `AbortSignal` the
 * run was launched with; user cancellations propagate unwrapped (never as
 * `SESSION_INIT_FAILED`) so callers can tell "aborted" from "failed".
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { isAbortError, isUserCancellation, userCancellationReason } from '#/_base/utils/abort';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAgentProfileService } from '#/agent/profile/profile';
import { loadAgentsMd } from '#/agent/profile/context';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentWireRecordService } from '#/agent/wireRecord/wireRecord';
import { ErrorCodes, Error2 } from '#/errors';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/mainAgent';
import { emitAgentRunSpawned, mirrorAgentRun } from '#/session/agentLifecycle/mirrorAgentRun';

import { ISessionInitService } from './sessionInit';
import { DEFAULT_INIT_PROMPT, initCompletionReminder } from './profile/init';

const INIT_PROFILE_NAME = 'coder';
const INIT_PARENT_TOOL_CALL_ID = 'generate-agents-md';
const INIT_DESCRIPTION = 'Initialize AGENTS.md';

export class SessionInitService implements ISessionInitService {
  declare readonly _serviceBrand: undefined;

  /** Abort handle of the in-flight `/init` run; `undefined` while idle. */
  private initRun: AbortController | undefined;

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {}

  cancelInit(): void {
    this.initRun?.abort(userCancellationReason());
  }

  async generateAgentsMd(): Promise<void> {
    const main = this.lifecycle.getHandle(MAIN_AGENT_ID);
    if (main === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, 'Main agent was not found');
    }

    const controller = new AbortController();
    this.initRun = controller;
    try {
      const own = main.accessor.get(IAgentProfileService).data();
      if (own.modelAlias === undefined) {
        throw new Error2(ErrorCodes.SESSION_INIT_FAILED, 'Main agent has no model bound');
      }
      const permissionMode = main.accessor.get(IAgentPermissionModeService).mode;

      const child = await this.lifecycle.create({
        binding: {
          profile: INIT_PROFILE_NAME,
          model: own.modelAlias,
          thinking: own.thinkingLevel,
          cwd: own.cwd,
        },
        permissionMode,
      });

      emitAgentRunSpawned(main, child.id, {
        profileName: INIT_PROFILE_NAME,
        parentToolCallId: INIT_PARENT_TOOL_CALL_ID,
        description: INIT_DESCRIPTION,
        runInBackground: false,
      });

      const run = await this.lifecycle.run(
        child.id,
        { kind: 'prompt', prompt: DEFAULT_INIT_PROMPT },
        { signal: controller.signal },
      );
      await mirrorAgentRun(main, run, {
        profileName: INIT_PROFILE_NAME,
        prompt: DEFAULT_INIT_PROMPT,
        signal: controller.signal,
        cancel: (reason) => controller.abort(reason),
      });

      const agentsMd = await loadAgentsMd(
        { fs: this.fs, homeDir: this.env.homeDir },
        own.cwd,
        this.bootstrap.homeDir,
      );
      main.accessor
        .get(IAgentSystemReminderService)
        .appendSystemReminder(initCompletionReminder(agentsMd), {
          kind: 'injection',
          variant: 'init',
        });
      await main.accessor.get(IAgentWireRecordService).flush();
    } catch (error) {
      // User cancellations (Ctrl+C → cancelInit) must surface as aborts, not
      // as init failures — the TUI resets quietly on `isAbortError`.
      if (isUserCancellation(error) || isAbortError(error)) {
        throw error;
      }
      if (error instanceof Error2 && error.code === ErrorCodes.SESSION_INIT_FAILED) {
        throw error;
      }
      throw new Error2(
        ErrorCodes.SESSION_INIT_FAILED,
        error instanceof Error ? error.message : 'Init failed',
        { cause: error },
      );
    } finally {
      if (this.initRun === controller) {
        this.initRun = undefined;
      }
    }
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionInitService,
  SessionInitService,
  InstantiationType.Eager,
  'session-init',
);
