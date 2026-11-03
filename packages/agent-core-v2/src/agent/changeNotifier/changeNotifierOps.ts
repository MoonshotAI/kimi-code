/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';
import { ContextApplyCompaction, ContextClear } from '#/agent/contextMemory/contextEvents';
import { defineState } from '#/state/state';

import type { SubagentModelPoolSnapshot } from './changeNotifier';

export interface ChangeNotifierSnapshotState {
  readonly agentsMdHash?: string;
  readonly agentsMdFiles?: Readonly<Record<string, string>>;
  readonly skillsHash?: string;
  readonly subagentNames?: readonly string[];
  readonly modelPool?: SubagentModelPoolSnapshot;
  readonly workspacePrimaryByWorkspace?: Readonly<Record<string, string>>;
  readonly workspaceAdditionalDirs?: readonly string[];
}

const subagentModelPoolSchema = z.object({
  defaultModel: z.string().optional(),
  models: z.record(z.string(), z.string()),
});

const changeNotifierSnapshotSchema = z.object({
  agentId: z.string(),
  agentsMdHash: z.string().nullable(),
  agentsMdFiles: z.record(z.string(), z.string()).nullable().optional(),
  skillsHash: z.string().nullable(),
  subagentNames: z.array(z.string()).readonly().nullable(),
  modelPool: subagentModelPoolSchema.nullable().optional(),
  workspacePrimaryByWorkspace: z.record(z.string(), z.string()).nullable().optional(),
  workspaceAdditionalDirs: z.array(z.string()).readonly().nullable().optional(),
});

export class ChangeNotifierSnapshotEvent extends AgentEvent2<
  z.infer<typeof changeNotifierSnapshotSchema>
> {
  static override readonly type = 'changeNotifier.snapshot';
  static override readonly durable = true;
  static override readonly schema = changeNotifierSnapshotSchema;
}
export interface ChangeNotifierSnapshotEvent {
  readonly agentId: string;
  readonly agentsMdHash: string | null;
  readonly agentsMdFiles?: Record<string, string> | null;
  readonly skillsHash: string | null;
  readonly subagentNames: readonly string[] | null;
  readonly modelPool?: SubagentModelPoolSnapshot | null;
  readonly workspacePrimaryByWorkspace?: Readonly<Record<string, string>> | null;
  readonly workspaceAdditionalDirs?: readonly string[] | null;
}

export const changeNotifierSnapshotKey = defineState(
  'changeNotifier.snapshot',
  (): ChangeNotifierSnapshotState => ({}),
)
  .replayable({ schema: z.custom<ChangeNotifierSnapshotState>() })
  .undoable()
  .on(ContextClear, (s) => ({
    workspacePrimaryByWorkspace: s.workspacePrimaryByWorkspace,
    workspaceAdditionalDirs: s.workspaceAdditionalDirs,
  }))
  .on(ContextApplyCompaction, (s) => ({
    workspacePrimaryByWorkspace: s.workspacePrimaryByWorkspace,
    workspaceAdditionalDirs: s.workspaceAdditionalDirs,
  }))
  .on(ChangeNotifierSnapshotEvent, (_s, e) => ({
    agentsMdHash: e.agentsMdHash ?? undefined,
    agentsMdFiles: e.agentsMdFiles ?? undefined,
    skillsHash: e.skillsHash ?? undefined,
    subagentNames: e.subagentNames ?? undefined,
    modelPool: e.modelPool ?? undefined,
    workspacePrimaryByWorkspace: e.workspacePrimaryByWorkspace ?? undefined,
    workspaceAdditionalDirs: e.workspaceAdditionalDirs ?? undefined,
  }));
