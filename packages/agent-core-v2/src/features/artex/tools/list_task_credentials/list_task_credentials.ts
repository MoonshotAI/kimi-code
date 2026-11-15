import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type {
  AgentTool,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import { IArtexWorkStoreProvider } from '#/features/artex/store/artexWorkStoreProvider';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';

import { ARTEX_INACTIVE_RESULT, artexJson, openActiveWork } from '../toolSupport';
import DESCRIPTION from './list_task_credentials.md?raw';

export const ListTaskCredentialsInputSchema = z.object({});

export type ListTaskCredentialsInput = z.infer<typeof ListTaskCredentialsInputSchema>;

const PARAMETERS = toInputJsonSchema(ListTaskCredentialsInputSchema);

export const IArtexListTaskCredentialsTool: ServiceIdentifier<AgentTool<ListTaskCredentialsInput>> =
  createDecorator<AgentTool<ListTaskCredentialsInput>>('artexListTaskCredentialsTool');

export class ArtexListTaskCredentialsTool implements AgentTool<ListTaskCredentialsInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'list_task_credentials' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexWorkStoreProvider private readonly provider: IArtexWorkStoreProvider,
  ) {}

  resolveExecution(_args: ListTaskCredentialsInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Listing ARTEX task credentials',
      execute: () => this.execute(),
    };
  }

  private async execute(): Promise<ExecutableToolResult> {
    const handle = await openActiveWork(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const credentials = await handle.store.taskCredentials(handle.taskId);
    return { output: artexJson({ credentials }) };
  }
}
