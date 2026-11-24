import { createDecorator, type ServiceIdentifier } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';
import type { IDisposable } from '@moonshot-ai/agent-core-v2/_base/di/lifecycle';
import type { Event } from '@moonshot-ai/agent-core-v2/_base/event';
import type { MCPContentBlock } from '@moonshot-ai/agent-core-v2/mcpCore/types';

export interface HostBrowserToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface HostBrowserMessages {
  readonly enabledReminder: string;
  readonly directReminder: string;
  readonly disabledReminder: string;
  readonly unavailableNotice: string;
  readonly controlOffReason: string;
  describeBlocked(reason: string): string;
}

export interface HostBrowserRun {
  readonly agentId: string;
  readonly generation: number;
  readonly turnId: number;
}

export interface HostBrowserSubagentState {
  readonly running: boolean;
  readonly turnId?: number;
  readonly profile?: string;
  readonly eligible: boolean;
}

export interface HostBrowserSubagent {
  readonly agentId: string;
  readonly generation: number;
  state(): HostBrowserSubagentState;
}

export interface HostBrowserRunRequest {
  readonly sessionId: string;
  readonly args: unknown;
  readonly run?: HostBrowserRun;
  readonly signal: AbortSignal;
}

export interface HostBrowserRunResult {
  readonly content: MCPContentBlock[];
  readonly isError: boolean;
}

export interface IHostBrowser {
  readonly _serviceBrand: undefined;
  readonly tool: HostBrowserToolDefinition;
  readonly messages: HostBrowserMessages;
  readonly onDidChangeAvailability: Event<void>;
  allows(sessionId: string): boolean;
  keepSession(sessionId: string): void;
  run(request: HostBrowserRunRequest): Promise<HostBrowserRunResult>;
  attachSubagent(sessionId: string, agent: HostBrowserSubagent): void;
  describeSubagent(sessionId: string, agentId: string, generation: number, description: string | undefined): void;
  finishSubagentTurn(sessionId: string, run: HostBrowserRun): void;
  closeSubagent(sessionId: string, agentId: string, generation: number): void;
  closeSession(sessionId: string): void;
  dialogReminder(sessionId: string): Promise<string | undefined>;
}

export const IHostBrowser: ServiceIdentifier<IHostBrowser> = createDecorator<IHostBrowser>('hostBrowser');

export interface ISessionHostBrowserService {
  readonly _serviceBrand: undefined;
  readonly host: IHostBrowser;
  readonly onDidChangeAvailability: Event<void>;
  available(): boolean;
}

export const ISessionHostBrowserService: ServiceIdentifier<ISessionHostBrowserService> =
  createDecorator<ISessionHostBrowserService>('sessionHostBrowserService');

export interface IAgentHostBrowserService extends IDisposable {
  readonly _serviceBrand: undefined;
}

export const IAgentHostBrowserService: ServiceIdentifier<IAgentHostBrowserService> =
  createDecorator<IAgentHostBrowserService>('agentHostBrowserService');
