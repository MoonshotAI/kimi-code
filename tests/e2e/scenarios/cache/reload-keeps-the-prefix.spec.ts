import { read, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'keeps the system prompt, the tool list and the prompt cache prefix when the user reloads the session without changing the configuration',
  {
    except: { acp: 'ACP has no request to reload a session, and kimi acp does not offer /reload to the editor.' },
    workspace: { 'notes.txt': 'alpha\n' },
  },
  async ({ product, model, workspace }) => {
    model.script(read('notes.txt'), say('It says alpha.'), say('It still says alpha.'));
    await product.send('Read notes.txt.');
    await product.waitIdle();
    await product.expectReply('It says alpha.');

    await product.reload();
    await product.send('What did it say?');
    await product.waitIdle();
    await product.expectReply('It still says alpha.');

    const requests = model.requests('main');
    expect(requests).toHaveLength(3);
    expect(requests[2]?.texts('user')).toContain('Read notes.txt.');
    expect(requests[2]?.texts('tool').join('\n')).toContain('alpha');
    expect(requests.map((request) => request.view.system)).toEqual(requests.map(() => requests[0]?.view.system));
    expect(requests.map((request) => request.tools)).toEqual(requests.map(() => requests[0]?.tools));
    const main = model.promptCache().filter((entry) => entry.role === 'main');
    expect(main.map((entry) => entry.baseline)).toEqual([undefined, main[0]?.request, main[1]?.request]);
    expect(main.every((entry) => entry.break === undefined)).toBe(true);
    await workspace.expectFile('notes.txt', 'alpha\n');
  },
);
