import { isAbortError, isUserCancellation, userCancellationReason } from '#/_base/utils/abort';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { AgentProfile } from '#/features/profile/profileAgentRuntime';
import { loadAgentsMdDetailed } from '#/features/profile/profileContext';
import { ISessionAgentsMdReminderService } from '#/agent/agentsMdReminder/sessionAgentsMdReminderService';
import { ISessionPermissionModeService } from '#/session/permissionMode/sessionPermissionMode';
import { IAgentHostService } from '#/agent/host/agentHost';
import { AgentReminder } from '#/features/reminder/reminderAgentRuntime';
import { ErrorCodes, Error2 } from '#/errors';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
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
    @IAgentHostService private readonly hosts: IAgentHostService,
    @ISessionAgentsMdReminderService private readonly agentsMdReminder: ISessionAgentsMdReminderService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @ISessionPermissionModeService private readonly permissionModes: ISessionPermissionModeService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ISessionTokenCountingService private readonly tokenCounting?: ISessionTokenCountingService,
  ) {}

  cancelInit(): void {
    this.initRun?.abort(userCancellationReason());
  }

  async generateAgentsMd(): Promise<void> {
    const main = this.agentLifecycle.get(MAIN_AGENT_ID);
    if (main === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, 'Main agent was not found');
    }

    const controller = new AbortController();
    this.initRun = controller;
    try {
      const own = this.agentLifecycle.resolve(main, AgentProfile).data();
      if (own.modelAlias === undefined) {
        throw new Error2(ErrorCodes.SESSION_INIT_FAILED, 'Main agent has no model bound');
      }
      const bundle = this.hosts.of(main);
      const permissionMode = this.permissionModes.mode(main);

      const childContext = await this.agentLifecycle.create({
        binding: {
          profile: INIT_PROFILE_NAME,
          model: own.modelAlias,
          thinking: own.thinkingLevel,
        },
      });
      this.permissionModes.setMode(childContext, permissionMode);

      const mirrorServices = {
        agentLifecycle: this.agentLifecycle,
        subagents: this.subagents,
        tokenCounting: this.tokenCounting,
      };
      emitAgentRunSpawned(this.hosts, mirrorServices, main, childContext.agentId, {
        profileName: INIT_PROFILE_NAME,
        parentToolCallId: INIT_PARENT_TOOL_CALL_ID,
        description: INIT_DESCRIPTION,
        runInBackground: false,
        model: own.modelAlias,
      });

      const run = await this.subagents.run(
        childContext,
        { kind: 'prompt', prompt: DEFAULT_INIT_PROMPT },
        { signal: controller.signal },
      );
      await mirrorAgentRun(this.hosts, mirrorServices, main, run, {
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
      this.agentsMdReminder
        .of(main)
        .seedInjected(agentsMdPaths, this.sessionContext.cwd);
      this.agentLifecycle
        .resolve(main, AgentReminder)
        .notify(initCompletionReminder(agentsMd), { variant: 'init' });
      await bundle.dispatcher.flush();
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
