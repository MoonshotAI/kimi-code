import type { ServerMessage } from './union';

export function entityId(msg: ServerMessage): string {
  const m = msg as {
    message_id?: string;
    tool_call_id?: string;
    interaction_id?: string;
    task_id?: string;
    todo_id?: string;
    system_id?: string;
    step_id?: string;
    turn_id?: string;
  };
  return (
    m.message_id ??
    m.tool_call_id ??
    m.interaction_id ??
    m.task_id ??
    m.todo_id ??
    m.system_id ??
    m.step_id ??
    m.turn_id ??
    ''
  );
}

export function entityKey(msg: ServerMessage): string {
  const agent = (msg as { agent_id?: string }).agent_id ?? '';
  return `${agent}:${msg.type}:${entityId(msg)}`;
}
