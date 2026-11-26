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
  'runs the configured Stop hook in the project folder and shows the ACP editor the turn it continues, only once',
  {
    onlyOn: ['acp'],
    reason: 'The continued turn reaches an ACP editor after its prompt has finished; the editor syncs on usage updates.',
    config: { hooks: [{ event: 'Stop', command: `node -e "${STOP_HOOK}"` }] },
  },
  async ({ product, model, workspace }) => {
    const first = 'The parser reads tokens.';
    const continued = 'I touched no files.';
    model.script(say(first), say(continued));

    await product.send('Describe the parser.');
    await product.waitIdle();
    await product.waitForUsageUpdates(2);
    await product.expectTranscript(first);
    await product.expectTranscript(continued);
    await workspace.expectFile('stop-hook.log', 'stop\\n');

    const requests = model.requests('main');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.userTextsSinceReply.join('\n')).toContain(REASON);
  },
);
