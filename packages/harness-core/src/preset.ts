import type { Feature } from '@moonshot-ai/agent-core/app/index';

import { createCron } from './features/cron/index';
import { createGoal } from './features/goal/index';
import { interaction } from './features/interaction/index';
import { createKimi } from './features/kimi/index';
import { createPermission } from './features/permission/index';
import { createPlan } from './features/plan/index';
import { providerCatalog } from './features/provider-catalog/index';
import { createTask } from './features/task/index';
import { timing } from './features/timing/index';
import { todo } from './features/todo/index';
import { undo } from './features/undo/index';
import { usage } from './features/usage/index';
import { waitFor } from './features/wait-for/index';

export const harnessPreset: readonly Feature[] = [
  providerCatalog,
  waitFor,
  undo,
  todo,
  timing,
  usage,
  createKimi(),
  interaction,
  createPlan(),
  createGoal(),
  createPermission(),
  createCron(),
  createTask(),
];
