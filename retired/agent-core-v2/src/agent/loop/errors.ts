/**
 * `loop` domain error codes.
 *
 * `context.overflow` used to live here; it moved to `ProtocolErrors` because
 * the translation that raises it happens at the `protocol` boundary. The
 * wire code string is unchanged.
 *
 * `turn.agent_busy` is the legacy turn-domain code kept for its last thrower
 * (skill activation while a turn is active); the wire string is unchanged.
 */

import { t } from '@moonshot-ai/kimi-i18n';
import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const LoopErrors = {
  codes: {
    LOOP_MAX_STEPS_EXCEEDED: 'loop.max_steps_exceeded',
    TURN_AGENT_BUSY: 'turn.agent_busy',
  },
  retryable: ['turn.agent_busy'],
  info: {
    'loop.max_steps_exceeded': {
      title: t('v2Errors.loopMaxStepsExceeded'),
      retryable: false,
      public: true,
      action: t('v2Errors.loopMaxStepsAction'),
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(LoopErrors);
