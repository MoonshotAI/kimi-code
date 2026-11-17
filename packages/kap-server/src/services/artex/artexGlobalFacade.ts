import {
  ARTEX_FLAG_ID,
  IArtexWorkStoreProvider,
  IFlagService,
  type ArtexAssetInput,
  type ArtexAssetQuery,
  type IArtexWorkStore,
} from '@moonshot-ai/agent-core-v2';
import { Error2, ErrorCodes } from '@moonshot-ai/agent-core-v2/errors';

export type ArtexGlobalFacadeDeps = {
  readonly flags: IFlagService;
  readonly workProvider: IArtexWorkStoreProvider;
};

async function storeFor(deps: ArtexGlobalFacadeDeps, workDir: string): Promise<IArtexWorkStore> {
  if (!deps.flags.enabled(ARTEX_FLAG_ID)) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'ARTEX is not enabled');
  }
  const store = deps.workProvider.open(workDir);
  await store.ensureSeeded();
  return store;
}

export function createArtexGlobalFacade(deps: ArtexGlobalFacadeDeps): Record<string, unknown> {
  return {
    async listCompanies(workDir: string) {
      return (await storeFor(deps, workDir)).listCompanies();
    },
    async createCompany(workDir: string, name: string, logo?: string) {
      return (await storeFor(deps, workDir)).upsertCompany(name, logo);
    },
    async addCompanyScope(workDir: string, companyId: number, lines: readonly string[], reason: string) {
      return (await storeFor(deps, workDir)).addCompanyScope(companyId, lines, reason);
    },
    async listAssets(workDir: string, query?: ArtexAssetQuery) {
      return (await storeFor(deps, workDir)).listAssets(query ?? {});
    },
    async insertAssets(workDir: string, inputs: readonly ArtexAssetInput[]) {
      const store = await storeFor(deps, workDir);
      const out = [];
      for (const input of inputs) out.push(await store.upsertAsset(input));
      return out;
    },
    async listInterceptRules(workDir: string) {
      return (await storeFor(deps, workDir)).listInterceptRules();
    },
    async listAssetInterceptRules(workDir: string) {
      return (await storeFor(deps, workDir)).listAssetInterceptRules();
    },
    async targetGateExemptions(workDir: string) {
      return (await storeFor(deps, workDir)).targetExemptions();
    },
  };
}