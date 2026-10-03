import {
  type FlagDefinitionInput,
  registerFlagDefinition,
} from '#/app/flag/flagRegistry';

export const NETWORK_EGRESS_FLAG_ID = 'network-egress';
export const NETWORK_EGRESS_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_NETWORK_EGRESS';

export const networkEgressFlag: FlagDefinitionInput = {
  id: NETWORK_EGRESS_FLAG_ID,
  title: 'Network egress control for sandboxed commands',
  description:
    'Route sandboxed agent commands through a loopback egress proxy enforcing [sandbox.network] allowlists and network_rule entries.',
  env: NETWORK_EGRESS_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(networkEgressFlag);
