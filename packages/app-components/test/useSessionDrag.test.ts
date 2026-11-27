import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_ROW_DRAG_MIME, WORKSPACE_DRAG_MIME } from '@moonshot-ai/app-core/lib';

import {
  useSessionDrag,
  usePinnedDropTarget,
  usePinnedListDrag,
  usePinnedReturnTarget,
  useWorkspaceReorder,
  isSessionRowDrag,
} from '../src/composables/useSessionDrag';

interface MockDragEventOptions {
  types?: string[];
  data?: Record<string, string>;
  clientY?: number;
  rect?: { top: number; height: number };
  contains?: boolean;
}

function mockDragEvent(options: MockDragEventOptions = {}) {
  const store = new Map<string, string>(Object.entries(options.data ?? {}));
  const dataTransfer = {
    types: options.types ?? [],
    effectAllowed: '',
    dropEffect: '',
    setData: vi.fn((type: string, value: string) => {
      store.set(type, value);
    }),
    getData: vi.fn((type: string) => store.get(type) ?? ''),
  };
  const currentTarget = {
    getBoundingClientRect: () => ({ top: options.rect?.top ?? 0, height: options.rect?.height ?? 100 }),
    contains: vi.fn(() => options.contains ?? false),
  };
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  const event = {
    dataTransfer,
    currentTarget,
    relatedTarget: {},
    target: { closest: () => null },
    clientY: options.clientY ?? 0,
    preventDefault,
    stopPropagation,
  };
  return { event: event as unknown as DragEvent, dataTransfer, currentTarget, preventDefault, stopPropagation };
}

function resetDragState(): void {
  endPinnedRowDrag();
  endWorkspaceDrag();
}

const {
  pinnedDragSession,
  workspaceDragId,
  workspaceDragOver,
  startSessionRowDrag,
  startPinnedRowDrag,
  endPinnedRowDrag,
  startWorkspaceDrag,
  endWorkspaceDrag,
} = useSessionDrag();

afterEach(resetDragState);

describe('drag sources', () => {
  it('startSessionRowDrag writes MIME and text/plain payloads', () => {
    const { event, dataTransfer } = mockDragEvent();
    startSessionRowDrag('s1', event);
    expect(dataTransfer.effectAllowed).toBe('move');
    expect(dataTransfer.setData).toHaveBeenCalledWith(SESSION_ROW_DRAG_MIME, 's1');
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 's1');
  });

  it('startSessionRowDrag is a no-op without dataTransfer', () => {
    expect(() => startSessionRowDrag('s1', { dataTransfer: null } as unknown as DragEvent)).not.toThrow();
  });

  it('startPinnedRowDrag writes only text/plain and sets shared state when workspaceId is known', () => {
    const { event, dataTransfer } = mockDragEvent();
    startPinnedRowDrag('s1', 'w1', event);
    expect(dataTransfer.setData).toHaveBeenCalledTimes(1);
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 's1');
    expect(pinnedDragSession.value).toEqual({ id: 's1', workspaceId: 'w1' });
  });

  it('startPinnedRowDrag leaves shared state empty when workspaceId is unknown', () => {
    const { event } = mockDragEvent();
    startPinnedRowDrag('s1', undefined, event);
    expect(pinnedDragSession.value).toBeNull();
  });

  it('endPinnedRowDrag clears shared state', () => {
    startPinnedRowDrag('s1', 'w1', mockDragEvent().event);
    endPinnedRowDrag();
    expect(pinnedDragSession.value).toBeNull();
  });

  it('startWorkspaceDrag / endWorkspaceDrag manage shared state', () => {
    const { event, dataTransfer } = mockDragEvent();
    startWorkspaceDrag('w1', event);
    expect(dataTransfer.effectAllowed).toBe('move');
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'w1');
    expect(workspaceDragId.value).toBe('w1');
    workspaceDragOver.value = { id: 'w2', position: 'after' };
    endWorkspaceDrag();
    expect(workspaceDragId.value).toBeNull();
    expect(workspaceDragOver.value).toBeNull();
  });
});

describe('isSessionRowDrag', () => {
  it('detects the session row MIME among dataTransfer types', () => {
    expect(isSessionRowDrag(mockDragEvent({ types: [SESSION_ROW_DRAG_MIME] }).event)).toBe(true);
    expect(isSessionRowDrag(mockDragEvent({ types: ['text/plain'] }).event)).toBe(false);
    expect(isSessionRowDrag({ dataTransfer: null } as unknown as DragEvent)).toBe(false);
  });
});

describe('usePinnedDropTarget', () => {
  it('ignores drags without the session row MIME', () => {
    const onDropPin = vi.fn();
    const target = usePinnedDropTarget(onDropPin);
    const { event, preventDefault } = mockDragEvent({ types: ['text/plain'] });
    target.onDragOver(event);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(target.dropActive.value).toBe(false);
  });

  it('activates on session row dragover and reports the dropped id', () => {
    const onDropPin = vi.fn();
    const target = usePinnedDropTarget(onDropPin);
    const over = mockDragEvent({ types: [SESSION_ROW_DRAG_MIME] });
    target.onDragOver(over.event);
    expect(over.preventDefault).toHaveBeenCalled();
    expect(over.dataTransfer.dropEffect).toBe('move');
    expect(target.dropActive.value).toBe(true);

    const drop = mockDragEvent({ data: { [SESSION_ROW_DRAG_MIME]: 's1' } });
    target.onDrop(drop.event);
    expect(onDropPin).toHaveBeenCalledWith('s1');
    expect(target.dropActive.value).toBe(false);
  });

  it('drop without payload does not call back', () => {
    const onDropPin = vi.fn();
    const target = usePinnedDropTarget(onDropPin);
    target.onDrop(mockDragEvent().event);
    expect(onDropPin).not.toHaveBeenCalled();
  });

  it('dragleave clears hover only when leaving the container', () => {
    const target = usePinnedDropTarget(vi.fn());
    target.dropActive.value = true;
    target.onDragLeave(mockDragEvent({ contains: true }).event);
    expect(target.dropActive.value).toBe(true);
    target.onDragLeave(mockDragEvent({ contains: false }).event);
    expect(target.dropActive.value).toBe(false);
  });
});

describe('usePinnedReturnTarget', () => {
  it('stays inert without an active pinned drag', () => {
    const target = usePinnedReturnTarget({ isTarget: () => true, onReturn: vi.fn() });
    const { event, preventDefault } = mockDragEvent();
    target.onDragOver(event);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(target.dropHover.value).toBe(false);
  });

  it('blocks non-target groups with a no-drop cursor when blockedCursor is set', () => {
    startPinnedRowDrag('s1', 'w1', mockDragEvent().event);
    const target = usePinnedReturnTarget({
      isTarget: () => false,
      onReturn: vi.fn(),
      blockedCursor: true,
    });
    const { event, dataTransfer, preventDefault } = mockDragEvent();
    target.onDragOver(event);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(dataTransfer.dropEffect).toBe('none');
    expect(target.dropHover.value).toBe(false);
  });

  it('does not touch the cursor for non-targets without blockedCursor', () => {
    startPinnedRowDrag('s1', 'w1', mockDragEvent().event);
    const target = usePinnedReturnTarget({ isTarget: () => false, onReturn: vi.fn() });
    const { event, dataTransfer } = mockDragEvent();
    target.onDragOver(event);
    expect(dataTransfer.dropEffect).toBe('');
  });

  it('accepts the drag on the target and returns the session on drop', () => {
    startPinnedRowDrag('s1', 'w1', mockDragEvent().event);
    const onReturn = vi.fn();
    const target = usePinnedReturnTarget({ isTarget: () => true, onReturn });
    const over = mockDragEvent();
    target.onDragOver(over.event);
    expect(over.preventDefault).toHaveBeenCalled();
    expect(over.dataTransfer.dropEffect).toBe('move');
    expect(target.dropHover.value).toBe(true);

    const drop = mockDragEvent();
    target.onDrop(drop.event);
    expect(drop.preventDefault).toHaveBeenCalled();
    expect(onReturn).toHaveBeenCalledWith('s1');
    expect(target.dropHover.value).toBe(false);
    expect(pinnedDragSession.value).toBeNull();
  });

  it('drop on a non-target is a no-op and keeps the drag alive', () => {
    startPinnedRowDrag('s1', 'w1', mockDragEvent().event);
    const onReturn = vi.fn();
    const target = usePinnedReturnTarget({ isTarget: () => false, onReturn });
    const { event, preventDefault } = mockDragEvent();
    target.onDrop(event);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onReturn).not.toHaveBeenCalled();
    expect(pinnedDragSession.value).toEqual({ id: 's1', workspaceId: 'w1' });
  });

  it('dragleave clears hover only when leaving the container', () => {
    const target = usePinnedReturnTarget({ isTarget: () => true, onReturn: vi.fn() });
    target.dropHover.value = true;
    target.onDragLeave(mockDragEvent({ contains: true }).event);
    expect(target.dropHover.value).toBe(true);
    target.onDragLeave(mockDragEvent({ contains: false }).event);
    expect(target.dropHover.value).toBe(false);
  });
});

describe('useWorkspaceReorder', () => {
  function setup(order: string[] = ['w1', 'w2', 'w3']) {
    const onReorder = vi.fn();
    const reorder = useWorkspaceReorder({ getOrder: () => order, onReorder });
    return { reorder, onReorder };
  }

  it('ignores dragover without an active workspace drag or over itself', () => {
    const { reorder } = setup();
    const idle = mockDragEvent();
    reorder.onDragOver(idle.event, 'w2');
    expect(idle.preventDefault).not.toHaveBeenCalled();

    startWorkspaceDrag('w1', mockDragEvent().event);
    const self = mockDragEvent();
    reorder.onDragOver(self.event, 'w1');
    expect(self.preventDefault).not.toHaveBeenCalled();
    expect(workspaceDragOver.value).toBeNull();
  });

  it('tracks the drop position from the pointer half of the target', () => {
    const { reorder } = setup();
    startWorkspaceDrag('w1', mockDragEvent().event);
    reorder.onDragOver(mockDragEvent({ clientY: 20, rect: { top: 0, height: 100 } }).event, 'w2');
    expect(workspaceDragOver.value).toEqual({ id: 'w2', position: 'before' });
    reorder.onDragOver(mockDragEvent({ clientY: 80, rect: { top: 0, height: 100 } }).event, 'w2');
    expect(workspaceDragOver.value).toEqual({ id: 'w2', position: 'after' });
  });

  it('drop reorders via moveInOrder and clears drag state', () => {
    const { reorder, onReorder } = setup();
    startWorkspaceDrag('w1', mockDragEvent().event);
    reorder.onDragOver(mockDragEvent({ clientY: 80, rect: { top: 0, height: 100 } }).event, 'w3');
    reorder.onDrop('w3');
    expect(onReorder).toHaveBeenCalledWith(['w2', 'w3', 'w1']);
    expect(workspaceDragId.value).toBeNull();
    expect(workspaceDragOver.value).toBeNull();
  });

  it('drop defaults to before when dragover targeted another row', () => {
    const { reorder, onReorder } = setup();
    startWorkspaceDrag('w1', mockDragEvent().event);
    reorder.onDragOver(mockDragEvent({ clientY: 80, rect: { top: 0, height: 100 } }).event, 'w2');
    reorder.onDrop('w3');
    expect(onReorder).toHaveBeenCalledWith(['w2', 'w1', 'w3']);
  });

  it('drop on itself or without an active drag is a no-op', () => {
    const { reorder, onReorder } = setup();
    startWorkspaceDrag('w1', mockDragEvent().event);
    reorder.onDrop('w1');
    expect(onReorder).not.toHaveBeenCalled();
    expect(workspaceDragId.value).toBeNull();

    reorder.onDrop('w2');
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('stays inert when enabled returns false', () => {
    const onReorder = vi.fn();
    const reorder = useWorkspaceReorder({
      getOrder: () => ['w1', 'w2'],
      onReorder,
      enabled: () => false,
    });
    startWorkspaceDrag('w1', mockDragEvent().event);
    const over = mockDragEvent({ clientY: 80, rect: { top: 0, height: 100 } });
    reorder.onDragOver(over.event, 'w2');
    expect(over.preventDefault).not.toHaveBeenCalled();
    expect(workspaceDragOver.value).toBeNull();
    reorder.onDrop('w2');
    expect(onReorder).not.toHaveBeenCalled();
  });
});

describe('usePinnedListDrag', () => {
  function setup(pinnedWorkspaces = ['w1']) {
    const entries = [{ key: 'ws:w1' }, { key: 'session:s1' }];
    const onReorder = vi.fn();
    const onDropPinSession = vi.fn();
    const onDropPinWorkspace = vi.fn();
    const drag = usePinnedListDrag({
      getEntries: () => entries,
      isPinnedWorkspace: (id) => pinnedWorkspaces.includes(id),
      onReorder,
      onDropPinSession,
      onDropPinWorkspace,
    });
    return { drag, onReorder, onDropPinSession, onDropPinWorkspace };
  }

  it('reorders a pinned session before a pinned workspace', () => {
    const { drag, onReorder } = setup();
    startPinnedRowDrag('s1', 'w2', mockDragEvent().event);
    const over = mockDragEvent({ clientY: 10, rect: { top: 0, height: 80 } });
    drag.onEntryDragOver('ws:w1', over.event);
    expect(drag.entryDragOver.value).toEqual({ key: 'ws:w1', position: 'before' });
    drag.onEntryDrop('ws:w1', mockDragEvent().event);
    expect(onReorder).toHaveBeenCalledWith('session:s1', 'ws:w1', 'before');
    expect(drag.entryDragOver.value).toBeNull();
  });

  it('reorders a pinned workspace after a pinned session', () => {
    const { drag, onReorder } = setup(['w1']);
    startWorkspaceDrag('w1', mockDragEvent().event);
    const over = mockDragEvent({ clientY: 70, rect: { top: 0, height: 80 } });
    drag.onEntryDragOver('session:s1', over.event);
    expect(drag.entryDragOver.value).toEqual({ key: 'session:s1', position: 'after' });
    drag.onEntryDrop('session:s1', mockDragEvent().event);
    expect(onReorder).toHaveBeenCalledWith('ws:w1', 'session:s1', 'after');
  });

  it('pins an unpinned session or workspace at the hovered entry or appends on container drop', () => {
    const { drag, onDropPinSession, onDropPinWorkspace } = setup(['w1']);

    const sessionOver = mockDragEvent({
      types: [SESSION_ROW_DRAG_MIME],
      clientY: 15,
      rect: { top: 0, height: 80 },
    });
    drag.onEntryDragOver('session:s1', sessionOver.event);
    expect(drag.entryDragOver.value).toEqual({ key: 'session:s1', position: 'before' });
    drag.onEntryDrop(
      'session:s1',
      mockDragEvent({ data: { [SESSION_ROW_DRAG_MIME]: 's2' } }).event,
    );
    expect(onDropPinSession).toHaveBeenCalledWith('s2', {
      key: 'session:s1',
      position: 'before',
    });

    const tailDrop = mockDragEvent({
      types: [SESSION_ROW_DRAG_MIME],
      data: { [SESSION_ROW_DRAG_MIME]: 's3' },
    });
    drag.onContainerDragOver(tailDrop.event);
    expect(drag.dropActive.value).toBe(true);
    drag.onContainerDrop(tailDrop.event);
    expect(onDropPinSession).toHaveBeenCalledWith('s3');

    startWorkspaceDrag('w2', mockDragEvent().event);
    drag.onEntryDragOver(
      'ws:w1',
      mockDragEvent({ types: [WORKSPACE_DRAG_MIME], clientY: 60, rect: { top: 0, height: 80 } }).event,
    );
    drag.onEntryDrop('ws:w1', mockDragEvent().event);
    expect(onDropPinWorkspace).toHaveBeenCalledWith('w2', {
      key: 'ws:w1',
      position: 'after',
    });
  });
});
