import type { Event, ResumedSessionState } from '@moonshot-ai/kimi-code-sdk';
import {
  Container,
  Text,
  TuiMainScreen,
  TuiAltScreen,
  VStack,
  ScrollView,
  type Terminal,
} from '@moonshot-ai/pi-tui';
import { CustomEditor } from '#/tui/components/editor/custom-editor';
import { describe, expect, it, vi } from 'vitest';

import { NotifyPanelComponent } from '#/tui/components/chrome/notify-panel';
import { NotifyController } from '#/tui/controllers/notify';

function makeHarness(enabled = true, fullscreen = false) {
  let input: ((data: string) => void) | undefined;
  const terminal: Terminal = {
    start: (onInput) => {
      input = onInput;
    },
    stop: () => {},
    drainInput: async () => {},
    write: () => {},
    columns: 100,
    rows: 24,
    kittyProtocolActive: false,
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
  };
  const ui = fullscreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
  const editor = new CustomEditor(ui);
  editor.setText('unsent draft');
  const transcript = new Text('earlier output\n'.repeat(80), 0, 0);
  const notifyPanel = new NotifyPanelComponent();
  const notifyPanelContainer = new Container();
  const requestRender = vi.spyOn(ui, 'requestRender').mockImplementation(() => {});
  const root = new VStack();
  root.addChild(new ScrollView(transcript, { primary: true }));
  root.addChild(notifyPanelContainer);
  root.addChild(editor);
  if (ui instanceof TuiAltScreen) ui.setLayoutRoot(root);
  else {
    ui.addChild(transcript);
    ui.addChild(notifyPanelContainer);
    ui.addChild(editor);
  }
  ui.setFocus(editor);
  const controller = new NotifyController({
    notifyPanel,
    notifyPanelContainer,
    ui,
    editor,
  } as never);
  controller.setEnabled(enabled);
  editor.onPageNotify = (direction) => controller.changePage(direction);
  const emit = (
    type: string,
    fields: Record<string, unknown> = {},
    agentId = 'main',
    turnId = 1,
  ) => {
    controller.handleEvent({ type, sessionId: 's1', agentId, turnId, ...fields } as Event);
  };
  if (enabled) emit('turn.started');
  requestRender.mockClear();
  const send = (id: string, message: string, agentId = 'main', turnId = 1) => {
    emit(
      'tool.call.started',
      { toolCallId: id, name: 'NotifyUser', args: { message } },
      agentId,
      turnId,
    );
    emit('tool.result', { toolCallId: id, output: 'Update shown to the user.' }, agentId, turnId);
  };
  const texts = () => notifyPanel.getEntries().map((entry) => entry.text);
  const rendered = () => notifyPanel.render(150).join('\n');
  return {
    controller,
    ui,
    editor,
    root,
    input: (data: string) => input?.(data),
    emit,
    send,
    texts,
    rendered,
    notifyPanel,
    notifyPanelContainer,
    requestRender,
  };
}

function snapshot(): ResumedSessionState {
  return {
    sessionMetadata: { agents: {} },
    agents: {
      main: { config: { profileName: 'agent' }, background: [], replay: [] },
      'agent-1': { config: { profileName: 'coder' }, background: [], replay: [] },
    },
  } as unknown as ResumedSessionState;
}

describe('NotifyController', () => {
  it('does nothing when disabled, including replay, layout and keyboard', () => {
    const h = makeHarness(false);
    h.emit('turn.started');
    h.emit('subagent.spawned', { subagentId: 'agent-1', subagentName: 'coder' });
    h.send('n1', 'invisible');
    h.controller.restore(snapshot());
    expect(h.texts()).toEqual([]);
    expect(h.notifyPanelContainer.children).toEqual([]);
    expect(h.controller.changePage(-1)).toBe(false);
    expect(h.requestRender).not.toHaveBeenCalled();
  });

  it('waits for the successful result before displaying authoritative arguments', () => {
    const h = makeHarness();
    h.emit('tool.call.delta', {
      toolCallId: 'n1',
      name: 'NotifyUser',
      argumentsPart: '{"message":"Reading the',
    });
    expect(h.texts()).toEqual([]);
    h.emit('tool.call.delta', { toolCallId: 'n1', argumentsPart: ' parser."}' });
    expect(h.texts()).toEqual([]);
    h.emit('tool.call.started', {
      toolCallId: 'n1',
      name: 'NotifyUser',
      args: { message: 'Parser reviewed.' },
    });
    expect(h.texts()).toEqual([]);
    expect(h.notifyPanelContainer.children).toEqual([]);
    h.emit('tool.result', { toolCallId: 'n1', output: 'Update shown to the user.' });
    expect(h.texts()).toEqual(['Parser reviewed.']);
    expect(h.notifyPanelContainer.children).toEqual([h.notifyPanel]);
  });

  it.each([
    { output: 'Permission denied', isError: true },
    { output: 'Update shown to the user.', synthetic: true },
    { output: 'Notifications are disabled; the update was not displayed.' },
    { output: 'Unrecognized success' },
  ])('never displays rejected, suppressed or unconfirmed updates: %j', (result) => {
    const h = makeHarness();
    h.emit('tool.call.delta', {
      toolCallId: 'blocked',
      name: 'NotifyUser',
      argumentsPart: '{"message":"Private finding',
    });
    expect(h.notifyPanelContainer.children).toEqual([]);
    h.emit('tool.call.started', {
      toolCallId: 'blocked',
      name: 'NotifyUser',
      args: { message: 'Private finding' },
    });
    expect(h.notifyPanelContainer.children).toEqual([]);
    h.emit('tool.result', { toolCallId: 'blocked', ...result });
    expect(h.texts()).toEqual([]);
    expect(h.notifyPanelContainer.children).toEqual([]);
  });

  it.each([false, true])(
    'keeps a foreground descendant alive under a background parent, detached later: %s',
    (detachLater) => {
      const h = makeHarness();
      h.emit('subagent.spawned', {
        subagentId: 'agent-7',
        parentAgentId: 'main',
        subagentName: 'coder',
        runInBackground: !detachLater,
      });
      h.emit('turn.started', {}, 'agent-7');
      h.emit(
        'subagent.spawned',
        {
          subagentId: 'agent-29',
          parentAgentId: 'agent-7',
          subagentName: 'coder',
          runInBackground: false,
        },
        'agent-7',
      );
      h.emit('turn.started', {}, 'agent-29');
      h.emit(
        'tool.call.started',
        { toolCallId: 'pending-child', name: 'NotifyUser', args: { message: 'Child finding' } },
        'agent-29',
      );
      if (detachLater)
        h.emit('background.task.started', {
          info: { kind: 'agent', agentId: 'agent-7', status: 'running' },
        });
      h.emit('turn.ended', { reason: 'completed' });
      h.emit(
        'tool.result',
        { toolCallId: 'pending-child', output: 'Update shown to the user.' },
        'agent-29',
      );
      h.send('later-child', 'More child findings', 'agent-29');
      expect(h.texts()).toEqual(['Child finding', 'More child findings']);
      h.emit('turn.ended', { reason: 'completed' }, 'agent-29');
      h.send('late-event', 'Stale finding', 'agent-29');
      expect(h.texts()).toEqual(['Child finding', 'More child findings']);
    },
  );

  it('clears updates at each new main turn but not at child turn boundaries', () => {
    const h = makeHarness();
    h.emit('turn.started');
    h.send('same', 'first turn');
    h.emit('turn.ended', { reason: 'completed' });
    for (const [i, kind] of ['user', 'cron_job', 'background_task'].entries()) {
      h.emit('turn.started', { origin: { kind } }, 'main', i + 2);
      expect(h.texts()).toEqual([]);
      h.send('same', kind, 'main', i + 2);
      h.emit('turn.started', {}, 'agent-1', i + 2);
      expect(h.texts()).toEqual([kind]);
      h.emit('turn.ended', { reason: 'completed' }, 'main', i + 2);
    }
    expect(h.texts()).toEqual(['background_task']);
    expect(h.notifyPanelContainer.children).toEqual([h.notifyPanel]);
  });

  it('isolates identical call ids by agent and carries source information', () => {
    const h = makeHarness();
    h.emit('subagent.spawned', {
      subagentId: 'agent-1',
      subagentName: 'explore',
      description: 'Authentication checks',
      runInBackground: false,
    });
    h.send('same', 'main findings');
    h.send('same', 'child findings', 'agent-1');
    expect(h.texts()).toEqual(['main findings', 'child findings']);
    expect(h.notifyPanel.getEntries()[0]!.agentId).toBe('main');
    expect(h.notifyPanel.getEntries()[1]!.agentId).toBe('agent-1');
    expect(h.rendered()).toContain('[agent-1]');
    expect(h.rendered()).not.toMatch(/\[main\]|\[sub|explore|Authentication checks/);
    h.emit('subagent.completed', { subagentId: 'agent-1' });
    expect(h.rendered()).toContain('[agent-1]');
  });

  it('keeps background agents working after the main agent ends', () => {
    const h = makeHarness();
    h.emit('turn.started');
    h.emit('subagent.spawned', {
      subagentId: 'agent-1',
      subagentName: 'coder',
      description: 'Run tests',
      runInBackground: true,
    });
    h.emit('turn.started', {}, 'agent-1');
    h.send('n1', 'main done');
    h.emit('turn.ended', { reason: 'completed' });
    expect(h.rendered()).toContain('main done');
    h.send('n2', 'background finding', 'agent-1');
    expect(h.texts()).toEqual(['main done', 'background finding']);
    expect(h.rendered()).toContain('[agent-1]');
    h.emit('subagent.completed', { subagentId: 'agent-1' });
    expect(h.rendered()).toContain('main done');
    expect(h.rendered()).toContain('background finding');
  });

  it('keeps child turns active until their own end events, including detached tasks', () => {
    const h = makeHarness();
    for (const subagentId of ['agent-7', 'agent-29']) {
      h.emit('subagent.spawned', { subagentId, subagentName: 'coder', runInBackground: false });
      h.emit('turn.started', {}, subagentId);
      h.emit(
        'tool.call.started',
        {
          toolCallId: 'pending',
          name: 'NotifyUser',
          args: { message: 'Working' },
        },
        subagentId,
      );
    }
    h.emit('background.task.started', {
      info: { kind: 'agent', agentId: 'agent-29', status: 'running' },
    });
    h.emit('turn.ended', { reason: 'completed' });
    expect(h.texts()).toEqual([]);
    h.emit('turn.ended', { reason: 'cancelled' }, 'agent-7');
    h.emit(
      'tool.result',
      { toolCallId: 'pending', output: 'Update shown to the user.' },
      'agent-7',
    );
    expect(h.texts()).toEqual([]);
    h.emit(
      'tool.result',
      { toolCallId: 'pending', output: 'Update shown to the user.' },
      'agent-29',
    );
    expect(h.texts()).toEqual(['Working']);
    expect(h.rendered()).toContain('[agent-29]');
  });

  it('uses real agent ids regardless of creation order, updates or turn boundaries', () => {
    const h = makeHarness();
    for (const subagentId of ['agent-7', 'agent-29', 'agent-105']) {
      h.emit('subagent.spawned', {
        subagentId,
        subagentName: 'coder',
        description: 'The same long task description for every worker',
        runInBackground: true,
      });
    }
    h.send('b', 'Second worker reports first', 'agent-29');
    h.send('c', 'Third worker reports next', 'agent-105');
    h.send('a', 'First worker reports last', 'agent-7');
    expect(h.rendered().match(/\[agent-\d+\]/g)).toEqual([
      '[agent-29]',
      '[agent-105]',
      '[agent-7]',
    ]);
    h.emit('background.task.started', {
      info: { kind: 'agent', agentId: 'agent-29', description: 'Changed task', status: 'running' },
    });
    h.emit('subagent.started', { subagentId: 'agent-29' });
    h.emit('turn.started', {}, 'main', 2);
    h.send('again', 'Second worker continues', 'agent-29');
    expect(h.rendered()).toContain('[agent-29]');
    expect(h.rendered()).not.toMatch(/\[sub|coder|description|Changed task/);
    h.controller.clear();
    h.send('c-again', 'Third worker continues', 'agent-105');
    expect(h.rendered()).toContain('[agent-105]');
    h.controller.reset();
    h.send('new-session', 'A new session', 'agent-105');
    expect(h.rendered()).toContain('[agent-105]');
  });

  it('uses the same agent id before lifecycle metadata arrives and after toggling the feature', () => {
    const h = makeHarness();
    h.send('first', 'Early update', 'agent-29');
    h.emit('subagent.spawned', { subagentId: 'agent-29', subagentName: 'coder' });
    h.send('second', 'Later update', 'agent-29');
    expect(h.rendered().match(/\[agent-29\]/g)).toHaveLength(2);
    h.controller.setEnabled(false);
    h.emit('subagent.spawned', { subagentId: 'hidden', subagentName: 'coder' });
    h.controller.setEnabled(true);
    h.send('third', 'After enabling', 'agent-29');
    expect(h.rendered()).toContain('[agent-29]');
  });

  it.each([
    'tool.result',
    'turn.step.interrupted',
    'turn.step.retrying',
    'turn.step.completed',
    'turn.ended',
    'subagent.failed',
  ])('retracts only unfinished child updates on %s', (type) => {
    const h = makeHarness();
    h.send('kept', 'delivered', 'agent-1');
    h.emit('turn.step.started', { step: 2 }, 'agent-1');
    h.emit(
      'tool.call.started',
      { toolCallId: 'failed', name: 'NotifyUser', args: { message: 'unfinished' } },
      'agent-1',
    );
    h.emit(
      type,
      {
        toolCallId: 'failed',
        isError: true,
        reason: 'failed',
        step: 2,
        finishReason: 'max_tokens',
        subagentId: 'agent-1',
      },
      'agent-1',
    );
    h.emit('tool.result', { toolCallId: 'failed', output: 'Update shown to the user.' }, 'agent-1');
    expect(h.texts()).toEqual(['delivered']);
  });

  it('ignores duplicate and late events for completed or withdrawn calls', () => {
    const h = makeHarness();
    h.send('done', 'Confirmed update');
    h.emit('tool.call.delta', {
      toolCallId: 'done',
      name: 'NotifyUser',
      argumentsPart: '{"message":"stale partial',
    });
    expect(h.texts()).toEqual(['Confirmed update']);
    h.emit('tool.call.delta', {
      toolCallId: 'cut',
      name: 'NotifyUser',
      argumentsPart: '{"message":"unfinished',
    });
    h.emit('turn.step.completed', { step: 0, finishReason: 'max_tokens' });
    h.emit('tool.call.started', {
      toolCallId: 'cut',
      name: 'NotifyUser',
      args: { message: 'late start' },
    });
    expect(h.texts()).toEqual(['Confirmed update']);
  });

  it('retains independent agent status when the main turn ends', () => {
    const h = makeHarness();
    h.emit('turn.started');
    h.emit('turn.started', {}, 'independent-1');
    h.send('note', 'Checking another question', 'independent-1');
    h.emit('turn.ended', { reason: 'completed' });
    expect(h.notifyPanelContainer.children).toEqual([h.notifyPanel]);
  });

  it('clears only entries on clear, and all session state on reset', () => {
    const h = makeHarness();
    h.emit('subagent.spawned', {
      subagentId: 'agent-1',
      subagentName: 'coder',
      description: 'Tests',
      runInBackground: true,
    });
    h.send('n1', 'earlier');
    h.controller.clear();
    h.send('n2', 'later', 'agent-1');
    expect(h.texts()).toEqual(['later']);
    expect(h.notifyPanelContainer.children).toEqual([h.notifyPanel]);
    h.controller.reset();
    h.send('n3', 'another session');
    expect(h.texts()).toEqual(['another session']);
    expect(h.rendered()).toContain('another session');
  });

  it('disabling removes state and re-enabling does not replay buffered events', () => {
    const h = makeHarness();
    h.send('n1', 'enabled');
    h.controller.setEnabled(false);
    h.requestRender.mockClear();
    h.send('n2', 'disabled');
    h.controller.restore(snapshot());
    expect(h.notifyPanelContainer.children).toEqual([]);
    expect(h.requestRender).not.toHaveBeenCalled();
    h.controller.setEnabled(true);
    expect(h.texts()).toEqual([]);
    h.send('n3', 'enabled again');
    expect(h.texts()).toEqual(['enabled again']);
  });

  it('starts with an empty panel when a session is restored', () => {
    const h = makeHarness();
    h.send('old', 'previous session');
    h.controller.restore(snapshot());
    expect(h.texts()).toEqual([]);
    expect(h.notifyPanelContainer.children).toEqual([]);
  });

  it('restores background metadata and status independently of agent enumeration order', () => {
    const state = snapshot();
    Object.assign(state.agents['main']!, {
      background: [
        { kind: 'agent', agentId: 'agent-1', description: 'Background tests', status: 'running' },
      ],
    });
    const h = makeHarness();
    h.controller.restore(state);
    expect(h.texts()).toEqual([]);
    h.send('fresh', 'New background progress', 'agent-1');
    expect(h.rendered()).toContain('[agent-1]');
    h.emit('turn.ended', { reason: 'completed' });
    h.send('later', 'Still working', 'agent-1');
    expect(h.texts()).toEqual(['New background progress', 'Still working']);
    expect(h.notifyPanelContainer.children).toEqual([h.notifyPanel]);
  });
  it.each([false, true])(
    'pages in place in regular/fullscreen mode and keeps the page after turn end: %s',
    (fullscreen) => {
      const h = makeHarness(true, fullscreen);
      h.send('first', Array.from({ length: 24 }, (_, i) => `- line ${i + 1}`).join('\n'));
      h.ui.start();
      try {
        h.ui.renderNow();
        const editorCursor = h.editor.getCursor();
        const root = h.ui instanceof TuiAltScreen ? h.ui.getLayoutRoot() : [...h.ui.children];
        expect(h.rendered()).toContain('3/3');
        h.input('\u0010');
        expect(h.rendered()).toContain('2/3');
        h.input('\u000E');
        expect(h.rendered()).toContain('3/3');
        h.input('\u0010');
        const page = h.rendered();
        h.emit('turn.ended', { reason: 'completed' });
        expect(h.rendered()).toBe(page);
        expect(h.notifyPanelContainer.children).toEqual([h.notifyPanel]);
        expect(h.ui.getFocusedComponent()).toBe(h.editor);
        expect(h.editor.getText()).toBe('unsent draft');
        expect(h.editor.getCursor()).toEqual(editorCursor);
        if (h.ui instanceof TuiAltScreen) expect(h.ui.getLayoutRoot()).toBe(root);
        else expect(h.ui.children).toEqual(root);
        h.emit('turn.started', {}, 'main', 2);
        expect(h.texts()).toEqual([]);
        expect(h.notifyPanelContainer.children).toEqual([]);
      } finally {
        h.ui.stop();
      }
    },
  );

  it('ignores delayed turn boundaries without erasing the new turn messages', () => {
    const h = makeHarness();
    h.send('old', 'old turn');
    h.emit('turn.started', {}, 'main', 2);
    h.send('new', 'new turn', 'main', 2);
    h.emit('turn.started', {}, 'main', 1);
    h.emit('turn.ended', { reason: 'completed' }, 'main', 1);
    expect(h.texts()).toEqual(['new turn']);
    h.emit('turn.ended', { reason: 'completed' }, 'main', 2);
    expect(h.texts()).toEqual(['new turn']);
    expect(h.notifyPanelContainer.children).toEqual([h.notifyPanel]);
  });

  it('retains more than 100 calls and the complete body, including concurrent notifications', () => {
    const h = makeHarness();
    for (let i = 0; i < 150; i++)
      h.emit('tool.call.started', {
        toolCallId: String(i),
        name: 'NotifyUser',
        args: { message: `update ${i}` },
      });
    expect(h.texts()).toHaveLength(0);
    for (let i = 0; i < 150; i++)
      h.emit('tool.result', { toolCallId: String(i), output: 'Update shown to the user.' });
    const long = 'complete body '.repeat(2000);
    h.send('long', long);
    expect(h.texts()).toHaveLength(151);
    expect(h.texts()[0]).toBe('update 0');
    expect(h.texts().at(-1)).toBe(long);
    h.emit('turn.ended', { reason: 'completed' });
    expect(h.texts()).toHaveLength(151);
    h.emit('tool.call.delta', {
      toolCallId: '0',
      name: 'NotifyUser',
      argumentsPart: '{"message":"late fragment',
    });
    expect(h.texts()[0]).toBe('update 0');
  });

  it('disabling clears retained messages and paging without touching input focus', () => {
    const h = makeHarness();
    h.send('done', '- a\n- b\n- c\n- d\n- e\n- f\n- g\n- h\n- i');
    h.rendered();
    h.controller.changePage(-1);
    h.emit('turn.ended', { reason: 'completed' });
    h.controller.setEnabled(false);
    expect(h.ui.getFocusedComponent()).toBe(h.editor);
    expect(h.texts()).toEqual([]);
    expect(h.controller.changePage(-1)).toBe(false);
    expect(h.controller.changePage(1)).toBe(false);
  });
});
