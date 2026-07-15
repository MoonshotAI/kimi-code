import { z } from 'zod';

export const skillSourceSchema = z.enum(['project', 'user', 'extra', 'builtin']);
export type SkillSource = z.infer<typeof skillSourceSchema>;

export const skillDescriptorSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  path: z.string(),
  source: skillSourceSchema,
  type: z.string().optional(),
  /** `true` when the skill is user-slash only (model must not auto-invoke). */
  disable_model_invocation: z.boolean().optional(),
});
export type SkillDescriptor = z.infer<typeof skillDescriptorSchema>;
