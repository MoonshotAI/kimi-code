// apps/kimi-web/src/components/sidebarVmTypes.ts
// View-model aggregate for Sidebar. These mirror the component's previous
// individual props one-for-one so the refactor is purely structural (no type or
// behavior changes). The `colWidth` layout prop is intentionally kept separate
// since it comes from local resize state, not the Kimi web client.
import type { Session, WorkspaceGroup, WorkspaceView } from '../types';

export interface SidebarVm {
  activeWorkspace: WorkspaceView | null;
  activeWorkspaceId: string | null;
  sessions: Session[];
  groups: WorkspaceGroup[];
  activeId: string;
  attentionBySession: Record<string, number>;
  pendingBySession: Record<string, { approvals: number; questions: number }>;
  unreadBySession: Record<string, boolean>;
}
