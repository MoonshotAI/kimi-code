import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import { TimeoutTimer } from '#/_base/utils/timer';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import {
  SKILL_SOURCE_PRIORITY,
  type ISkillSource,
  type SkillContribution,
} from '#/app/skillCatalog/skillSource';
import type { SkillDefinition, SkippedSkill } from '#/app/skillCatalog/types';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

import { FlowDefinitionParseError, parseFlowDefinition } from './definition';
import { FLOW_FLAG_ID, FLOWS_PROJECT_DIR, type FlowDefinition } from './flow';
import { FLOW_SUPERVISOR_CONTRACT } from './skill/skill';

export const FLOWS_SKILL_SOURCE_ID = 'flows';

/**
 * Catalog-name prefix of every projected flow skill (`flow:<id>`), keeping
 * flow commands in their own namespace so a flow can never shadow an
 * ordinary skill with the same id.
 */
export const FLOW_SKILL_NAME_PREFIX = 'flow:';

function joinWorkspacePath(root: string, relative: string): string {
  return `${root.replace(/[\\/]+$/, '')}/${relative}`;
}

/**
 * Canonical on-disk path of a project flow definition, as projected into the
 * skill catalog — automatic run starts verify an activation against it.
 */
export function flowDefinitionPath(workDir: string, flowId: string): string {
  return `${joinWorkspacePath(workDir, FLOWS_PROJECT_DIR)}/${flowId}.md`;
}

const WATCH_DEBOUNCE_MS = 200;

export interface IFlowsSkillSource extends ISkillSource {
  readonly _serviceBrand: undefined;
}

export const IFlowsSkillSource: ServiceIdentifier<IFlowsSkillSource> =
  createDecorator<IFlowsSkillSource>('flowsSkillSource');

/**
 * Projects every flow definition under `.kimi-code/flows/` into a
 * user-activatable skill of `type: 'flow'` (surfaced as the `/flow:<id>`
 * slash command), whose activation prompt binds the supervisor contract to
 * that one flow. Empty while the flow experimental flag is off.
 */
export class FlowsSkillSource extends Disposable implements IFlowsSkillSource {
  declare readonly _serviceBrand: undefined;

  readonly id = FLOWS_SKILL_SOURCE_ID;
  readonly priority = SKILL_SOURCE_PRIORITY.flows;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;
  private readonly watchDebounce = this._register(new TimeoutTimer());
  private readonly watchReady: Promise<void>;

  constructor(
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostFsWatchService fsWatch: IHostFsWatchService,
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IFlagService private readonly flags: IFlagService,
    @IConfigService config: IConfigService,
  ) {
    super();
    let flagWas = this.flags.enabled(FLOW_FLAG_ID);
    this._register(
      config.onDidChangeConfiguration(() => {
        const flagNow = this.flags.enabled(FLOW_FLAG_ID);
        if (flagNow === flagWas) return;
        flagWas = flagNow;
        this.onDidChangeEmitter.fire();
      }),
    );
    const root = this.workspace.cwd;
    const flowsDir = this.flowsDir();
    const handle = fsWatch.watch(root, {
      ignored: subtreeWatchFilter(root, [flowsDir]),
    });
    this.watchReady = Promise.resolve(handle.ready).then(
      () => undefined,
      () => undefined,
    );
    this._register(handle);
    this._register(
      handle.onDidChange(() => {
        this.watchDebounce.cancelAndSet(() => {
          this.onDidChangeEmitter.fire();
        }, WATCH_DEBOUNCE_MS);
      }),
    );
  }

  private flowsDir(): string {
    return joinWorkspacePath(this.workspace.cwd, FLOWS_PROJECT_DIR);
  }

  async load(): Promise<SkillContribution> {
    if (!this.flags.enabled(FLOW_FLAG_ID)) return { skills: [] };
    await this.watchReady;
    return discoverFlowSkills(this.fs, this.workspace.cwd);
  }
}

/**
 * Scan `<workDir>/.kimi-code/flows/` and project every valid definition into
 * a flow-typed skill. Shared by the workspace-scoped FlowsSkillSource and
 * kap-server's session-less workspace skills route — callers gate on the flow
 * flag themselves.
 */
export async function discoverFlowSkills(
  fs: IHostFileSystem,
  workDir: string,
): Promise<SkillContribution> {
  const flowsDir = joinWorkspacePath(workDir, FLOWS_PROJECT_DIR);

  let names: string[];
  try {
    names = (await fs.readdir(flowsDir))
      .filter((entry) => entry.isFile && entry.name.endsWith('.md'))
      .map((entry) => entry.name);
  } catch {
    return { skills: [], scannedRoots: [flowsDir] };
  }

  const skills: SkillDefinition[] = [];
  const skipped: SkippedSkill[] = [];
  for (const name of names.toSorted()) {
    const path = `${flowsDir}/${name}`;
    const stem = name.slice(0, -3);
    try {
      const definition = parseFlowDefinition(await fs.readText(path));
      if (definition.id !== stem) {
        skipped.push({
          path,
          type: 'flow',
          reason: `declared id \`${definition.id}\` does not match the file name \`${stem}\``,
        });
        continue;
      }
      skills.push(toFlowSkill(definition, path, flowsDir));
    } catch (error) {
      skipped.push({
        path,
        type: 'flow',
        reason:
          error instanceof FlowDefinitionParseError ? error.message : 'unreadable flow definition',
      });
    }
  }
  return { skills, skipped, scannedRoots: [flowsDir] };
}

function toFlowSkill(definition: FlowDefinition, path: string, dir: string): SkillDefinition {
  const id = definition.id;
  const when = definition.when;
  const description =
    when === undefined || when.trim().length === 0
      ? `Run the \`${id}\` flow: a staged workflow with gated transitions.`
      : `Run the \`${id}\` flow. Use when: ${when.trim()}`;
  const stages = definition.stages
    .map((stage, index) => {
      const notes = stage.notes === undefined ? '' : `\n   - Notes: ${stage.notes}`;
      return `${index + 1}. \`${stage.id}\` (gate: ${stage.gate})\n   - Objective: ${stage.objective}\n   - Completion: ${stage.completion}${notes}`;
    })
    .join('\n');
  const content = [
    FLOW_SUPERVISOR_CONTRACT,
    '',
    `The engine starts a run of the flow \`${id}\` with this activation when the task below is non-empty and no other run is active — when the current-stage reminder for \`${id}\` appears in your context, the run is live: do NOT call FlowStart again, do NOT read ${FLOWS_PROJECT_DIR}/${id}.md yourself, and do NOT mirror the stages into TodoList (the engine tracks stage progress and the UI shows it). The run's blueprint:`,
    '',
    stages,
    '',
    'Your first actions: restate the task and this blueprint to the user in your own words, clarify any completion criteria too vague to verify, then dispatch the first stage to a worker.',
    '',
    "The user's input for this activation is the task: `$ARGUMENTS`",
    '',
    'The task is the argument text above; when this activation is inline in a larger prompt, the surrounding prompt text becomes the task. If both are empty, the engine does NOT start the run: ask the user what this run should accomplish, then start it yourself with FlowStart (flow: "' +
      id +
      '", task: <the task>). Likewise, if no current-stage reminder appears in your context, the automatic start failed — recover by calling FlowStart yourself.',
  ].join('\n');
  return {
    name: `${FLOW_SKILL_NAME_PREFIX}${id}`,
    description,
    path,
    dir,
    content,
    metadata: {
      name: `${FLOW_SKILL_NAME_PREFIX}${id}`,
      description,
      type: 'flow',
      disableModelInvocation: true,
    },
    source: 'project',
    data: definition,
  };
}
