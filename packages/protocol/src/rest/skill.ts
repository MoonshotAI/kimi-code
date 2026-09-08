/**
 *   GET  /v1/sessions/{session_id}/skills
 *     Response data: `{ skills: SkillDescriptor[] }`
 *     Errors: 40401 session.not_found
 *
 *   POST /v1/sessions/{session_id}/skills/{skill_name}:activate
 *     Body: `{ args?: string, attachments?: (ImageContent|VideoContent|FileContent)[] }`
 *     Response data: `{ activated: true, skill_name: string }`
 *     Errors: 40401 session.not_found, 40415 skill.not_found,
 *             40912 skill.not_activatable
 */

import { z } from 'zod';

import { fileContentSchema, imageContentSchema, videoContentSchema } from '../message';
import { skillDescriptorSchema } from '../skill';

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
  /** Raw argument string appended after the slash command, e.g. `/review --fix` → `--fix`. */
  args: z.string().optional(),
  /**
   * Attachments carried into the skill turn's user message, in the same wire
   * shape as prompt content. They are resolved by the shared prompt media
   * pipeline and appended after the rendered skill prompt text part.
   */
  attachments: z.array(activateSkillAttachmentSchema).optional(),
});
export type ActivateSkillRequest = z.infer<typeof activateSkillRequestSchema>;

export const activateSkillResultSchema = z.object({
  activated: z.literal(true),
  skill_name: z.string().min(1),
});
export type ActivateSkillResult = z.infer<typeof activateSkillResultSchema>;
