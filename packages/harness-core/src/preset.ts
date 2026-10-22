import type { Feature } from '#/app/index';

import { createBtw } from './features/btw/index';
import { createDateChange } from './features/dateChange/index';
import { createCron } from './todo-features/cron/index';
import { interaction } from './todo-features/interaction/index';
import { createKimi } from './todo-features/kimi/index';
import { createModelsDev } from './features/models-dev/index';
import { createPermission } from './todo-features/permission/index';
import { createPlan } from './features/plan/index';
import { providerCatalog } from './features/provider-catalog/index';
import { createSwarm } from './todo-features/swarm/index';
import { createTask } from './todo-features/task/index';
import { tokenCounting } from './features/tokenCounting/index';
import { timing } from './features/timing/index';
import { todo } from './todo-features/todo/index';
import { createToolDedupe } from './todo-features/toolDedupe/index';
import { undo } from './todo-features/undo/index';
import { usage } from './features/usage/index';
import { waitFor } from './todo-features/wait-for/index';

export const harnessPreset: readonly Feature[] = [
  providerCatalog,
  createModelsDev(),
  waitFor,
  undo,
  todo,
  timing,
  usage,
  createKimi(),
  tokenCounting,
  interaction,
  createPlan(),
  createPermission(),
  createBtw(),
  createCron(),
  createTask(),
  createDateChange(),
  createSwarm(),
  createToolDedupe(),
];
