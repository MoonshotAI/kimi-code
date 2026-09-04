import { z } from 'zod';

import { globalMessageBase } from './base';

export const modelCatalogMessageSchema = z.object({
  type: z.literal('model_catalog'),
  ...globalMessageBase,
});

export type CatalogChanged = z.infer<typeof modelCatalogMessageSchema>;
