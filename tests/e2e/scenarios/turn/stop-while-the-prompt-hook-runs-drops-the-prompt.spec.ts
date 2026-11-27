import { say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const GATE_HOOK = "const fs=require('fs');const watcher=fs.watch('.',()=>{if(fs.existsSync('gate'))watcher.close()});if(fs.existsSync('gate'))watcher.close();";

scenario(
  'stops the turn right away while its UserPromptSubmit hook still runs, and never sends that prompt to the model',
  { config: { hooks: [{ event: 'UserPromptSubmit', command: `node -e "${GATE_HOOK}"` }] } },
  async ({ product, model, workspace }) => {
    const stopped = 'Delete every log file.';
    const next = 'List the log files instead.';
    const answer = 'There are no log files.';
    model.script(say(answer));

    await product.send(stopped);
    await product.stop();
    await workspace.write('gate', 'open\n');
    await product.waitIdle();
    expect(model.requests('main')).toHaveLength(0);

    await product.send(next);
    await product.waitIdle();
    await product.expectReply(answer);

    const requests = model.requests('main');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.texts('user').some((text) => text.includes(stopped))).toBe(false);
    expect(requests[0]?.userTextsSinceReply.at(-1)).toBe(next);
  },
);
