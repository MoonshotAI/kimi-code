/**
 * `loop` domain error codes.
 *
 * `context.overflow` used to live here; it moved to `ProtocolErrors` because
 * the translation that raises it happens at the `protocol` boundary. The
 * wire code string is unchanged.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const LoopErrors = {
  codes: {
    LOOP_MAX_STEPS_EXCEEDED: 'loop.max_steps_exceeded',
  },
  info: {
    'loop.max_steps_exceeded': {
      title: 'Loop max steps exceeded',
      retryable: false,
      public: true,
      action:
        'Raise loop_control.max_steps_per_turn in config.toml, or run "/update-config" then "/reload".',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(LoopErrors);
