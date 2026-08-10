/**
 * prompt-harness-local.ts — localized harness factory for print mode
 * (G-1 consumption cutover).
 *
 * `run-prompt.ts` previously imported `createKimiHarness` directly from
 * `@moonshot-ai/kimi-code-sdk`. A full local port is out of scope (the SDK
 * harness is a complete engine client: rust-loop RPC, session persistence,
 * config, goals, cron, JS LLM step for non-native providers — see the G-1
 * cutover rules), so this module is the single seam: the print-mode driver
 * and its types stay SDK-free, and the harness dependency is isolated here
 * for the kimi-sdk / kimi-cli swap at G-6.
 *
 * The options type is the local subset `run-prompt.ts` actually passes
 * (`homeDir`, `identity`, `uiMode`, `skillDirs`, `telemetry`,
 * `onOAuthRefresh`, `sessionStartedProperties`), structurally compatible
 * with the SDK `KimiHarnessOptions` at the delegation point.
 */
import { createKimiHarness as sdkCreateKimiHarness } from '@moonshot-ai/kimi-code-sdk';

import type { KimiHostIdentity } from '#/cli/oauth-local';
import type { TelemetryClient, TelemetryProperties } from '#/cli/telemetry';

import type { PromptHarness } from './prompt-session';

/** OAuth token-refresh outcome reported to harness consumers (mirror of the
 *  oauth package type; `run-prompt.ts` reads `success` / `reason`). */
export type OAuthRefreshOutcome =
  | { readonly success: true }
  | { readonly success: false; readonly reason: 'unauthorized' | 'network_or_other' };

/** The harness creation options print mode consumes (SDK subset). */
export interface KimiHarnessOptions {
  readonly identity?: KimiHostIdentity | undefined;
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
  readonly uiMode?: string;
  readonly skillDirs?: readonly string[];
  readonly telemetry?: TelemetryClient | undefined;
  readonly onOAuthRefresh?: ((outcome: OAuthRefreshOutcome) => void) | undefined;
  readonly sessionStartedProperties?: TelemetryProperties;
}

/** Create the print-mode harness (see the file header for the seam note). */
export function createKimiHarness(options: KimiHarnessOptions): PromptHarness {
  return sdkCreateKimiHarness(options as Parameters<typeof sdkCreateKimiHarness>[0]);
}
