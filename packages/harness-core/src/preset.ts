import type { Feature } from '@moonshot-ai/agent-core/app/index';

import { createCron } from './features/cron/index';
import { interaction } from './features/interaction/index';
import { createKimi } from './features/kimi/index';
import { providerCatalog } from './features/provider-catalog/index';
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
  createCron(),
];
