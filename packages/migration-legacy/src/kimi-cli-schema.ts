import { z } from 'zod';

export const OldWorkDirMetaSchema = z.object({
  path: z.string(),
  kaos: z.string().default('local'),
  last_session_id: z.string().nullable().optional(),
});

export const OldKimiJsonSchema = z.object({
  work_dirs: z.array(OldWorkDirMetaSchema).default([]),
});

export const OldSessionStateSchema = z
  .object({
    version: z.number().optional(),
    approval: z
      .object({
        yolo: z.boolean().optional(),
        afk: z.boolean().optional(),
        auto_approve_actions: z.array(z.string()).optional(),
      })
      .partial()
      .optional(),
    additional_dirs: z.array(z.string()).optional(),
    custom_title: z.string().nullable().optional(),
    title_generated: z.boolean().optional(),
    title_generate_attempts: z.number().optional(),
    plan_mode: z.boolean().optional(),
    plan_session_id: z.string().nullable().optional(),
    plan_slug: z.string().nullable().optional(),
    wire_mtime: z.number().nullable().optional(),
    archived: z.boolean().optional(),
    archived_at: z.number().nullable().optional(),
    auto_archive_exempt: z.boolean().optional(),
    todos: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const OldSessionMetadataSchema = z
  .object({
    session_id: z.string().optional(),
    title: z.string().nullable().optional(),
    title_generated: z.boolean().optional(),
    title_generate_attempts: z.number().optional(),
    wire_mtime: z.number().nullable().optional(),
    archived: z.boolean().optional(),
    archived_at: z.number().nullable().optional(),
    auto_archive_exempt: z.boolean().optional(),
  })
  .passthrough();

export type OldKimiJson = z.infer<typeof OldKimiJsonSchema>;
export type OldWorkDirMeta = z.infer<typeof OldWorkDirMetaSchema>;
export type OldSessionState = z.infer<typeof OldSessionStateSchema>;
export type OldSessionMetadata = z.infer<typeof OldSessionMetadataSchema>;
