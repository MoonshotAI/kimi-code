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
import { FLOW_FLAG_ID, FLOWS_PROJECT_DIR } from './flow';
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
    const flowsDir = this.flowsDir();

    let names: string[];
    try {
      names = (await this.fs.readdir(flowsDir))
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
        const definition = parseFlowDefinition(await this.fs.readText(path));
        if (definition.id !== stem) {
          skipped.push({
            path,
            type: 'flow',
            reason: `declared id \`${definition.id}\` does not match the file name \`${stem}\``,
          });
          continue;
        }
        skills.push(this.toSkill(definition.id, definition.when, path, flowsDir));
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

  private toSkill(
    id: string,
    when: string | undefined,
    path: string,
    dir: string,
  ): SkillDefinition {
    const description =
      when === undefined || when.trim().length === 0
        ? `Run the \`${id}\` flow: a staged workflow with gated transitions.`
        : `Run the \`${id}\` flow. Use when: ${when.trim()}`;
    const content = [
      FLOW_SUPERVISOR_CONTRACT,
      '',
      `This activation is bound to the flow \`${id}\` (defined at ${FLOWS_PROJECT_DIR}/${id}.md): call FlowStart with flow: "${id}" and the user's task — do not ask which flow to run.`,
      '',
      "The user's input for this activation is the task: `$ARGUMENTS`",
      '',
      'If the input is empty, ask the user what this run should accomplish before starting.',
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
}
