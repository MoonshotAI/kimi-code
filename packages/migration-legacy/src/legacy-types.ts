/**
 * Local type copies from the retired TS engine packages.
 *
 * These mirror types that `packages/migration-legacy` used to import from
 * `@moonshot-ai/agent-core` (v1) / `@moonshot-ai/protocol`. The engine
 * packages are being retired, so the subset used by this package is copied
 * here instead. The v1 shapes are frozen (wire/display formats are versioned
 * on disk), so a local copy stays in sync by definition.
 */

// ════════════════════════════════════════════════════════════════════════════
// ToolInputDisplay — copied from `@moonshot-ai/protocol` (packages/protocol/
// src/display.ts, `ToolInputDisplay = z.infer<typeof ToolInputDisplaySchema>`).
// The migrator recovers these display blocks from legacy wire.jsonl; only the
// TYPE is used here, so the zod schema is not reproduced.
// ════════════════════════════════════════════════════════════════════════════

export type ToolInputDisplay =
  | {
      kind: 'command';
      command: string;
      cwd?: string;
      description?: string;
      language?: 'bash';
    }
  | {
      kind: 'file_io';
      operation: 'read' | 'write' | 'edit' | 'glob' | 'grep';
      path: string;
      detail?: string;
      content?: string;
      before?: string;
      after?: string;
    }
  | { kind: 'diff'; path: string; before: string; after: string; hunks?: number }
  | { kind: 'search'; query: string; scope?: string }
  | { kind: 'url_fetch'; url: string; method?: string }
  | {
      kind: 'agent_call';
      agent_name: string;
      prompt: string;
      background?: boolean;
    }
  | { kind: 'skill_call'; skill_name: string; args?: string }
  | {
      kind: 'todo_list';
      items: Array<{ title: string; status: string }>;
    }
  | {
      kind: 'task';
      task_id: string;
      status: string;
      description: string;
      task_kind?: string;
    }
  | { kind: 'task_stop'; task_id: string; task_description: string }
  | {
      kind: 'plan_review';
      plan: string;
      path?: string;
      options?: ReadonlyArray<{ label: string; description: string }>;
    }
  | {
      kind: 'goal_start';
      objective: string;
      completionCriterion?: string;
      mode: 'manual' | 'yolo';
    }
  | { kind: 'generic'; summary: string; detail?: unknown };
