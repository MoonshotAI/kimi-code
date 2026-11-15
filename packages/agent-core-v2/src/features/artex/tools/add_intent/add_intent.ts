import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type {
  AgentTool,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import { IArtexGraphStoreProvider } from '#/features/artex/store/artexGraphStoreProvider';
import type { IArtexGraphStore } from '#/features/artex/store/artexGraphStore';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';

import {
  ARTEX_INACTIVE_RESULT,
  artexErr,
  artexJson,
  openActiveGraph,
} from '../toolSupport';
import DESCRIPTION from './add_intent.md?raw';

const IntentItemSchema = z.object({
  summary: z.string().optional(),
  asset_ids: z.array(z.number().int()).optional(),
  parent_ids: z.array(z.number().int()).optional(),
  priority: z.number().int().min(0).max(10).optional(),
});

export const AddIntentInputSchema = z.object({
  intents: z.array(IntentItemSchema).optional(),
  summary: z.string().optional(),
  asset_ids: z.array(z.number().int()).optional(),
  parent_ids: z.array(z.number().int()).optional(),
  priority: z.number().int().min(0).max(10).optional(),
});

export type AddIntentInput = z.infer<typeof AddIntentInputSchema>;
type IntentItem = z.infer<typeof IntentItemSchema>;

const PARAMETERS = toInputJsonSchema(AddIntentInputSchema);

export const IArtexAddIntentTool: ServiceIdentifier<AgentTool<AddIntentInput>> =
  createDecorator<AgentTool<AddIntentInput>>('artexAddIntentTool');

async function originFactId(store: IArtexGraphStore): Promise<number | undefined> {
  const facts = await store.listByKind('fact');
  return facts.find((node) => node.state === 'origin')?.id;
}

async function addOneIntent(store: IArtexGraphStore, item: IntentItem): Promise<number> {
  const summary = (item.summary ?? '').trim();
  if (summary.length === 0) throw new Error('summary must not be empty');
  const parents = item.parent_ids ?? [];
  for (const parentId of parents) {
    const parent = await store.getNode(parentId);
    if (parent === undefined) {
      throw new Error(
        `parent_id ${String(parentId)} does not exist: parent_ids must be ids of existing [fact/finding] nodes; leave parent_ids empty for a top-level brand-new direction`,
      );
    }
    if (parent.kind !== 'fact' && parent.kind !== 'finding') {
      throw new Error(
        `parent_id ${String(parentId)} is a ${parent.kind} node and cannot anchor an intent: intents can only anchor on confirmed [fact/finding] nodes`,
      );
    }
  }
  const priority = item.priority === undefined || item.priority === 0 ? 5 : item.priority;
  const anchors = item.asset_ids ?? [];
  const payload: Record<string, unknown> = { summary };
  if (anchors.length > 0) payload['asset_ids'] = anchors;
  const id = await store.addIntent(payload, priority, anchors, 'planner');
  if (parents.length > 0) {
    for (const parent of parents) await store.link(parent, 'derived_from', id);
  } else {
    const origin = await originFactId(store);
    if (origin !== undefined) await store.link(origin, 'derived_from', id);
  }
  return id;
}

export class ArtexAddIntentTool implements AgentTool<AddIntentInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'add_intent' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly provider: IArtexGraphStoreProvider,
  ) {}

  resolveExecution(args: AddIntentInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Adding ARTEX exploration intents',
      execute: () => this.execute(args),
    };
  }

  private async execute(args: AddIntentInput): Promise<ExecutableToolResult> {
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const batch = (args.intents?.length ?? 0) > 0;
    const items: IntentItem[] = batch
      ? (args.intents ?? [])
      : [
          {
            summary: args.summary,
            asset_ids: args.asset_ids,
            parent_ids: args.parent_ids,
            priority: args.priority,
          },
        ];
    const ids: number[] = Array.from({ length: items.length }, () => 0);
    const errors: Record<string, string> = {};
    for (let index = 0; index < items.length; index += 1) {
      try {
        ids[index] = await addOneIntent(handle.store, items[index]!);
      } catch (error) {
        errors[String(index)] = error instanceof Error ? error.message : String(error);
      }
    }
    if (!batch) {
      const message = errors['0'];
      if (message !== undefined) return artexErr(message);
      return { output: `intent created: ${String(ids[0])}` };
    }
    const out: Record<string, unknown> = { ids };
    if (Object.keys(errors).length > 0) out['errors'] = errors;
    return { output: artexJson(out) };
  }
}
