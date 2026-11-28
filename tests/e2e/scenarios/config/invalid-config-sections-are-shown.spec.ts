import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const PERMISSION_WARNING = 'Ignored invalid config section [permission]: rules[0]';
const LOOP_CONTROL_WARNING = 'Ignored invalid config section [loop_control]: max_steps_per_turn';

scenario(
  'shows which config sections are invalid at startup, after an edit and after a restart',
  {
    config: { extra: { permission: { rules: 'deny everything' } } },
    except: { acp: 'An ACP editor has no channel for config warnings; the agent can only stream the conversation.' },
  },
  async ({ product, model, configure }) => {
    model.script(say('The parser reads tokens.'), say('The emitter writes files.'));

    await product.expectNotice(PERMISSION_WARNING);
    await product.send('Describe the parser.');
    await product.waitIdle();
    await product.expectReply('The parser reads tokens.');

    await configure((config) => ({ ...config, extra: { ...config.extra, loop_control: { max_steps_per_turn: 'many' } } }));
    await product.reload();
    await product.expectNotice(LOOP_CONTROL_WARNING);

    await product.restart();
    await product.expectNotice(PERMISSION_WARNING);
    await product.expectNotice(LOOP_CONTROL_WARNING);
    await product.send('Describe the emitter.');
    await product.waitIdle();
    await product.expectReply('The emitter writes files.');

    const requests = model.requests('main');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.texts('assistant')).toContain('The parser reads tokens.');
    expect(requests[1]?.userTextsSinceReply.at(-1)).toBe('Describe the emitter.');
  },
);
