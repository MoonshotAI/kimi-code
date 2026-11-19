import { isDaemonApiError, MANAGED_KIMI_CODE_PROVIDER_ID } from '@moonshot-ai/app-core/api';

export type ChatGateVerdict = 'ok' | 'login' | 'upgrade' | 'pick-model' | 'configure-model';

export interface ChatGateInput {
  chatModel: string | null;
  chatModelManaged: boolean;
  modelsReady: boolean;
  hasModels: boolean;
  signedIn: boolean;
  isFree: boolean;
}

export function resolveChatModel(
  sessionModel: string | null | undefined,
  draftModel: string | null | undefined,
  defaultModel: string | null | undefined,
  models: ReadonlyArray<{ id: string; model: string }>,
): string | null {
  const valid = (v: string | null | undefined): v is string =>
    v !== null &&
    v !== undefined &&
    v.length > 0 &&
    models.some((m) => m.id === v || m.model === v);
  if (valid(sessionModel)) return sessionModel;
  if (valid(draftModel)) return draftModel;
  if (valid(defaultModel)) return defaultModel;
  return null;
}

export function computeGateVerdict(input: ChatGateInput): ChatGateVerdict {
  if (input.chatModel !== null) {
    return input.isFree && input.chatModelManaged ? 'upgrade' : 'ok';
  }
  if (input.modelsReady) return 'ok';
  if (input.hasModels) return 'pick-model';
  if (!input.signedIn) return 'login';
  if (input.isFree) return 'upgrade';
  return 'configure-model';
}

const AUTH_PROVISIONING_REQUIRED_CODE = 40110;
const AUTH_TOKEN_MISSING_CODE = 40111;
const AUTH_TOKEN_UNAUTHORIZED_CODE = 40112;
export const AUTH_MODEL_NOT_RESOLVED_CODE = 40113;

export function mapDaemonAuthError(
  err: unknown,
  opts: { hasModels: boolean },
): ChatGateVerdict | null {
  if (!isDaemonApiError(err)) return null;
  switch (err.code) {
    case AUTH_PROVISIONING_REQUIRED_CODE:
      return 'configure-model';
    case AUTH_TOKEN_MISSING_CODE: {
      const details: unknown = err.details;
      const providerId =
        details !== null && typeof details === 'object'
          ? (details as { provider_id?: unknown }).provider_id
          : undefined;
      return providerId === MANAGED_KIMI_CODE_PROVIDER_ID ? 'login' : 'configure-model';
    }
    case AUTH_TOKEN_UNAUTHORIZED_CODE:
      return 'login';
    case AUTH_MODEL_NOT_RESOLVED_CODE:
      return opts.hasModels ? 'pick-model' : 'configure-model';
    default:
      return null;
  }
}
