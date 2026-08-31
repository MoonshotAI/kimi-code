import { isAbortError, isUserCancellation, userCancellationReason } from '#/_base/utils/abort';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAgentProfileService } from '#/agent/profile/profile';
import { loadAgentsMdDetailed } from '#/agent/profile/context';
import { IAgentAgentsMdReminderService } from '#/agent/agentsMdReminder/agentsMdReminder';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { agentContextOf } from '#/agent/scopeContext/scopeContext';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ErrorCodes, Error2 } from '#/errors';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { emitAgentRunSpawned, mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import { ISessionSubagentService } from '#/session/subagent/subagent';

import { ISessionInitService } from './sessionInit';
import { DEFAULT_INIT_PROMPT, initCompletionReminder } from './profile/init';

const INIT_PROFILE_NAME = 'coder';
const INIT_PARENT_TOOL_CALL_ID = 'generate-agents-md';
const INIT_DESCRIPTION = 'Initialize AGENTS.md';

export class SessionInitService implements ISessionInitService {
  declare readonly _serviceBrand: undefined;

  private initRun: AbortController | undefined;

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ISessionContext private readonly sessionContext: ISessionContext,
  ) {}

  cancelInit(): void {
    this.initRun?.abort(userCancellationReason());
  }

  async generateAgentsMd(): Promise<void> {
    const main = this.agentLifecycle.handleOf(MAIN_AGENT_ID);
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

      const childContext = await this.agentLifecycle.create({
        binding: {
          profile: INIT_PROFILE_NAME,
          model: own.modelAlias,
          thinking: own.thinkingLevel,
        },
      });
      const child = this.agentLifecycle.handleOf(childContext.agentId)!;
      child.accessor.get(IAgentPermissionModeService).setMode(permissionMode);

      emitAgentRunSpawned(main, child.id, {
        profileName: INIT_PROFILE_NAME,
        parentToolCallId: INIT_PARENT_TOOL_CALL_ID,
        description: INIT_DESCRIPTION,
        runInBackground: false,
        model: own.modelAlias,
      });

      const run = await this.subagents.run(
        agentContextOf(child),
        { kind: 'prompt', prompt: DEFAULT_INIT_PROMPT },
        { signal: controller.signal },
      );
      await mirrorAgentRun(main, run, {
        profileName: INIT_PROFILE_NAME,
        prompt: DEFAULT_INIT_PROMPT,
        signal: controller.signal,
        cancel: (reason) => controller.abort(reason),
      });

      const { content: agentsMd, paths: agentsMdPaths } = await loadAgentsMdDetailed(
        { fs: this.fs, homeDir: this.env.homeDir },
        this.sessionContext.cwd,
        this.bootstrap.homeDir,
      );
      main.accessor
        .get(IAgentAgentsMdReminderService)
        .seedInjected(agentsMdPaths, this.sessionContext.cwd);
      main.accessor
        .get(IAgentReminderService)
        .notify(initCompletionReminder(agentsMd), { variant: 'init' });
      await main.accessor.get(IEventDispatcher).flush();
    } catch (error) {
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
