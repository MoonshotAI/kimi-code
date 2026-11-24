import { bash, batch, edit, read, say, write } from '@moonshot-ai/testkit/model';

import { expect, selfTest } from '../support/scenario';

selfTest('expectTool', {
  positive: {
    'finds a completed edit by name, target and status': {
      workspace: { 'b.txt': 'old\n' },
      run: async ({ product, model, workspace }) => {
        model.script(edit({ path: 'b.txt', old_string: 'old', new_string: 'new' }), say('Edited b.txt.'));
        await product.send('Change old to new in b.txt.');
        await product.approve();
        await product.waitIdle();
        await product.expectTool({ name: 'Edit', target: 'b.txt', status: 'done' });
        await workspace.expectFile('b.txt', 'new\n');
      },
    },
    'finds each file among several reads made in one step': {
      workspace: { 'a.txt': 'hello\n', 'b.txt': 'world\n' },
      run: async ({ product, model }) => {
        model.script(batch(read('a.txt'), read('b.txt')), say('I read both files.'));
        await product.send('Read a.txt and b.txt.');
        await product.waitIdle();
        await product.expectTool({ name: 'Read', target: 'a.txt', status: 'done' });
        await product.expectTool({ name: 'Read', target: 'b.txt', status: 'done' });
        await product.expectReply('I read both files.');
      },
    },
    'finds a shell command that ran after approval': {
      run: async ({ product, model, workspace }) => {
        model.script(bash('echo hi | tee out.txt'), say('Created out.txt.'));
        await product.send('Write hi into out.txt with a shell command.');
        await product.approve();
        await product.waitIdle();
        expect(model.requests('main')[1]?.texts('tool').join('\n')).toMatch(/(^|\n)hi\n/);
        await product.expectTool({ name: 'Bash', target: 'echo hi | tee out.txt', status: 'done' });
        await workspace.expectFile('out.txt', 'hi\n');
      },
    },
    'finds a write whose file a later step of the same turn changed again': {
      run: async ({ product, model, workspace }) => {
        model.script(write({ path: 'b.txt', content: 'one\n' }), bash('echo two >> b.txt'), say('Wrote b.txt twice.'));
        await product.send('Write one into b.txt, then append two with a shell command.');
        await product.approve();
        await product.approve();
        await product.waitIdle();
        await product.expectTool({ name: 'Write', target: 'b.txt', status: 'done' });
        await product.expectTool({ name: 'Bash', target: 'echo two >> b.txt', status: 'done' });
        await workspace.expectFile('b.txt', 'one\ntwo\n');
      },
    },
    'finds a shell command that failed before it could start': {
      run: async ({ product, model }) => {
        model.script(bash({ command: 'echo never', run_in_background: true }), say('It did not start.'));
        await product.send('Start a background command without describing it.');
        await product.waitIdle();
        await product.expectTool({ name: 'Bash', target: 'echo never', status: 'failed' });
        await product.expectReply('It did not start.');
      },
    },
    'reports a command that the user stopped as failed': {
      run: async ({ product, model }) => {
        model.script(bash('sleep 20'));
        await product.send('Run a slow command.');
        await product.approve();
        await product.stop();
        await product.waitIdle();
        await product.expectTool({ name: 'Bash', target: 'sleep 20', status: 'failed' });
        expect(model.requests('main')).toHaveLength(1);
      },
    },
  },
  negative: {
    'fails when the shell command is a different one, or failed but the scenario expects it done': {
      run: async ({ product, model }) => {
        model.script(bash('exit 3'), say('The command failed.'));
        await product.send('Run a command that fails.');
        await product.approve();
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Bash', target: 'exit 4', status: 'failed' })).rejects.toThrow('did not find Bash');
        await expect(product.expectTool({ name: 'Bash', target: 'exit 3', status: 'done' })).rejects.toThrow('did not find Bash');
        await product.expectTool({ name: 'Bash', target: 'exit 3', status: 'failed' });
      },
    },
    'fails for a file that was not among several reads made in one step': {
      workspace: { 'a.txt': 'hello\n', 'b.txt': 'world\n' },
      run: async ({ product, model }) => {
        model.script(batch(read('a.txt'), read('b.txt')), say('I read both files.'));
        await product.send('Read a.txt and b.txt.');
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Read', target: 'c.txt', status: 'done' })).rejects.toThrow('did not find Read');
        await expect(product.expectTool({ name: 'Read', target: 'a.txt', status: 'failed' })).rejects.toThrow('did not find Read');
        await product.expectTool({ name: 'Read', target: 'a.txt', status: 'done' });
        await product.expectReply('I read both files.');
      },
    },
    'fails when one of several reads made in one step failed but the scenario expects it done': {
      workspace: { 'a.txt': 'hello\n' },
      run: async ({ product, model }) => {
        model.script(batch(read('a.txt'), read('missing.txt')), say('One file was missing.'));
        await product.send('Read a.txt and missing.txt.');
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Read', target: 'missing.txt', status: 'done' })).rejects.toThrow('did not find Read');
        await product.expectTool({ name: 'Read', target: 'missing.txt', status: 'failed' });
        await product.expectTool({ name: 'Read', target: 'a.txt', status: 'done' });
        await product.expectReply('One file was missing.');
      },
    },
    'fails when the tool failed but the scenario expects it done': {
      workspace: { 'b.txt': 'old\n' },
      run: async ({ product, model }) => {
        model.script(edit({ path: 'b.txt', old_string: 'missing', new_string: 'new' }), say('The edit failed.'));
        await product.send('Change missing to new in b.txt.');
        await product.approve();
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Edit', target: 'b.txt', status: 'done' })).rejects.toThrow('did not find Edit');
        await expect(product.expectTool({ name: 'Edit', target: 'b.txt', status: 'rejected' })).rejects.toThrow('did not find Edit');
        await product.expectTool({ name: 'Edit', target: 'b.txt', status: 'failed' });
      },
    },
    'fails when the target or the tool name is wrong': {
      workspace: { 'b.txt': 'old\n' },
      run: async ({ product, model, workspace }) => {
        model.script(edit({ path: 'b.txt', old_string: 'old', new_string: 'new' }), say('Edited b.txt.'));
        await product.send('Change old to new in b.txt.');
        await product.approve();
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Edit', target: 'c.txt', status: 'done' })).rejects.toThrow('did not find Edit');
        await expect(product.expectTool({ name: 'Write', target: 'b.txt', status: 'done' })).rejects.toThrow('did not find Write');
        await product.expectTool({ name: 'Edit', target: 'b.txt', status: 'done' });
        await workspace.expectFile('b.txt', 'new\n');
      },
    },
    'does not take reply text that looks like a tool card for a tool': {
      run: async ({ product, model }) => {
        model.script(say('Here is what a read would look like:\n\n● Used Read (a.txt) · 1 line\n\nBut I did not read anything.'));
        await product.send('Describe a read without doing one.');
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Read', target: 'a.txt', status: 'done' })).rejects.toThrow('did not find Read');
        await product.expectReply('But I did not read anything.');
      },
    },
    'does not take a file of the same name in another directory': {
      workspace: { 'src/a.txt': 'one\n', 'docs/a.txt': 'two\n' },
      run: async ({ product, model }) => {
        model.script(read('src/a.txt'), say('I read the one under src.'));
        await product.send('Read src/a.txt.');
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Read', target: 'docs/a.txt', status: 'done' })).rejects.toThrow('did not find Read');
        await expect(product.expectTool({ name: 'Read', target: 'a.txt', status: 'done' })).rejects.toThrow('did not find Read');
        await product.expectTool({ name: 'Read', target: 'src/a.txt', status: 'done' });
        await product.expectReply('I read the one under src.');
      },
    },
    'does not take a line of the output of a command for the command itself': {
      run: async ({ product, model, workspace }) => {
        model.script(bash('echo ls -la | tee out.txt'), say('I only printed the command.'));
        await product.send('Print a command without running it.');
        await product.approve();
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Bash', target: 'ls -la', status: 'done' })).rejects.toThrow('did not find Bash');
        await product.expectTool({ name: 'Bash', target: 'echo ls -la | tee out.txt', status: 'done' });
        await product.expectReply('I only printed the command.');
        await workspace.expectFile('out.txt', 'ls -la\n');
      },
    },
    'does not take a reply that names a tool and its target for the tool': {
      workspace: { 'package.json': '{}\n' },
      run: async ({ product, model }) => {
        model.script(say('Next step:\n\n**Run** `echo hi | tee out.txt`\n\nAfter that:\n\n- **Edit** package.json\n\nI did neither.'));
        await product.send('Describe two steps without doing them.');
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Bash', target: 'echo hi | tee out.txt', status: 'done' })).rejects.toThrow('did not find Bash');
        await expect(product.expectTool({ name: 'Edit', target: 'package.json', status: 'done' })).rejects.toThrow('did not find Edit');
        await product.expectReply('I did neither.');
      },
    },
    'does not let a reply that repeats a failed command pass for a completed one': {
      run: async ({ product, model }) => {
        model.script(bash('exit 3'), say('**Run**\n\n`exit 3`'));
        await product.send('Run a command that fails, then repeat it in bold.');
        await product.approve();
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Bash', target: 'exit 3', status: 'done' })).rejects.toThrow('did not find Bash');
        await product.expectTool({ name: 'Bash', target: 'exit 3', status: 'failed' });
      },
    },
    'does not take a tool from an earlier turn': {
      workspace: { 'a.txt': 'hello\n' },
      run: async ({ product, model }) => {
        model.script(read('a.txt'), say('I read a.txt.'), say('Nothing to read this time.'));
        await product.send('Read a.txt.');
        await product.waitIdle();
        await product.expectTool({ name: 'Read', target: 'a.txt', status: 'done' });
        await product.send('Just answer.');
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Read', target: 'a.txt', status: 'done' })).rejects.toThrow('did not find Read');
        await product.expectReply('Nothing to read this time.');
      },
    },
    'fails when the tool was rejected but the scenario expects it done or failed': {
      workspace: { 'b.txt': 'old\n' },
      run: async ({ product, model }) => {
        model.script(edit({ path: 'b.txt', old_string: 'old', new_string: 'new' }), say('I left b.txt alone.'));
        await product.send('Change old to new in b.txt.');
        await product.reject();
        await product.waitIdle();
        await expect(product.expectTool({ name: 'Edit', target: 'b.txt', status: 'done' })).rejects.toThrow('did not find Edit');
        await expect(product.expectTool({ name: 'Edit', target: 'b.txt', status: 'failed' })).rejects.toThrow('did not find Edit');
        await product.expectTool({ name: 'Edit', target: 'b.txt', status: 'rejected' });
      },
    },
  },
});
