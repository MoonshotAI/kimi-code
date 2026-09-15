/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { Event2 } from '#/app/event/event2';

export interface ConfigWarningItem {
  readonly domain?: string;
  readonly message: string;
}

export interface ConfigWarningPayload {
  readonly warnings: readonly ConfigWarningItem[];
}

export class ConfigWarning extends Event2<{ readonly payload: ConfigWarningPayload }> {
  static override readonly type = 'event.config.warning';
}
export interface ConfigWarning {
  readonly payload: ConfigWarningPayload;
}

export interface ConfigChangedPayload {
  readonly changedFields: readonly string[];
  readonly config: unknown;
}

export class ConfigChanged extends Event2<{ readonly payload: ConfigChangedPayload }> {
  static override readonly type = 'event.config.changed';
}
export interface ConfigChanged {
  readonly payload: ConfigChangedPayload;
}

export interface ProviderConfigResponse {
  type: string;
  base_url?: string;
  default_model?: string;
  has_api_key: boolean;
}

export interface ConfigResponse {
  providers: Record<string, ProviderConfigResponse>;
  default_provider?: string;
  default_model?: string;
  models?: Record<string, unknown>;
  thinking?: unknown;
  plan_mode?: boolean;
  yolo?: boolean;
  default_permission_mode?: string;
  default_plan_mode?: boolean;
  permission?: unknown;
  hooks?: unknown[];
  services?: unknown;
  merge_all_available_skills?: boolean;
  extra_skill_dirs?: string[];
  loop_control?: unknown;
  background?: unknown;
  experimental?: Record<string, boolean>;
  telemetry?: boolean;
  raw?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ConfigChangedEvent {
  readonly type: 'event.config.changed';
  readonly changedFields: string[];
  readonly config: ConfigResponse;
}

export interface ConfigWarningEvent {
  readonly type: 'event.config.warning';
  readonly warnings: readonly ConfigWarningItem[];
}
