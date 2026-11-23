import { batch, edit, read, say } from '@moonshot-ai/testkit/model';

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
  },
  negative: {
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
