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

import { ARTEX_INACTIVE_RESULT, artexErr, artexJson, openActiveWork } from '../toolSupport';
import DESCRIPTION from './save_task_credential.md?raw';

export const SaveTaskCredentialInputSchema = z.object({
  domain: z.string(),
  username: z.string(),
  password: z.string(),
  note: z.string().optional(),
});

export type SaveTaskCredentialInput = z.infer<typeof SaveTaskCredentialInputSchema>;

const PARAMETERS = toInputJsonSchema(SaveTaskCredentialInputSchema);

export const IArtexSaveTaskCredentialTool: ServiceIdentifier<AgentTool<SaveTaskCredentialInput>> =
  createDecorator<AgentTool<SaveTaskCredentialInput>>('artexSaveTaskCredentialTool');

export class ArtexSaveTaskCredentialTool implements AgentTool<SaveTaskCredentialInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'save_task_credential' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexWorkStoreProvider private readonly provider: IArtexWorkStoreProvider,
  ) {}

  resolveExecution(args: SaveTaskCredentialInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Saving an ARTEX task credential',
      execute: () => this.execute(args),
    };
  }

  private async execute(args: SaveTaskCredentialInput): Promise<ExecutableToolResult> {
    const handle = await openActiveWork(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    if (args.domain.trim() === '') return artexErr('domain must not be empty');
    if (args.username.trim() === '') return artexErr('username must not be empty');
    const credential = await handle.store.upsertTaskCredential(handle.taskId, {
      domain: args.domain,
      username: args.username,
      password: args.password,
      note: args.note,
      source: 'agent',
    });
    return {
      output: artexJson({
        id: credential.id,
        domain: credential.domain,
        username: credential.username,
        source: credential.source,
      }),
    };
  }
}
