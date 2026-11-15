import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type {
  AgentTool,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import {
  ARTEX_TASK_SCOPE_KINDS,
  type ArtexTaskScopeKind,
} from '#/features/artex/protocol/index';
import { IArtexWorkStoreProvider } from '#/features/artex/store/artexWorkStoreProvider';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';

import { ARTEX_INACTIVE_RESULT, artexJson, openActiveWork } from '../toolSupport';
import DESCRIPTION from './add_task_scope.md?raw';

const ScopeEntrySchema = z.object({
  kind: z.string(),
  value: z.string(),
});

export const AddTaskScopeInputSchema = z.object({
  entries: z.array(ScopeEntrySchema).optional(),
  kind: z.string().optional(),
  value: z.string().optional(),
  reason: z.string().optional(),
});

export type AddTaskScopeInput = z.infer<typeof AddTaskScopeInputSchema>;
type ScopeEntry = z.infer<typeof ScopeEntrySchema>;

const PARAMETERS = toInputJsonSchema(AddTaskScopeInputSchema);

export const IArtexAddTaskScopeTool: ServiceIdentifier<AgentTool<AddTaskScopeInput>> =
  createDecorator<AgentTool<AddTaskScopeInput>>('artexAddTaskScopeTool');

function isTaskScopeKind(value: string): value is ArtexTaskScopeKind {
  return (ARTEX_TASK_SCOPE_KINDS as readonly string[]).includes(value);
}

export class ArtexAddTaskScopeTool implements AgentTool<AddTaskScopeInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'add_task_scope' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexWorkStoreProvider private readonly provider: IArtexWorkStoreProvider,
  ) {}

  resolveExecution(args: AddTaskScopeInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Adding ARTEX task scope',
      execute: () => this.execute(args),
    };
  }

  private async execute(args: AddTaskScopeInput): Promise<ExecutableToolResult> {
    const handle = await openActiveWork(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const { store, taskId } = handle;
    const items: ScopeEntry[] =
      args.entries !== undefined && args.entries.length > 0
        ? args.entries
        : [{ kind: args.kind ?? '', value: args.value ?? '' }];
    const added: unknown[] = [];
    const errors: Record<string, string> = {};
    for (let index = 0; index < items.length; index += 1) {
      const entry = items[index]!;
      const kind = entry.kind.trim();
      if (!isTaskScopeKind(kind)) {
        errors[String(index)] = `unknown scope kind: ${kind}`;
        continue;
      }
      try {
        const scope = await store.addTaskScope(taskId, kind, entry.value, args.reason ?? '', 'agent');
        added.push({
          kind: scope.kind,
          domain: scope.domain,
          net: scope.net,
          value: scope.value,
          company_id: scope.companyId,
        });
      } catch (error) {
        errors[String(index)] = error instanceof Error ? error.message : String(error);
      }
    }
    const out: Record<string, unknown> = { added };
    if (Object.keys(errors).length > 0) out['errors'] = errors;
    return { output: artexJson(out) };
  }
}
