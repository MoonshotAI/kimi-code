import { call, type Step } from './model';

export type TodoStatus = 'pending' | 'in_progress' | 'done';

export const subagent = (prompt: string, description: string, options: { background?: boolean } = {}): Step =>
  call('Agent', {
    prompt,
    description,
    subagent_type: 'coder',
    ...(options.background === true ? { run_in_background: true } : {}),
  });

export const todos = (...items: ReadonlyArray<readonly [string, TodoStatus]>): Step =>
  call('TodoList', { todos: items.map(([title, status]) => ({ title, status })) });

export const updateGoal = (status: 'active' | 'complete' | 'blocked'): Step => call('UpdateGoal', { status });
