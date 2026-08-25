/**
 * `ToolInputDisplay` — structured UI hint describing a tool call's input, so
 * approval panels and tool renderers can present it without re-deriving it
 * from raw arguments.
 */
export type ToolInputDisplay =
  | {
      kind: 'command';
      command: string;
      cwd?: string | undefined;
      description?: string | undefined;
      language?: 'bash' | undefined;
    }
  | {
      kind: 'file_io';
      operation: 'read' | 'write' | 'edit' | 'glob' | 'grep';
      path: string;
      detail?: string | undefined;
      content?: string | undefined;
      before?: string | undefined;
      after?: string | undefined;
    }
  | {
      kind: 'diff';
      path: string;
      before: string;
      after: string;
      hunks?: number | undefined;
    }
  | {
      kind: 'search';
      query: string;
      scope?: string | undefined;
    }
  | {
      kind: 'url_fetch';
      url: string;
      method?: string | undefined;
    }
  | {
      kind: 'agent_call';
      agent_name: string;
      prompt: string;
      background?: boolean | undefined;
    }
  | {
      kind: 'skill_call';
      skill_name: string;
      args?: string | undefined;
    }
  | {
      kind: 'todo_list';
      items: { title: string; status: string }[];
    }
  | {
      kind: 'task';
      task_id: string;
      status: string;
      description: string;
      task_kind?: string | undefined;
    }
  | {
      kind: 'task_stop';
      task_id: string;
      task_description: string;
    }
  | {
      kind: 'plan_review';
      plan: string;
      path?: string | undefined;
      options?: readonly { label: string; description: string }[] | undefined;
    }
  | {
      kind: 'goal_start';
      objective: string;
      completionCriterion?: string | undefined;
      mode: 'manual' | 'yolo';
    }
  | {
      kind: 'flow_start_review';
      flow_id: string;
      task: string;
      source_path: string;
      stages: readonly {
        id: string;
        gate: 'ai' | 'human' | 'ai-then-human';
        objective: string;
        completion: string;
      }[];
    }
  | {
      kind: 'flow_gate_review';
      flow_id: string;
      task?: string;
      stage_id: string;
      stage_index: number;
      stage_total: number;
      gate: 'human' | 'ai-then-human';
      objective: string;
      completion: string;
      next_stage_id?: string;
      criteria: readonly { criterion: string; met: boolean; evidence: string }[];
      note?: string;
    }
  | {
      kind: 'flow_jump_review';
      flow_id: string;
      task?: string;
      from_stage_id: string;
      to_stage_id: string;
      from_index: number;
      to_index: number;
      stage_total: number;
      reason: string;
    }
  | {
      kind: 'generic';
      summary: string;
      detail?: unknown;
    };
