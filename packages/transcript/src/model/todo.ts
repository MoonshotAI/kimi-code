import type { TodoId } from './ids';

export type TodoStatus = 'pending' | 'in_progress' | 'done';

export interface TodoItem {
  readonly title: string;
  readonly status: TodoStatus;
}

export interface TranscriptTodo {
  readonly todoId: TodoId;
  readonly items: readonly TodoItem[];
  readonly updatedAt?: string;
}
