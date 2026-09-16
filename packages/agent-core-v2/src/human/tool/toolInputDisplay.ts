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
  | {
      kind: 'diff';
      path: string;
      before: string;
      after: string;
      hunks?: number;
    }
  | {
      kind: 'search';
      query: string;
      scope?: string;
    }
  | {
      kind: 'url_fetch';
      url: string;
      method?: string;
    }
  | {
      kind: 'agent_call';
      agent_name: string;
      prompt: string;
      background?: boolean;
    }
  | {
      kind: 'skill_call';
      skill_name: string;
      args?: string;
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
      task_kind?: string;
    }
  | {
      kind: 'task_stop';
      task_id: string;
      task_description: string;
    }
  | {
      kind: 'plan_review';
      plan: string;
      path?: string;
      options?: readonly { label: string; description: string }[];
    }
  | {
      kind: 'goal_start';
      objective: string;
      completionCriterion?: string;
      mode: 'manual' | 'yolo';
    }
  | {
      kind: 'generic';
      summary: string;
      detail?: unknown;
    };
