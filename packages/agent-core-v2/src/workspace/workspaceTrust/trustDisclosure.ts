import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface TrustGatedMcpServer {
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly url?: string;
  readonly origin: string;
}

export interface TrustGatedInstructionSources {
  readonly agentsMdPaths: readonly string[];
  readonly skills: readonly string[];
  readonly agentProfiles: readonly string[];
  readonly paths: readonly string[];
}

export interface TrustGatedActivation {
  readonly mcpServers: readonly TrustGatedMcpServer[];
  readonly additionalDirs: readonly string[];
  readonly additionalDirSources: readonly string[];
  readonly warnings: readonly string[];
  readonly instructionSources: TrustGatedInstructionSources;
}

export interface IWorkspaceTrustDisclosure {
  readonly _serviceBrand: undefined;

  describeGatedActivation(): Promise<TrustGatedActivation>;
}

export const IWorkspaceTrustDisclosure: ServiceIdentifier<IWorkspaceTrustDisclosure> =
  createDecorator<IWorkspaceTrustDisclosure>('workspaceTrustDisclosure');
