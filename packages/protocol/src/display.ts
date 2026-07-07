import { z } from 'zod';

export const ToolInputDisplaySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command'),
    command: z.string(),
    cwd: z.string().optional(),
    description: z.string().optional(),
    language: z.literal('bash').optional(),
  }),
  z.object({
    kind: z.literal('file_io'),
    operation: z.enum(['read', 'write', 'edit', 'glob', 'grep']),
    path: z.string(),
    detail: z.string().optional(),
    content: z.string().optional(),
    before: z.string().optional(),
    after: z.string().optional(),
  }),
  z.object({
    kind: z.literal('diff'),
    path: z.string(),
    before: z.string(),
    after: z.string(),
    hunks: z.number().optional(),
  }),
  z.object({
    kind: z.literal('search'),
    query: z.string(),
    scope: z.string().optional(),
  }),
  z.object({
    kind: z.literal('url_fetch'),
    url: z.string(),
    method: z.string().optional(),
  }),
  z.object({
    kind: z.literal('agent_call'),
    agent_name: z.string(),
    prompt: z.string(),
    background: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('skill_call'),
    skill_name: z.string(),
    args: z.string().optional(),
  }),
  z.object({
    kind: z.literal('todo_list'),
    items: z.array(z.object({ title: z.string(), status: z.string() })),
  }),
  z.object({
    kind: z.literal('background_task'),
    task_id: z.string(),
    status: z.string(),
    description: z.string(),
    task_kind: z.string().optional(),
  }),
  z.object({
    kind: z.literal('task_stop'),
    task_id: z.string(),
    task_description: z.string(),
  }),
  z.object({
    kind: z.literal('plan_review'),
    plan: z.string(),
    path: z.string().optional(),
    options: z
      .array(
        z.object({
          label: z.string(),
          description: z.string(),
        }),
      )
      .readonly()
      .optional(),
  }),
  z.object({
    kind: z.literal('goal_start'),
    objective: z.string(),
    completionCriterion: z.string().optional(),
    // Current permission mode at approval time. The client uses it to pick the
    // start menu (manual vs yolo); `auto` never reaches this display because it
    // auto-approves the goal without a prompt.
    mode: z.enum(['manual', 'yolo']),
  }),
  z.object({
    kind: z.literal('generic'),
    summary: z.string(),
    detail: z.unknown().optional(),
  }),
]);

export const ToolResultDisplaySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command_output'),
    exit_code: z.number(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
  }),
  z.object({
    kind: z.literal('file_content'),
    path: z.string(),
    content: z.string(),
    range: z.object({ start: z.number(), end: z.number() }).optional(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('diff'),
    path: z.string(),
    before: z.string(),
    after: z.string(),
    hunks: z.number().optional(),
  }),
  z.object({
    kind: z.literal('search_results'),
    query: z.string(),
    matches: z.array(z.object({ file: z.string(), line: z.number(), text: z.string() })),
  }),
  z.object({
    kind: z.literal('url_content'),
    url: z.string(),
    status: z.number(),
    preview: z.string().optional(),
    content_type: z.string().optional(),
  }),
  z.object({
    kind: z.literal('agent_summary'),
    agent_name: z.string(),
    result: z.string().optional(),
    steps: z.number().optional(),
  }),
  z.object({
    kind: z.literal('background_task'),
    task_id: z.string(),
    status: z.string(),
    description: z.string(),
  }),
  z.object({
    kind: z.literal('todo_list'),
    items: z.array(z.object({ title: z.string(), status: z.string() })),
  }),
  z.object({ kind: z.literal('structured'), data: z.unknown() }),
  z.object({
    kind: z.literal('text'),
    text: z.string(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('error'),
    message: z.string(),
    code: z.string().optional(),
  }),
  z.object({
    kind: z.literal('generic'),
    summary: z.string(),
    detail: z.unknown().optional(),
  }),
]);

export type ToolInputDisplay = z.infer<typeof ToolInputDisplaySchema>;
export type ToolResultDisplay = z.infer<typeof ToolResultDisplaySchema>;
