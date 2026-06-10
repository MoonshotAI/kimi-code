export default {
  tag: 'tasks',
  summary: '{run} running · {done} done',
  stop: 'stop',
  defaultDescription: 'Background task',
  timingRunning: 'Running · {time}',
  timingDone: 'Done · {sec}s',
  todoTag: 'todos',
  emptyTasks: 'No background tasks running',
  emptyTodo: 'No todos yet',
} as const;
