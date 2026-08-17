import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface RunShellCommandInput {
  readonly command: string;
  readonly commandId?: string;
}

export interface RunShellCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly isError?: boolean;
  readonly backgrounded?: boolean;
}

export interface IAgentShellCommandService {
  readonly _serviceBrand: undefined;

  run(input: RunShellCommandInput): Promise<RunShellCommandResult>;
  cancel(commandId: string): void;
}

export const IAgentShellCommandService: ServiceIdentifier<IAgentShellCommandService> =
  createDecorator<IAgentShellCommandService>('agentShellCommandService');
