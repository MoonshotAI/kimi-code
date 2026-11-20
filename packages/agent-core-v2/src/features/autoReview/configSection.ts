import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const AUTO_REVIEW_SECTION = 'autoReview';

export const AutoReviewConfigSchema = z.object({
  model: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
});

export type AutoReviewConfig = z.infer<typeof AutoReviewConfigSchema>;

registerConfigSection(AUTO_REVIEW_SECTION, AutoReviewConfigSchema);
