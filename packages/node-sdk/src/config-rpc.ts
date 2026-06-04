import {
  createRPC,
  ErrorCodes,
  KimiError,
  parseConfigString,
  resolveConfigPath,
  type RPCMethods,
} from '@moonshot-ai/agent-core';
import { z } from 'zod';

export type KimiConfigValidationPathSegment = string | number;

export interface KimiConfigValidationIssue {
  readonly path: readonly KimiConfigValidationPathSegment[];
  readonly message: string;
}

export interface ResolveKimiConfigPathInput {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
}

export interface ValidateKimiConfigTomlInput {
  readonly text: string;
  readonly filePath?: string | undefined;
}

export interface KimiConfigRpc {
  resolveConfigPath(input?: ResolveKimiConfigPathInput): Promise<string>;
  validateConfigToml(input: ValidateKimiConfigTomlInput): Promise<void>;
}

interface KimiConfigCoreRpc {
  resolveConfigPath(input: ResolveKimiConfigPathInput): string;
  validateConfigToml(input: ValidateKimiConfigTomlInput): void;
}

interface KimiConfigClientRpc {}

class KimiConfigCoreRpcImpl implements KimiConfigCoreRpc {
  resolveConfigPath(input: ResolveKimiConfigPathInput): string {
    return resolveConfigPath(input);
  }

  validateConfigToml(input: ValidateKimiConfigTomlInput): void {
    try {
      parseConfigString(input.text, input.filePath);
    } catch (error) {
      const validationIssues = extractValidationIssues(error);
      if (validationIssues !== undefined) {
        throw toConfigValidationError(error, validationIssues);
      }
      throw error;
    }
  }
}

export class KimiConfigRpcClient implements KimiConfigRpc {
  private readonly ready: Promise<RPCMethods<KimiConfigCoreRpc>>;

  constructor() {
    const [coreRpc, clientRpc] = createRPC<KimiConfigCoreRpc, KimiConfigClientRpc>();
    void coreRpc(new KimiConfigCoreRpcImpl());
    this.ready = clientRpc({});
  }

  async resolveConfigPath(input: ResolveKimiConfigPathInput = {}): Promise<string> {
    const rpc = await this.ready;
    return rpc.resolveConfigPath(input);
  }

  async validateConfigToml(input: ValidateKimiConfigTomlInput): Promise<void> {
    const rpc = await this.ready;
    await rpc.validateConfigToml(input);
  }
}

export function createKimiConfigRpc(): KimiConfigRpc {
  return new KimiConfigRpcClient();
}

function toConfigValidationError(
  error: unknown,
  validationIssues: readonly KimiConfigValidationIssue[],
): KimiError {
  const details =
    error instanceof KimiError && error.details !== undefined
      ? { ...error.details, validationIssues }
      : { validationIssues };

  if (error instanceof KimiError) {
    return new KimiError(error.code, error.message, { details });
  }

  const message = error instanceof Error ? error.message : String(error);
  return new KimiError(ErrorCodes.CONFIG_INVALID, message, { details });
}

function extractValidationIssues(error: unknown): readonly KimiConfigValidationIssue[] | undefined {
  const zodError = findZodError(error);
  if (zodError === undefined) return undefined;
  return zodError.issues.map((issue) => ({
    path: issue.path.map((segment) =>
      typeof segment === 'number' ? segment : String(segment),
    ),
    message: issue.message,
  }));
}

function findZodError(error: unknown): z.ZodError | undefined {
  if (error instanceof z.ZodError) return error;
  if (error instanceof Error && error.cause instanceof z.ZodError) return error.cause;
  return undefined;
}
