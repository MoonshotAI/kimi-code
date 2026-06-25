import {
  Disposable,
  InstantiationService,
  ServiceCollection,
  SyncDescriptor,
  getSingletonServiceDescriptors,
  type IInstantiationService,
} from '../../di';
import type {
  ApprovalRequest,
  ApprovalResponse,
  CoreRPC,
  QuestionRequest,
  QuestionResult,
  SDKAPI,
} from '../../rpc';
import type { Logger } from '../../logging/types';
import { log } from '../../logging/logger';
import { IApprovalService } from '../approval/approval';
import { IAgentRuntimeService } from '../agentRuntime/agentRuntime';
import {
  AgentRuntimeService,
  type AgentRuntimeServiceOptions,
} from '../agentRuntime/agentRuntimeService';
import { ICoreProcessService } from '../coreProcess/coreProcess';
import { CoreProcessService } from '../coreProcess/coreProcessService';
import {
  IEnvironmentService,
  type IEnvironmentService as EnvironmentServiceShape,
} from '../environment/environment';
import { IEventService } from '../event/event';
import { ILogService, type ILogService as LogServiceShape } from '../logger/logger';
import { IQuestionService } from '../question/question';
import type {
  ServicesCoreAdapter,
  ServicesCoreAdapterOptions,
} from './coreApi';

export function createServicesCoreAdapter(
  options: ServicesCoreAdapterOptions,
): ServicesCoreAdapter {
  return new ServicesCoreAdapterImpl(options);
}

class ServicesCoreAdapterImpl extends Disposable implements ServicesCoreAdapter {
  readonly rpc: CoreRPC;
  private readonly instantiation: IInstantiationService;

  constructor(private readonly options: ServicesCoreAdapterOptions) {
    super();
    const services = new ServiceCollection(...getSingletonServiceDescriptors());
    services.set(IEnvironmentService, new CoreApiEnvironmentService(options));
    services.set(ILogService, new CoreApiLogService(log));
    services.set(IApprovalService, new CoreApiApprovalService(options.sdk));
    services.set(IQuestionService, new CoreApiQuestionService(options.sdk));
    services.set(
      IAgentRuntimeService,
      new SyncDescriptor(
        AgentRuntimeService,
        [
          {
            telemetry: options.coreProcessOptions.telemetry,
            kimiRequestHeaders: options.coreProcessOptions.kimiRequestHeaders,
            identity: options.coreProcessOptions.identity,
          } satisfies AgentRuntimeServiceOptions,
        ],
        true,
      ),
    );
    services.set(
      ICoreProcessService,
      new SyncDescriptor(CoreProcessService, [options.coreProcessOptions], false),
    );

    this.instantiation = this._register(new InstantiationService(services));

    const events = this.instantiation.invokeFunction((accessor) => accessor.get(IEventService));
    this._register(
      events.onDidPublish((event) => {
        this.options.sdk.emitEvent(event);
      }),
    );

    const core = this.instantiation.invokeFunction((accessor) => accessor.get(ICoreProcessService));
    this.rpc = core.rpc;
  }

  ready(): Promise<void> {
    const core = this.instantiation.invokeFunction((accessor) => accessor.get(ICoreProcessService));
    return core.ready();
  }
}

class CoreApiEnvironmentService implements EnvironmentServiceShape {
  readonly _serviceBrand: undefined;
  readonly homeDir: string;
  readonly configPath: string;

  constructor(options: Pick<ServicesCoreAdapterOptions, 'homeDir' | 'configPath'>) {
    this.homeDir = options.homeDir;
    this.configPath = options.configPath;
  }
}

class CoreApiLogService implements LogServiceShape {
  readonly _serviceBrand: undefined;

  constructor(private readonly logger: Logger) {}

  info(obj: object | string, msg?: string): void {
    this.write('info', obj, msg);
  }

  warn(obj: object | string, msg?: string): void {
    this.write('warn', obj, msg);
  }

  error(obj: object | string, msg?: string): void {
    this.write('error', obj, msg);
  }

  debug(obj: object | string, msg?: string): void {
    this.write('debug', obj, msg);
  }

  child(bindings: object): LogServiceShape {
    return new CoreApiLogService(this.logger.createChild(bindings as Record<string, unknown>));
  }

  private write(
    level: 'info' | 'warn' | 'error' | 'debug',
    obj: object | string,
    msg?: string,
  ): void {
    if (typeof obj === 'string') {
      this.logger[level](obj);
      return;
    }
    this.logger[level](msg ?? '', obj);
  }
}

class CoreApiApprovalService implements IApprovalService {
  readonly _serviceBrand: undefined;

  constructor(private readonly sdk: SDKAPI) {}

  request(req: ApprovalRequest & { sessionId: string; agentId: string }): Promise<ApprovalResponse> {
    return this.sdk.requestApproval(req);
  }

  resolve(_id: string, _response: ApprovalResponse): void {}

  listPending(_sessionId: string): readonly [] {
    return [];
  }
}

class CoreApiQuestionService implements IQuestionService {
  readonly _serviceBrand: undefined;

  constructor(private readonly sdk: SDKAPI) {}

  request(req: QuestionRequest & { sessionId: string; agentId: string }): Promise<QuestionResult> {
    return this.sdk.requestQuestion(req);
  }

  resolve(_id: string, _response: QuestionResult): void {}

  dismiss(_id: string): void {}

  listPending(_sessionId: string): readonly [] {
    return [];
  }
}
