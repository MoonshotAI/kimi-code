import { z } from 'zod';

import { fileContentSchema, imageContentSchema, videoContentSchema } from './message';
import { skillDescriptorSchema } from './skill';

export const listSkillsResponseSchema = z.object({
  skills: z.array(skillDescriptorSchema),
});
export type ListSkillsResponse = z.infer<typeof listSkillsResponseSchema>;

/**
 * Attachment parts accepted on skill activation — the media/file subset of
 * the prompt submission's `MessageContent` (text stays in `args`).
 */
export const activateSkillAttachmentSchema = z.discriminatedUnion('type', [
  imageContentSchema,
  videoContentSchema,
  fileContentSchema,
]);
export type ActivateSkillAttachment = z.infer<typeof activateSkillAttachmentSchema>;

export const activateSkillRequestSchema = z.object({
  args: z.string().optional(),
  attachments: z.array(activateSkillAttachmentSchema).optional(),
});
export type ActivateSkillRequest = z.infer<typeof activateSkillRequestSchema>;

export const activateSkillResultSchema = z.object({
  activated: z.literal(true),
  skill_name: z.string().min(1),
});
export type ActivateSkillResult = z.infer<typeof activateSkillResultSchema>;
