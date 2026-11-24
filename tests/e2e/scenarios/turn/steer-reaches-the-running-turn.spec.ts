import { bash, held, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'steers a message into the running turn while the model writes and while a command runs',
  { except: { acp: 'ACP has no way to send a message while a turn runs: the editor waits for the session/prompt answer before it sends the next one.' } },
  async ({ product, model, workspace }) => {
    const draft = 'Draft the release notes.';
    const profile = 'Use the release profile.';
    const build = 'Run the slow build.';
    const target = 'Build the release target.';
    const command = "printf 'rea%s\\n' dy; while [ ! -f gate.txt ]; do sleep 0.1; done; printf 'buil%s\\n' t";
    model.script(
      held('drafting', say(['Drafting the ', 'notes now.']), 1),
      say('Drafting them with the release profile.'),
      bash(command),
      say('Built the release target.'),
    );

    await product.send(draft);
    await model.hold('drafting').reached();
    await product.steer(profile);
    await product.waitIdle();
    const replying = model.requests('main');
    expect(replying.map((request) => request.state)).toEqual(['aborted', 'finished']);
    expect(replying[1]?.userTextsSinceReply.at(-1)).toBe(profile);
    await product.expectReply('Drafting them with the release profile.');

    await product.send(build);
    await product.approve();
    await product.expectTool({ name: 'Bash', target: command, status: 'running', output: 'ready' });
    await product.steer(target);
    expect(model.requests('main')).toHaveLength(3);
    await workspace.write('gate.txt', '');
    await product.waitIdle();
    const running = model.requests('main').slice(2);
    expect(running.map((request) => request.state)).toEqual(['finished', 'finished']);
    expect(running[1]?.texts('tool').join('\n')).toMatch(/(^|\n)built(\n|$)/);
    expect(running[1]?.userTextsSinceReply).toEqual([target]);
    const roles = running[1]?.view.messages.map((message) => message.role) ?? [];
    expect(roles.lastIndexOf('tool')).toBeLessThan(roles.lastIndexOf('user'));
    await product.expectReply('Built the release target.');

    for (const text of [draft, profile, build, target]) await product.expectTranscript(text);
  },
);
