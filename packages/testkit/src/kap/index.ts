export { TestkitError, WaitTimeoutError } from '#/errors';
export { CONVERSATION_FRAME_TYPES, isConversationFrame, turnsFromFrames, type KapFrame, type KapItem, type KapTurn } from '#/kap/frames';
export {
  KapHarness,
  startKap,
  TESTKIT_HOST_IDENTITY,
  type CreateSessionOptions,
  type KapAuthTokenService,
  type KapHostIdentity,
  type KapLaunchOptions,
  type KapRunningServer,
  type PromptOptions,
  type StartKapOptions,
  type WaitIdleOptions,
} from '#/kap/harness';
export { KapEnvelopeError, KapRest, type KapRequest, type QueryValue } from '#/kap/rest';
export { KapCommandError, KapSocket, WS_BEARER_PROTOCOL_PREFIX, type FrameWaitOptions, type SubscribeOptions } from '#/kap/socket';
export type * from '#/kap/types';
