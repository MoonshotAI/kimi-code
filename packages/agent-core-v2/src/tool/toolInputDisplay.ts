/**
 * `ToolInputDisplay` — structured UI hint describing a tool call's input, so
 * approval panels and tool renderers can present it without re-deriving it
 * from raw arguments. Carried by `RunnableToolExecution.display`,
 * `ToolResult.display`, and the `tool.call.started` event.
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
      // Current permission mode at approval time. The client uses it to pick the
      // start menu (manual vs yolo); `auto` never reaches this display because it
      // auto-approves the goal without a prompt.
      mode: 'manual' | 'yolo';
    }
  | {
      kind: 'workflow_run';
      workflow_name: string;
      description: string;
      when_to_use?: string | undefined;
      phases: { title: string; detail?: string | undefined }[];
      args?: string | undefined;
      // Full workflow script so the client can offer "view raw script" before
      // approving the first run.
      script: string;
      // 'project' | 'user' | 'extra' | 'builtin' | 'inline'
      source: string;
      limits: {
        max_concurrency: number;
        max_agent_calls: number;
        max_duration_ms: number;
      };
      consumption_warning: string;
    }
  | {
      kind: 'generic';
      summary: string;
      detail?: unknown;
    };
