import { providerCatalog, waitFor, type FeatureSpec } from '@moonshot-ai/agent-core';

import { interaction } from '#/features/interaction/feature';
import { kimi } from '#/features/kimi/feature';
import { kimiTrace } from '#/features/kimi-trace/feature';
import { timing } from '#/features/timing/feature';
import { todo } from '#/features/todo/feature';
import { usage } from '#/features/usage/feature';

export const features: readonly FeatureSpec[] = [
  providerCatalog,
  waitFor,
  todo,
  timing,
  usage,
  kimiTrace,
  kimi,
  interaction,
];
