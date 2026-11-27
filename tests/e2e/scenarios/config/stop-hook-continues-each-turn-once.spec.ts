import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const REASON = 'Also list the files you touched.';
const STOP_HOOK = [
  "const fs=require('fs');",
  "const input=JSON.parse(fs.readFileSync(0,'utf8'));",
  "if(!input.stop_hook_active)fs.appendFileSync('stop-hook.log','stop\\n');",
  `console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'deny',permissionDecisionReason:'${REASON}'}}));`,
].join('');

scenario(
  'runs the configured Stop hook in the project folder after each turn, and continues a blocked turn only once',
  {
    except: {
      acp: 'An ACP editor gets no signal when a turn the agent starts on its own ends; stop-hook-continuation-reaches-acp-editor covers ACP.',
    },
    config: { hooks: [{ event: 'Stop', command: `node -e "${STOP_HOOK}"` }] },
  },
  async ({ product, model, workspace }) => {
    const first = 'The parser reads tokens.';
    const continued = 'I touched no files.';
    const second = 'The emitter writes files.';
    const continuedAgain = 'Still no files touched.';
    model.script(say(first), say(continued), say(second), say(continuedAgain));

    await product.send('Describe the parser.');
    await expect.poll(() => model.requests('main').filter((request) => request.state === 'finished').length, { timeout: 30_000 }).toBe(2);
    await product.waitIdle();
    await product.expectTranscript(first);
    await product.expectTranscript(continued);

    await product.send('Describe the emitter.');
    await expect.poll(() => model.requests('main').filter((request) => request.state === 'finished').length, { timeout: 30_000 }).toBe(4);
    await product.waitIdle();
    await product.expectTranscript(second);
    await product.expectTranscript(continuedAgain);
    await workspace.expectFile('stop-hook.log', 'stop\nstop\n');

    const requests = model.requests('main');
    expect(requests).toHaveLength(4);
    expect(requests[1]?.userTextsSinceReply.join('\n')).toContain(REASON);
    expect(requests[2]?.userTextsSinceReply.at(-1)).toBe('Describe the emitter.');
    expect(requests[3]?.userTextsSinceReply.join('\n')).toContain(REASON);
  },
);
