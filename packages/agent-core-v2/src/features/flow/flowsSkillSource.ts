import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import { TimeoutTimer } from '#/_base/utils/timer';
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

  constructor(
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostFsWatchService fsWatch: IHostFsWatchService,
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IFlagService private readonly flags: IFlagService,
  ) {
    super();
    const root = this.workspace.cwd;
    const flowsDir = this.flowsDir();
    const handle = fsWatch.watch(root, {
      ignored: subtreeWatchFilter(root, [flowsDir]),
    });
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
    return `${this.workspace.cwd}/${FLOWS_PROJECT_DIR}`;
  }

  async load(): Promise<SkillContribution> {
    if (!this.flags.enabled(FLOW_FLAG_ID)) return { skills: [] };
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
  const flowsDir = `${workDir}/${FLOWS_PROJECT_DIR}`;

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
    `This activation already started a run of the flow \`${id}\` — the engine starts it for you, so do NOT call FlowStart, do NOT read ${FLOWS_PROJECT_DIR}/${id}.md yourself, and do NOT mirror the stages into TodoList (the engine tracks stage progress and the UI shows it). The run's blueprint:`,
    '',
    stages,
    '',
    'Your first actions: restate the task and this blueprint to the user in your own words, clarify any completion criteria too vague to verify, then dispatch the first stage to a worker.',
    '',
    "The user's input for this activation is the task: `$ARGUMENTS`",
    '',
    'If the task is empty, ask the user what this run should accomplish before dispatching anything. If no current-stage reminder appears in your context (the automatic start failed), recover by calling FlowStart with flow: "' +
      id +
      '" yourself.',
  ].join('\n');
  return {
    name: id,
    description,
    path,
    dir,
    content,
    metadata: {
      name: id,
      description,
      type: 'flow',
      disableModelInvocation: true,
    },
    source: 'project',
  };
}
