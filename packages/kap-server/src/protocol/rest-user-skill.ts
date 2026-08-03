/**
 * `/skills/config/user-skills` REST wire schemas — user-level SKILL.md management.
 *
 *   GET    /skills/config/user-skills                data: { skills: WireUserSkill[] }
 *   POST   /skills/config/user-skills/{name}         body: WireUpsertUserSkillRequest → upsert
 *   DELETE /skills/config/user-skills/{name}         → remove
 *
 * The wire shape mirrors the on-disk SKILL.md layout: each user skill lives at
 * `<kimi-home>/skills/<name>/SKILL.md` with frontmatter `name` + `description`
 * (both required for the directory form — see `skillCatalog/parser.ts`) and a
 * markdown body. The route layer serializes between this wire form and the
 * file content.
 *
 * The skill `name` is constrained to `/^[a-zA-Z0-9_-]+$/` so it cannot escape
 * the `<kimi-home>/skills/<name>/` directory layout (no path separators, no
 * `..`, no NUL) — the same constraint used for MCP server names.
 */

import { z } from 'zod';

/**
 * Wire `UserSkill` — one editable user-level skill. `content` is the markdown
 * body (everything after the frontmatter close fence), `name` and `description`
 * come from the frontmatter.
 */
export const userSkillDescriptorSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  content: z.string(),
});
export type WireUserSkill = z.infer<typeof userSkillDescriptorSchema>;

export const listUserSkillsResponseSchema = z.object({
  skills: z.array(userSkillDescriptorSchema),
});
export type WireListUserSkillsResponse = z.infer<typeof listUserSkillsResponseSchema>;

/**
 * Upsert request body. `name` comes from the URL param (not the body) so the
 * frontmatter is always written with the canonical name. `description` is
 * required (the parser rejects a directory-form SKILL.md without it); `content`
 * defaults to an empty string so a skill can be created with just a name +
 * description and edited later.
 */
export const upsertUserSkillRequestSchema = z.object({
  description: z.string().min(1),
  content: z.string().default(''),
});
export type WireUpsertUserSkillRequest = z.infer<typeof upsertUserSkillRequestSchema>;

export const userSkillNameParamSchema = z.object({
  /**
   * Skill name. Constrained to a safe identifier charset so it cannot escape
   * the `<kimi-home>/skills/<name>/` directory layout.
   */
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, 'name must match /^[a-zA-Z0-9_-]+$/'),
});
export type WireUserSkillNameParam = z.infer<typeof userSkillNameParamSchema>;
