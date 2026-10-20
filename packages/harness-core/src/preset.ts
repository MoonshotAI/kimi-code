import type { Feature } from '@moonshot-ai/agent-core/app/index';

import { interaction } from './features/interaction/index';
import { timing } from './features/timing/index';
import { todo } from './features/todo/index';
import { usage } from './features/usage/index';

export const harnessPreset: readonly Feature[] = [todo, timing, usage, interaction];
