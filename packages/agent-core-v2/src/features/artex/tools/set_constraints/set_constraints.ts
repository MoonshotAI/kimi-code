import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import type {
  AgentTool,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import type { ArtexTaskConstraintKind } from '#/features/artex/protocol/index';
import type { ArtexConstraintInput } from '#/features/artex/store/artexWorkStore';
import { IArtexWorkStoreProvider } from '#/features/artex/store/artexWorkStoreProvider';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';

import { ARTEX_INACTIVE_RESULT, artexErr, artexJson, openActiveWork } from '../toolSupport';
import DESCRIPTION from './set_constraints.md?raw';

const ConstraintItemSchema = z.object({
  text: z.string().optional(),
  type: z.enum(['allow', 'deny']).optional(),
});

export const SetConstraintsInputSchema = z.object({
  constraints: z.array(ConstraintItemSchema).optional(),
  text: z.string().optional(),
  type: z.enum(['allow', 'deny']).optional(),
});

export type SetConstraintsInput = z.infer<typeof SetConstraintsInputSchema>;
type ConstraintItem = z.infer<typeof ConstraintItemSchema>;

const PARAMETERS = toInputJsonSchema(SetConstraintsInputSchema);

export const IArtexSetConstraintsTool: ServiceIdentifier<AgentTool<SetConstraintsInput>> =
  createDecorator<AgentTool<SetConstraintsInput>>('artexSetConstraintsTool');

function constraintKind(type: 'allow' | 'deny' | undefined): ArtexTaskConstraintKind {
  return type === 'allow' ? 'allow' : 'deny';
}

export class ArtexSetConstraintsTool implements AgentTool<SetConstraintsInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'set_constraints' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  private readonly origin: string;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexWorkStoreProvider private readonly provider: IArtexWorkStoreProvider,
    @IAgentScopeContext scope: IAgentScopeContext,
  ) {
    this.origin = scope.agentId;
  }

  resolveExecution(args: SetConstraintsInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Setting ARTEX task constraints',
      execute: () => this.execute(args),
    };
  }

  private async execute(args: SetConstraintsInput): Promise<ExecutableToolResult> {
    const handle = await openActiveWork(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const { store, taskId } = handle;
    const batch = args.constraints !== undefined && args.constraints.length > 0;
    const items: ConstraintItem[] = batch
      ? (args.constraints ?? [])
      : [{ text: args.text, type: args.type }];

    const existing = (await store.listConstraints(taskId))
      .filter((constraint) => constraint.origin === this.origin)
      .map((constraint) => ({ kind: constraint.kind, text: constraint.text }));

    const ids: number[] = Array.from({ length: items.length }, () => 0);
    const errors: Record<string, string> = {};
    const valid: { index: number; input: ArtexConstraintInput }[] = [];
    items.forEach((item, index) => {
      const text = item.text?.trim() ?? '';
      if (text === '') {
        errors[String(index)] = 'text must not be empty';
        return;
      }
      valid.push({ index, input: { kind: constraintKind(item.type), text } });
    });

    const all = await store.setConstraints(
      taskId,
      [...existing, ...valid.map((entry) => entry.input)],
      this.origin,
    );
    const mine = all
      .filter((constraint) => constraint.origin === this.origin)
      .toSorted((a, b) => a.id - b.id)
      .slice(existing.length);
    valid.forEach((entry, position) => {
      ids[entry.index] = mine[position]?.id ?? 0;
    });

    if (!batch) {
      const message = errors['0'];
      if (message !== undefined) return artexErr(message);
      return { output: `constraint added: ${String(ids[0])}` };
    }
    const out: Record<string, unknown> = { ids };
    if (Object.keys(errors).length > 0) out['errors'] = errors;
    return { output: artexJson(out) };
  }
}
