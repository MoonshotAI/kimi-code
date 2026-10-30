import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IAgentReminderService } from '#/features/reminder/reminderService';

import { IAgentEnvironmentService } from './agentEnvironment';

export const ENVIRONMENT_ROSTER_REMINDER_VARIANT = 'environment_roster';

const SINGLE_ENVIRONMENT_DISCLOSURE = 'single';

const ROSTER_GUIDANCE =
  'Tools with an `environment` argument run in the environment you name; omit it to use the primary environment. ' +
  'Each environment has its own files, shell, and installed programs, and relative paths resolve against its working directory. ' +
  'A remote environment connects on its first use; if it cannot connect, the call fails instead of running elsewhere. ' +
  "The system prompt's working directory, AGENTS.md instructions, and skills describe the primary environment only; " +
  "read a project's AGENTS.md before changing files in another environment.";

export interface IAgentEnvironmentRosterService {
  readonly _serviceBrand: undefined;
}

export const IAgentEnvironmentRosterService: ServiceIdentifier<IAgentEnvironmentRosterService> =
  createDecorator<IAgentEnvironmentRosterService>('agentEnvironmentRosterService');

export class AgentEnvironmentRosterService extends Disposable implements IAgentEnvironmentRosterService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentReminderService reminder: IAgentReminderService,
    @IAgentEnvironmentService environment: IAgentEnvironmentService,
  ) {
    super();
    const resolvedCwds = new Map<string, string>();
    const secondaryCwd = (environmentId: string): string | undefined => {
      if (!resolvedCwds.has(environmentId) && environment.isAvailable([], environmentId)) {
        try {
          resolvedCwds.set(environmentId, environment.workspaceRoots(environmentId).workDir);
        } catch {
          return undefined;
        }
      }
      return resolvedCwds.get(environmentId);
    };
    this._register(
      reminder.register<string>(ENVIRONMENT_ROSTER_REMINDER_VARIANT, ({ lastInjection, lastDisclosure }) => {
        const targets = environment.targets();
        if (targets.length < 2) {
          if (lastInjection === undefined || lastDisclosure === SINGLE_ENVIRONMENT_DISCLOSURE) return undefined;
          return {
            content: `Only the primary environment \`${targets[0]!.environmentId}\` is available now. Tools no longer take an \`environment\` argument.`,
            disclosure: SINGLE_ENVIRONMENT_DISCLOSURE,
          };
        }
        const lines = targets.map((target) => {
          const label = target.primary ? `\`${target.environmentId}\` (primary)` : `\`${target.environmentId}\``;
          const cwd = target.primary ? environment.workspaceRoots().workDir : target.cwd ?? secondaryCwd(target.environmentId);
          return cwd === undefined
            ? `- ${label}: working directory resolved on first use`
            : `- ${label}: working directory ${cwd}`;
        });
        const disclosure = lines.join('\n');
        if (lastInjection !== undefined && lastDisclosure === disclosure) return undefined;
        return {
          content: ['Execution environments available in this session:', ...lines, ROSTER_GUIDANCE].join('\n'),
          disclosure,
        };
      }),
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentEnvironmentRosterService,
  AgentEnvironmentRosterService,
  ScopeActivation.OnScopeCreated,
  'agentEnvironmentBinding',
);
