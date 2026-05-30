import { RequestError, type AuthMethod, type ClientCapabilities } from '@agentclientprotocol/sdk';
import {
  ErrorCodes,
  type KimiHarness,
} from '@moonshot-ai/kimi-code-sdk';

const AUTH_METHOD_EXISTING_CONFIG = 'kimi-code-existing-config';
const AUTH_METHOD_ENV_MODEL = 'kimi-model-env';
const AUTH_METHOD_TERMINAL = 'kimi-code-terminal';

export function createAuthMethods(clientCapabilities?: ClientCapabilities): AuthMethod[] {
  const methods: AuthMethod[] = [
    {
      id: AUTH_METHOD_EXISTING_CONFIG,
      name: 'Kimi Code config',
      description: 'Use an existing Kimi Code config.toml, API key, or OAuth login.',
    },
    {
      type: 'env_var',
      id: AUTH_METHOD_ENV_MODEL,
      name: 'KIMI_MODEL environment',
      description: 'Configure the ACP server with KIMI_MODEL_* environment variables.',
      vars: [
        { name: 'KIMI_MODEL_NAME', label: 'Model name', secret: false },
        { name: 'KIMI_MODEL_API_KEY', label: 'API key', secret: true },
        { name: 'KIMI_MODEL_PROVIDER_TYPE', label: 'Provider type', optional: true, secret: false },
        { name: 'KIMI_MODEL_BASE_URL', label: 'Base URL', optional: true, secret: false },
      ],
    },
  ];

  if (supportsTerminalAuth(clientCapabilities)) {
    methods.push({
      type: 'terminal',
      id: AUTH_METHOD_TERMINAL,
      name: 'Kimi Code terminal login',
      description: 'Open Kimi Code in a terminal and use /login, then retry session creation.',
      args: [],
    });
  }

  return methods;
}

function supportsTerminalAuth(clientCapabilities?: ClientCapabilities): boolean {
  if (clientCapabilities?.auth?.terminal === true || clientCapabilities?.terminal === true) {
    return true;
  }
  return clientCapabilities?._meta?.['terminal-auth'] === true;
}

export async function authenticateAcpMethod(
  harness: KimiHarness,
  methodId: string,
): Promise<void> {
  if (
    methodId !== AUTH_METHOD_EXISTING_CONFIG &&
    methodId !== AUTH_METHOD_ENV_MODEL &&
    methodId !== AUTH_METHOD_TERMINAL
  ) {
    throw RequestError.invalidParams({ methodId }, 'unknown authentication method');
  }

  await requireAcpAuthReady(harness);
}

export async function requireAcpAuthReady(harness: KimiHarness): Promise<void> {
  const config = await harness.getConfig({ reload: true });
  const modelName = config.defaultModel?.trim();
  if (modelName === undefined || modelName.length === 0) {
    throw authRequired(harness, 'No default model is configured.');
  }

  const model = config.models?.[modelName];
  if (model === undefined) {
    throw authRequired(harness, `Default model "${modelName}" is not configured.`);
  }

  const providerName = model.provider ?? config.defaultProvider;
  if (providerName === undefined) {
    throw authRequired(harness, `Model "${modelName}" does not specify a provider.`);
  }

  const provider = config.providers[providerName];
  if (provider === undefined) {
    throw authRequired(harness, `Provider "${providerName}" is not configured.`);
  }

  if (provider.oauth !== undefined && !(await hasOAuthToken(harness, providerName))) {
    throw authRequired(harness, `Provider "${providerName}" requires login.`);
  }
}

export function isAuthConfigurationError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === ErrorCodes.AUTH_LOGIN_REQUIRED ||
      error.code === ErrorCodes.MODEL_NOT_CONFIGURED ||
      error.code === ErrorCodes.PROVIDER_AUTH_ERROR)
  );
}

function authRequired(harness: KimiHarness, reason: string): RequestError {
  return RequestError.authRequired(
    {
      reason,
      configPath: harness.configPath,
    },
    reason,
  );
}

async function hasOAuthToken(harness: KimiHarness, providerName: string): Promise<boolean> {
  const status = await harness.auth.status(providerName);
  return status.providers.some((provider) => provider.providerName === providerName && provider.hasToken);
}
