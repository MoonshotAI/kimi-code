import { providerCatalog, undo, waitFor, type FeatureSpec } from '@moonshot-ai/agent-core';

import { createBtw } from '#/features/btw/feature';
import { createCron } from '#/features/cron/feature';
import { createDateChange } from '#/features/dateChange/feature';
import { createGoal } from '#/features/goal/feature';
import { interaction } from '#/features/interaction/feature';
import { createKimi } from '#/features/kimi/feature';
import { createPlan } from '#/features/plan/feature';
import { createPermission } from '#/features/permission/feature';
import { createSwarm } from '#/features/swarm/feature';
import { createTask } from '#/features/task/feature';
import { timing } from '#/features/timing/feature';
import { todo } from '#/features/todo/feature';
import { tokenCounting } from '#/features/tokenCounting/feature';
import { createToolDedupe } from '#/features/toolDedupe/feature';
import { usage } from '#/features/usage/feature';

export const features: readonly FeatureSpec[] = [
  providerCatalog,
  waitFor,
  undo,
  todo,
  timing,
  usage,
  tokenCounting,
  createKimi(),
  interaction,
  createPlan(),
  createGoal(),
  createPermission(),
  createBtw(),
  createDateChange(),
  createCron(),
  createTask(),
  createSwarm(),
  tokenCounting,
  createToolDedupe(),
];
