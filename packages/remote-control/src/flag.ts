import {
  type FlagDefinitionInput,
  registerFlagDefinition,
} from '@moonshot-ai/agent-core-v2/app/flag/flagRegistry';

export const REMOTE_CONTROL_CHUNKED_RESPONSES_FLAG_ID = 'remote_control_chunked_responses';
export const REMOTE_CONTROL_CHUNKED_RESPONSES_FLAG_ENV =
  'KIMI_CODE_EXPERIMENTAL_REMOTE_CONTROL_CHUNKED_RESPONSES';

// The relay's handling of multi-frame responses (is_last: false) is unverified, so the
// split stays off until it has been exercised end to end.
export const remoteControlChunkedResponsesFlag: FlagDefinitionInput = {
  id: REMOTE_CONTROL_CHUNKED_RESPONSES_FLAG_ID,
  title: 'Chunked Remote Control responses',
  description:
    'Split large Remote Control HTTP responses into 256 KiB tunnel frames instead of sending one frame per response.',
  env: REMOTE_CONTROL_CHUNKED_RESPONSES_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(remoteControlChunkedResponsesFlag);
