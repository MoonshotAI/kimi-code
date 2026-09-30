import {
  methods,
  type AgentContext,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type TerminalOutputResponse,
  type WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk';

export interface AcpFsClient {
  readTextFile(params: {
    readonly sessionId: string;
    readonly path: string;
  }): Promise<{ readonly content: string }>;
  writeTextFile(params: {
    readonly sessionId: string;
    readonly path: string;
    readonly content: string;
  }): Promise<unknown>;
}

export interface AcpTerminalHandle {
  readonly id: string;
  currentOutput(): Promise<{ readonly output: string; readonly truncated: boolean }>;
  waitForExit(): Promise<{
    readonly exitCode?: number | null;
    readonly signal?: string | null;
  }>;
  kill(): Promise<unknown>;
  release(): Promise<unknown>;
}

export interface AcpTerminalClient {
  createTerminal(params: {
    readonly sessionId: string;
    readonly command: string;
    readonly args?: string[];
    readonly env?: Array<{ readonly name: string; readonly value: string }>;
    readonly cwd?: string | null;
    readonly outputByteLimit?: number | null;
  }): Promise<AcpTerminalHandle>;
}

export interface AcpClient extends AcpFsClient, AcpTerminalClient {
  sessionUpdate(params: SessionNotification): Promise<void>;
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse>;
}

export function acpClientFromContext(client: AgentContext): AcpClient {
  return {
    sessionUpdate: (params) => client.notify(methods.client.session.update, params),
    requestPermission: (params) =>
      client.request(methods.client.session.requestPermission, params),
    createElicitation: (params) => client.request(methods.client.elicitation.create, params),
    readTextFile: (params) => client.request(methods.client.fs.readTextFile, params),
    writeTextFile: (params) => client.request(methods.client.fs.writeTextFile, params),
    createTerminal: async (params) => {
      const { terminalId } = await client.request<CreateTerminalResponse, CreateTerminalRequest>(
        methods.client.terminal.create,
        params,
      );
      return new ContextTerminalHandle(terminalId, params.sessionId, client);
    },
  };
}

class ContextTerminalHandle implements AcpTerminalHandle {
  constructor(
    readonly id: string,
    private readonly sessionId: string,
    private readonly client: AgentContext,
  ) {}

  currentOutput(): Promise<TerminalOutputResponse> {
    return this.client.request(methods.client.terminal.output, {
      sessionId: this.sessionId,
      terminalId: this.id,
    });
  }

  waitForExit(): Promise<WaitForTerminalExitResponse> {
    return this.client.request(methods.client.terminal.waitForExit, {
      sessionId: this.sessionId,
      terminalId: this.id,
    });
  }

  kill(): Promise<unknown> {
    return this.client.request(methods.client.terminal.kill, {
      sessionId: this.sessionId,
      terminalId: this.id,
    });
  }

  release(): Promise<unknown> {
    return this.client.request(methods.client.terminal.release, {
      sessionId: this.sessionId,
      terminalId: this.id,
    });
  }
}
