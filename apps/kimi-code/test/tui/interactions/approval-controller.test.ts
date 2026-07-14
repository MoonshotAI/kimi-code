import type { ApprovalResponse, CoreSession, PendingApproval } from '#/core/index';
import { describe, expect, it, vi } from 'vitest';

import { ApprovalController } from '#/tui/interactions/approval-controller';

function pending(id: string, action: string): PendingApproval {
  return {
    id,
    agentId: 'main',
    request: {
      toolCallId: id,
      toolName: 'Bash',
      action,
      display: { kind: 'generic', summary: action },
    },
  };
}

function makeApprovalBroker(initial: readonly PendingApproval[] = []) {
  const pendings = [...initial];
  const changeListeners = new Set<() => void>();
  const resolveListeners = new Set<(id: string) => void>();
  const remove = (id: string): void => {
    const idx = pendings.findIndex((p) => p.id === id);
    if (idx >= 0) pendings.splice(idx, 1);
  };
  const decide = vi.fn((id: string, _response: ApprovalResponse) => {
    remove(id);
    for (const listener of resolveListeners) listener(id);
  });
  return {
    list: () => pendings,
    onDidChangePending: (listener: () => void) => {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    onDidResolve: (listener: (id: string) => void) => {
      resolveListeners.add(listener);
      return () => resolveListeners.delete(listener);
    },
    decide,
    /** Simulate an out-of-band resolution (another client, policy). */
    externalResolve(id: string): void {
      remove(id);
      for (const listener of resolveListeners) listener(id);
    },
  };
}

function sessionOf(broker: ReturnType<typeof makeApprovalBroker>): CoreSession {
  return { approvals: broker } as unknown as CoreSession;
}

describe('ApprovalController', () => {
  it('presents a parked pending and writes the decision back', async () => {
    const broker = makeApprovalBroker([pending('id-1', 'run command: ls')]);
    const controller = new ApprovalController();
    const showPanel = vi.fn();
    const hidePanel = vi.fn();
    const onDecided = vi.fn();
    controller.setUIHooks({ showPanel, hidePanel });

    controller.attach(sessionOf(broker), { onDecided });

    expect(showPanel).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-1' }));

    controller.respond({ decision: 'approved' });
    await vi.waitFor(() => {
      expect(broker.decide).toHaveBeenCalledWith('id-1', { decision: 'approved' });
    });
    expect(onDecided).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'id-1' }),
      expect.objectContaining({ decision: 'approved' }),
    );
    expect(hidePanel).toHaveBeenCalledOnce();
  });

  it('auto-approves queued same-action pendings when the current is approved for session', async () => {
    const broker = makeApprovalBroker([
      pending('id-1', 'run command: ls'),
      pending('id-2', 'run command: ls'),
      pending('id-3', 'edit src/x.ts'),
      pending('id-4', 'run command: ls'),
    ]);
    const controller = new ApprovalController();
    const showPanel = vi.fn();
    controller.setUIHooks({ showPanel, hidePanel: vi.fn() });

    controller.attach(sessionOf(broker));
    expect(showPanel).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-1' }));

    controller.respond({ decision: 'approved', scope: 'session', feedback: 'ok' });

    await vi.waitFor(() => {
      expect(broker.decide).toHaveBeenCalledWith('id-1', {
        decision: 'approved',
        scope: 'session',
        feedback: 'ok',
      });
    });
    // Queued same-action pendings inherit a session-scoped approval without
    // surfacing another panel. The user's feedback is not carried over.
    expect(broker.decide).toHaveBeenCalledWith('id-2', { decision: 'approved', scope: 'session' });
    expect(broker.decide).toHaveBeenCalledWith('id-4', { decision: 'approved', scope: 'session' });
    // A different-action pending still waits for an explicit decision.
    expect(showPanel).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-3' }));
    expect(broker.decide).not.toHaveBeenCalledWith('id-3', expect.anything());
  });

  it('does not auto-approve queued pendings when only approved-once is chosen', async () => {
    const broker = makeApprovalBroker([pending('id-1', 'run'), pending('id-2', 'run')]);
    const controller = new ApprovalController();
    const showPanel = vi.fn();
    controller.setUIHooks({ showPanel, hidePanel: vi.fn() });

    controller.attach(sessionOf(broker));
    controller.respond({ decision: 'approved' });

    await vi.waitFor(() => {
      expect(broker.decide).toHaveBeenCalledWith('id-1', { decision: 'approved' });
    });
    // Approve-once is a one-shot decision; the second pending advances to its
    // own panel turn.
    expect(broker.decide).not.toHaveBeenCalledWith('id-2', expect.anything());
    expect(showPanel).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-2' }));
  });

  it('retracts the panel when a pending is resolved externally', async () => {
    const broker = makeApprovalBroker([pending('id-1', 'run'), pending('id-2', 'edit')]);
    const controller = new ApprovalController();
    const showPanel = vi.fn();
    const hidePanel = vi.fn();
    controller.setUIHooks({ showPanel, hidePanel });

    controller.attach(sessionOf(broker));
    expect(showPanel).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-1' }));

    broker.externalResolve('id-1');
    // The active panel is replaced by the next pending without an
    // intervening hide (the modal coordinator swaps owners in place).
    expect(hidePanel).not.toHaveBeenCalled();
    expect(showPanel).toHaveBeenCalledWith(expect.objectContaining({ id: 'id-2' }));
    expect(broker.decide).not.toHaveBeenCalled();
  });

  it('detach retracts the panel without deciding', () => {
    const broker = makeApprovalBroker([pending('id-1', 'run')]);
    const controller = new ApprovalController();
    const hidePanel = vi.fn();
    controller.setUIHooks({ showPanel: vi.fn(), hidePanel });

    const teardown = controller.attach(sessionOf(broker));
    teardown();

    expect(hidePanel).toHaveBeenCalledOnce();
    expect(broker.decide).not.toHaveBeenCalled();
  });

  it('settles the pending as cancelled when the panel path throws', async () => {
    const broker = makeApprovalBroker([pending('id-1', 'run')]);
    const controller = new ApprovalController();
    controller.setUIHooks({
      showPanel: () => {
        throw new Error('render boom');
      },
      hidePanel: vi.fn(),
    });

    controller.attach(sessionOf(broker));

    await vi.waitFor(() => {
      expect(broker.decide).toHaveBeenCalledWith('id-1', {
        decision: 'cancelled',
        feedback: 'Approval UI failed: render boom',
      });
    });
  });
});
