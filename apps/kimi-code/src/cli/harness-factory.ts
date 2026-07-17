/**
 * Shared harness factory that creates either a v1 or v2 harness
 * based on the `KIMI_CODE_EXPERIMENTAL_FLAG` (now defaulting to v2).
 */

import {
  createKimiHarness,
  type KimiHarness,
} from '@moonshot-ai/kimi-code-sdk';
import { isKimiV2Enabled } from '#/cli/experimental-v2';
import { createV2PromptHarness } from '#/cli/v2/v2-prompt-harness';
import type { PromptHarness } from '#/cli/prompt-session';

export type { PromptHarness } from '#/cli/prompt-session';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createBestHarness(options: Record<string, any>): KimiHarness {
  if (isKimiV2Enabled()) {
    const identity = options['identity'] as { userAgentProduct?: string; version?: string } | undefined;
    return createV2PromptHarness({
      homeDir: options['homeDir'],
      identity: {
        name: identity?.userAgentProduct ?? 'kimi-code',
        version: identity?.version ?? '0.0.0',
      },
      skillDirs: options['skillDirs'],
      telemetry: options['telemetry'],
      onOAuthRefresh: options['onOAuthRefresh'],
      sessionStartedProperties: options['sessionStartedProperties'],
    }) as unknown as KimiHarness;
  }
  return createKimiHarness(options as never);
}