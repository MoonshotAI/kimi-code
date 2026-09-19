import { providerCatalog, waitFor, type FeatureSpec } from '@moonshot-ai/agent-core';

import { createBtw } from '#/features/btw/feature';
import { createCron } from '#/features/cron/feature';
import { createDateChange } from '#/features/dateChange/feature';
import { interaction } from '#/features/interaction/feature';
import { createKimi } from '#/features/kimi/feature';
import { createPlan } from '#/features/plan/feature';
import { timing } from '#/features/timing/feature';
import { todo } from '#/features/todo/feature';
import { usage } from '#/features/usage/feature';

export const features: readonly FeatureSpec[] = [
  providerCatalog,
  waitFor,
  todo,
  timing,
  usage,
  createKimi(),
  interaction,
  createPlan(),
  createBtw(),
  createDateChange(),
  createCron(),
];
