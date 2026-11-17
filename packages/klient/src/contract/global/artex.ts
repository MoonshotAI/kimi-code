/**
 * App-scope ARTEX workspace inventory contract. Methods mirror the workspace
 * `IArtexWorkStore` surface used by ARTEX global REST routes.
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

const workDir = z.string().min(1);
const loose = z.looseObject({});
const looseArray = z.array(loose);

export const globalArtexContract = {
  listCompanies: { input: z.tuple([workDir]), output: looseArray },
  createCompany: { input: z.tuple([workDir, z.string(), z.string().optional()]), output: loose },
  addCompanyScope: {
    input: z.tuple([workDir, z.number().int(), z.array(z.string()), z.string()]),
    output: loose,
  },
  listAssets: { input: z.tuple([workDir, loose.optional()]), output: looseArray },
  insertAssets: { input: z.tuple([workDir, z.array(loose)]), output: looseArray },
  deleteAssets: { input: z.tuple([workDir, z.array(z.number().int())]), output: noResult },
  listInterceptRules: { input: z.tuple([workDir]), output: looseArray },
  listAssetInterceptRules: { input: z.tuple([workDir]), output: looseArray },
  targetGateExemptions: { input: z.tuple([workDir]), output: z.array(z.string()) },
  setTargetGateExemptions: { input: z.tuple([workDir, z.array(z.string())]), output: noResult },
} satisfies ServiceContract;