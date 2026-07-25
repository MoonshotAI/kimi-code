/**
 * Prompt Optimizer — Configuration loader.
 */

import { resolve } from 'path';
import type { OptimizerConfig } from './types';

const PROJECT_ROOT = resolve(import.meta.dirname, '../../..');

export const DEFAULT_CONFIG: OptimizerConfig = {
  systemPromptPath: resolve(
    PROJECT_ROOT,
    'packages/agent-core-v2/src/app/agentProfileCatalog/system.md',
  ),
  defaultModel: '',
  apiBaseUrl: '',
  apiKeyEnvVar: 'KIMI_API_KEY',
  outputDir: resolve(PROJECT_ROOT, 'scripts/prompt-optimizer/reports'),
  concurrency: 3,
};

export function loadConfig(overrides?: Partial<OptimizerConfig>): OptimizerConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}
