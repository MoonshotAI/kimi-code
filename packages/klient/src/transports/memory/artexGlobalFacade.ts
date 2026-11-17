/**
 * In-process app-scope facade over `IArtexWorkStoreProvider` for global ARTEX
 * inventory routes. kap-server mirrors the same method surface for REST.
 */

import {
  ARTEX_FLAG_ID,
  IArtexWorkStoreProvider,
  IFlagService,
  type IArtexWorkStore,
  type ArtexAssetInput,
  type ArtexAssetQuery,
} from '@moonshot-ai/agent-core-v2';
import { Error2, ErrorCodes } from '@moonshot-ai/agent-core-v2/errors';

function requireArtex(flags: IFlagService): void {
  if (!flags.enabled(ARTEX_FLAG_ID)) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'ARTEX is not enabled');
  }
}

async function storeFor(flags: IFlagService, provider: IArtexWorkStoreProvider, workDir: string): Promise<IArtexWorkStore> {
  requireArtex(flags);
  const store = provider.open(workDir);
  await store.ensureSeeded();
  return store;
}

export type ArtexGlobalFacadeDeps = {
  readonly flags: IFlagService;
  readonly workProvider: IArtexWorkStoreProvider;
};

export function createArtexGlobalFacade(deps: ArtexGlobalFacadeDeps): Record<string, unknown> {
  const { flags, workProvider } = deps;
  return {
    async listCompanies(workDir: string) {
      return (await storeFor(flags, workProvider, workDir)).listCompanies();
    },
    async createCompany(workDir: string, name: string, logo?: string) {
      return (await storeFor(flags, workProvider, workDir)).upsertCompany(name, logo);
    },
    async addCompanyScope(workDir: string, companyId: number, lines: readonly string[], reason: string) {
      return (await storeFor(flags, workProvider, workDir)).addCompanyScope(companyId, lines, reason);
    },
    async listAssets(workDir: string, query?: ArtexAssetQuery) {
      return (await storeFor(flags, workProvider, workDir)).listAssets(query ?? {});
    },
    async insertAssets(workDir: string, inputs: readonly ArtexAssetInput[]) {
      const store = await storeFor(flags, workProvider, workDir);
      const out = [];
      for (const input of inputs) out.push(await store.upsertAsset(input));
      return out;
    },
    async deleteAssets(_workDir: string, _ids: readonly number[]) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'deleteAssets is not implemented');
    },
    async listInterceptRules(workDir: string) {
      return (await storeFor(flags, workProvider, workDir)).listInterceptRules();
    },
    async listAssetInterceptRules(workDir: string) {
      return (await storeFor(flags, workProvider, workDir)).listAssetInterceptRules();
    },
    async targetGateExemptions(workDir: string) {
      return (await storeFor(flags, workProvider, workDir)).targetExemptions();
    },
    async setTargetGateExemptions(_workDir: string, _patterns: readonly string[]) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'setTargetGateExemptions is not implemented');
    },
  };
}