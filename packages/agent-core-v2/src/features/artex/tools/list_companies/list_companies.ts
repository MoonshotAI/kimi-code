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
import DESCRIPTION from './list_companies.md?raw';

export const ListCompaniesInputSchema = z.object({
  search: z.string().optional(),
});

export type ListCompaniesInput = z.infer<typeof ListCompaniesInputSchema>;

const PARAMETERS = toInputJsonSchema(ListCompaniesInputSchema);

export const IArtexListCompaniesTool: ServiceIdentifier<AgentTool<ListCompaniesInput>> =
  createDecorator<AgentTool<ListCompaniesInput>>('artexListCompaniesTool');

export class ArtexListCompaniesTool implements AgentTool<ListCompaniesInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'list_companies' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexWorkStoreProvider private readonly provider: IArtexWorkStoreProvider,
  ) {}

  resolveExecution(args: ListCompaniesInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Listing ARTEX companies',
      execute: () => this.execute(args),
    };
  }

  private async execute(args: ListCompaniesInput): Promise<ExecutableToolResult> {
    const handle = await openActiveWork(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const companies = await handle.store.listCompanies();
    const needle = args.search?.trim().toLowerCase() ?? '';
    const filtered =
      needle === ''
        ? companies
        : companies.filter((company) => company.name.toLowerCase().includes(needle));
    return { output: artexJson({ count: filtered.length, companies: filtered }) };
  }
}
