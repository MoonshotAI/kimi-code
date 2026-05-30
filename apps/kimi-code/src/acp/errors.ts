import { RequestError } from '@agentclientprotocol/sdk';
import { ErrorCodes, isKimiError, toKimiErrorPayload } from '@moonshot-ai/kimi-code-sdk';

import { isAuthConfigurationError } from './auth-adapter';

export function toAcpRequestError(error: unknown): RequestError {
  if (error instanceof RequestError) return error;
  if (isAuthConfigurationError(error)) {
    return RequestError.authRequired(errorData(error), errorMessage(error));
  }
  if (isKimiError(error) && error.code === ErrorCodes.SESSION_NOT_FOUND) {
    return RequestError.resourceNotFound(error.message);
  }
  return RequestError.internalError(errorData(error), errorMessage(error));
}

export function toAcpSetModelRequestError(error: unknown): RequestError {
  if (error instanceof RequestError) return error;
  if (isKimiError(error) && SET_MODEL_INVALID_PARAM_CODES.has(error.code)) {
    return RequestError.invalidParams(errorData(error), errorMessage(error));
  }
  return toAcpRequestError(error);
}

const SET_MODEL_INVALID_PARAM_CODES = new Set<string>([
  ErrorCodes.CONFIG_INVALID,
  ErrorCodes.MODEL_CONFIG_INVALID,
  ErrorCodes.MODEL_NOT_CONFIGURED,
  ErrorCodes.SESSION_MODEL_EMPTY,
]);

function errorData(error: unknown): unknown {
  if (isKimiError(error)) return toKimiErrorPayload(error);
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return { message: String(error) };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
