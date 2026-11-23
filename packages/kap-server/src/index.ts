export { startServer } from './start';
export type { ServerHostIdentity, ServerStartOptions, RunningServer } from './start';
export { startWebGateway } from './gateway';
export type { WebGatewayStartOptions, RunningWebGateway } from './gateway';
export { okEnvelope, errEnvelope } from './envelope';
export type { Envelope } from './envelope';
export { classify } from './security/bindClassify';
export type { BindClass } from './security/bindClassify';
export {
  loadOrCreateServerToken,
  rotateServerToken,
  serverTokenPath,
} from './services/auth/persistentToken';
export { HOST_API_LEVEL, HOST_PROTOCOL_VERSION } from './services/hosts/hostProtocol';
export { KIMI_AGENT_PROTOCOL_VERSION } from './routes/meta';
export { createEphemeralAuthTokenService } from './services/auth/authTokenService';
export type { IAuthTokenService } from './services/auth/authTokenService';
export { createServerLogger } from './services/pinoLoggerService';
export type {
  CreateLoggerOptions,
  ServerLogger,
  ServerLogLevel,
} from './services/pinoLoggerService';
export {
  createInstanceRegistry,
  listLiveServerInstances,
  getLiveServerInstance,
  resolveServerInstancesDir,
  DEFAULT_SERVER_DIR,
  DEFAULT_SERVER_INSTANCES_DIR,
  HEARTBEAT_INTERVAL_MS,
} from './instanceRegistry';
export type {
  IInstanceRegistry,
  InstanceRegistration,
  InstanceRegistryOptions,
  ServerInstanceInfo,
} from './instanceRegistry';
