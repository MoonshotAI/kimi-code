import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { LOCAL_ENVIRONMENT_ID, type EnvironmentAccess, type EnvironmentTarget } from '#/environment/environment';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { ISessionEnvironmentMounts, type EnvironmentMount } from '#/session/environmentMounts/environmentMounts';

import { IAgentEnvironmentService } from './agentEnvironment';

export const ENVIRONMENT_ROSTER_REMINDER_VARIANT = 'environment_roster';

const SINGLE_ENVIRONMENT_DISCLOSURE = 'single';

type RosterDisclosure = typeof SINGLE_ENVIRONMENT_DISCLOSURE | Readonly<Record<string, string>>;

interface RosterEntry {
  readonly environmentId: string;
  readonly text: string;
  readonly listsAgentsMd: boolean;
}

const ROSTER_GUIDANCE =
  'Tools with an `environment` argument run in the environment you name; omit it to use the primary environment. ' +
  'Each environment has its own files, shell, and installed programs, and relative paths resolve against its working directory. ' +
  'A remote environment connects on its first use; if it cannot connect, the call fails instead of running elsewhere. ' +
  "The system prompt's working directory, AGENTS.md instructions, and skills describe the primary environment. " +
  'Once another environment connects, the AGENTS.md files found there are listed under it; read them before changing files in that environment. ' +
  'Skills found in another environment are named `<skill>@<environment>`.';

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
    @ISessionEnvironmentMounts mounts: ISessionEnvironmentMounts,
  ) {
    super();
    const mounted = new Map<string, { readonly target: EnvironmentTarget; readonly cwd: string; readonly mount: Promise<EnvironmentMount> }>();
    const connectedCwd = (handle: EnvironmentAccess): string | undefined => {
      try {
        return handle.workspaceRoots().workDir;
      } catch {
        return undefined;
      }
    };
    const entry = (target: EnvironmentTarget, lines: readonly string[], listsAgentsMd = false): RosterEntry => ({
      environmentId: target.environmentId,
      text: lines.join('\n'),
      listsAgentsMd,
    });
    const describe = async (target: EnvironmentTarget): Promise<RosterEntry> => {
      const label = `\`${target.environmentId}\``;
      const primaryAdditionalDirs = target.primary && target.environmentId !== LOCAL_ENVIRONMENT_ID ? (target.additionalDirs ?? []) : [];
      if (target.primary && primaryAdditionalDirs.length === 0) {
        return entry(target, [`- ${label} (primary): working directory ${environment.workspaceRoots().workDir}`]);
      }
      let pending = mounted.get(target.environmentId);
      const handle = environment.handle(target);
      if (pending === undefined && handle.isAvailable()) {
        const cwd = connectedCwd(handle);
        if (cwd !== undefined) {
          pending = { target, cwd, mount: mounts.mount(target.environmentId, cwd, target.additionalDirs) };
          mounted.set(target.environmentId, pending);
        }
      }
      const role = target.primary ? ' (primary)' : '';
      if (pending === undefined) {
        return entry(target, [
          `- ${label}${role}: working directory ${target.cwd}; not connected yet`,
          ...primaryAdditionalDirs.map((path) => `  - additional directory ${path}; not connected yet`),
        ]);
      }
      const mount = await pending.mount;
      if (mount.status === 'failed') {
        return entry(target, [`- ${label}${role}: working directory ${pending.cwd}; its AGENTS.md files and skills could not be loaded: ${mount.error}`]);
      }
      return entry(
        target,
        [
          `- ${label}${role}: working directory ${pending.cwd}`,
          ...primaryAdditionalDirs.map((path) => `  - additional directory ${path}`),
          ...mount.agentsMdPaths.map((path) => `  - AGENTS.md: ${path}`),
        ],
        mount.agentsMdPaths.length > 0,
      );
    };
    this._register(
      reminder.register<RosterDisclosure>(ENVIRONMENT_ROSTER_REMINDER_VARIANT, async ({ lastInjection, lastDisclosure }) => {
        const targets = environment.targets();
        for (const [environmentId, pending] of mounted) {
          const current = targets.find((target) => target.environmentId === environmentId && target.cwd === pending.target.cwd);
          if (current !== undefined && JSON.stringify(current.additionalDirs ?? []) === JSON.stringify(pending.target.additionalDirs ?? [])) continue;
          mounted.delete(environmentId);
          mounts.unmount(environmentId, pending.mount);
        }
        if (targets.length < 2 && (targets[0]?.environmentId === LOCAL_ENVIRONMENT_ID || (targets[0]?.additionalDirs?.length ?? 0) === 0)) {
          if (lastInjection === undefined || lastDisclosure === SINGLE_ENVIRONMENT_DISCLOSURE) return undefined;
          return {
            content: `Only the primary environment \`${targets[0]!.environmentId}\` is available now. Tools no longer take an \`environment\` argument.`,
            disclosure: SINGLE_ENVIRONMENT_DISCLOSURE,
          };
        }
        const entries = await Promise.all(targets.map(describe));
        const disclosure = Object.fromEntries(entries.map((current) => [current.environmentId, current.text]));
        const previous = lastInjection !== undefined && typeof lastDisclosure === 'object' ? lastDisclosure : undefined;
        if (previous === undefined) {
          return {
            content: ['Execution environments available in this session:', ...entries.map((current) => current.text), ROSTER_GUIDANCE].join('\n'),
            disclosure,
          };
        }
        const changed = entries.filter((current) => previous[current.environmentId] !== current.text);
        const removed = Object.keys(previous).filter((environmentId) => disclosure[environmentId] === undefined);
        if (changed.length === 0 && removed.length === 0) return undefined;
        return {
          content: [
            'Execution environment updates:',
            ...changed.map((current) => current.text),
            ...removed.map((environmentId) => `- \`${environmentId}\` is no longer available.`),
            ...(changed.some((current) => current.listsAgentsMd)
              ? ['Read the AGENTS.md files listed above before changing files in that environment.']
              : []),
          ].join('\n'),
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
