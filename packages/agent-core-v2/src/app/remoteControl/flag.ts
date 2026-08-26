import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const REMOTE_CONTROL_FLAG_ID = 'remote-control';
export const REMOTE_CONTROL_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_REMOTE_CONTROL';

export const remoteControlFlag: FlagDefinitionInput = {
  id: REMOTE_CONTROL_FLAG_ID,
  title: 'Remote Control',
  description:
    'Expose the local web UI through Kimi Remote Control (`kimi web --remote-control`, `/remote-control`).',
  env: REMOTE_CONTROL_FLAG_ENV,
  default: false,
  surface: 'both',
};

registerFlagDefinition(remoteControlFlag);
