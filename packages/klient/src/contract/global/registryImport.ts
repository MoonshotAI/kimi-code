import { z } from 'zod';

import type { ServiceContract } from '../types.js';
import { providerCatalogItemSchema } from './catalog.js';

export const importCustomRegistryOptionsSchema = z.object({
  url: z.string(),
  apiKey: z.string().optional(),
  setDefaultWhenUnset: z.boolean().optional(),
});

export const importCustomRegistryResultSchema = z.object({
  providers: z.array(providerCatalogItemSchema),
  modelsImported: z.number().int().min(0),
  credentialEnv: z.record(z.string(), z.string()),
});

export const registryImportContract = {
  importCustomRegistry: {
    input: z.tuple([importCustomRegistryOptionsSchema]),
    output: importCustomRegistryResultSchema,
  },
} satisfies ServiceContract;
