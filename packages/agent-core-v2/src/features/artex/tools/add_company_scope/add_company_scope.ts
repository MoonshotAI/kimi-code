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
import DESCRIPTION from './add_company_scope.md?raw';

export const AddCompanyScopeInputSchema = z.object({
  company: z.string(),
  scope: z.string(),
  reason: z.string().optional(),
  logo: z.string().optional(),
});

export type AddCompanyScopeInput = z.infer<typeof AddCompanyScopeInputSchema>;

const PARAMETERS = toInputJsonSchema(AddCompanyScopeInputSchema);

export const IArtexAddCompanyScopeTool: ServiceIdentifier<AgentTool<AddCompanyScopeInput>> =
  createDecorator<AgentTool<AddCompanyScopeInput>>('artexAddCompanyScopeTool');

function splitLines(value: string): string[] {
  const out: string[] = [];
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') out.push(trimmed);
  }
  return out;
}

export class ArtexAddCompanyScopeTool implements AgentTool<AddCompanyScopeInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'add_company_scope' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexWorkStoreProvider private readonly provider: IArtexWorkStoreProvider,
  ) {}

  resolveExecution(args: AddCompanyScopeInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Adding ARTEX company scope',
      execute: () => this.execute(args),
    };
  }

  private async execute(args: AddCompanyScopeInput): Promise<ExecutableToolResult> {
    const handle = await openActiveWork(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    if (args.company.trim() === '') return artexErr('company must not be empty');
    const company = await handle.store.upsertCompany(args.company, args.logo);
    const result = await handle.store.addCompanyScope(
      company.id,
      splitLines(args.scope),
      args.reason ?? '',
    );
    const out: Record<string, unknown> = {
      company_id: result.companyId,
      added: result.added,
      skipped: result.skipped,
      invalid: result.invalid,
    };
    if (result.errors.length > 0) out['errors'] = result.errors;
    return { output: artexJson(out) };
  }
}
