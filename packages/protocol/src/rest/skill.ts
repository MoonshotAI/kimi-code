/**
 *   GET  /v1/sessions/{session_id}/skills
 *     Response data: `{ skills: SkillDescriptor[] }`
 *     Errors: 40401 session.not_found
 *
 *   POST /v1/sessions/{session_id}/skills/{skill_name}:activate
 *     Body: `{ args?: string }`
 *     Response data: `{ activated: true, skill_name: string }`
 *     Errors: 40401 session.not_found, 40415 skill.not_found,
 *             40912 skill.not_activatable
 */

import { z } from 'zod';

import { skillDescriptorSchema } from '../skill';

export const listSkillsResponseSchema = z.object({
  skills: z.array(skillDescriptorSchema),
});
export type ListSkillsResponse = z.infer<typeof listSkillsResponseSchema>;

export const activateSkillRequestSchema = z.object({
  /** Raw argument string appended after the slash command, e.g. `/review --fix` → `--fix`. */
  args: z.string().optional(),
});
export type ActivateSkillRequest = z.infer<typeof activateSkillRequestSchema>;

export const activateSkillResultSchema = z.object({
  activated: z.literal(true),
  skill_name: z.string().min(1),
});
export type ActivateSkillResult = z.infer<typeof activateSkillResultSchema>;
