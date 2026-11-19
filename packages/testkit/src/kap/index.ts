export { TestkitError, WaitTimeoutError } from '#/errors';
export {
  KapClient,
  type CreateSessionOptions,
  type KapClientOptions,
  type KapEndpoint,
  type PromptOptions,
  type WaitIdleOptions,
} from '#/kap/client';
export { CONVERSATION_FRAME_TYPES, isConversationFrame, turnsFromFrames, type KapFrame, type KapItem, type KapTurn } from '#/kap/frames';
export {
  KapHarness,
  startKap,
  TESTKIT_HOST_IDENTITY,
  type KapAuthTokenService,
  type KapHostIdentity,
  type KapLaunchOptions,
  type KapRunningServer,
  type StartKapOptions,
} from '#/kap/harness';
export { KapProcess, type KapStopMode, type StartKapProcessOptions } from '#/kap/process';
export {
  dropFrames,
  duplicateFrames,
  insertUnknownFrame,
  KAP_RECORDING_FORMAT,
  kapNormalizer,
  KapRecorder,
  mutateKapRecording,
  readKapRecording,
  replayKapRecording,
  UNKNOWN_FRAME_TYPE,
  type KapFramesAt,
  type KapRecording,
  type KapRecordingCheckpoint,
  type KapRecordingMetadata,
  type KapRecordingReducer,
  type KapRecordingStream,
  type KapReplayCheckpoint,
  type KapStreamPages,
} from '#/kap/recording';
export { KapEnvelopeError, KapRest, type KapRequest, type QueryValue } from '#/kap/rest';
export { KapCommandError, KapSocket, WS_BEARER_PROTOCOL_PREFIX, type FrameWaitOptions, type SubscribeOptions } from '#/kap/socket';
export type * from '#/kap/types';
