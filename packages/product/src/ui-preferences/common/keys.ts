export const UI_PREFERENCE_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export const UI_PREFERENCE_VALUE_MAX_BYTES = 64 * 1024;

export const UI_PREFERENCES_DOCUMENT_MAX_BYTES = 1024 * 1024;

export type UiPreferenceMerge = 'scalar' | 'set' | 'ordered' | 'flag' | 'map';

export interface UiPreferenceDefinition {
  readonly merge: UiPreferenceMerge;
}

export const UI_PREFERENCE_KEYS = {
  sidebarPinnedSessions: 'sidebar.pinned_sessions',
  sidebarPinnedWorkspaces: 'sidebar.pinned_workspaces',
  sidebarPinnedOrder: 'sidebar.pinned_order',
  sidebarWorkspaceOrder: 'sidebar.workspace_order',
  sidebarWorkspaceSort: 'sidebar.workspace_sort',
  sidebarWorkspaceRecencyFloor: 'sidebar.workspace_recency_floor',
  sidebarHiddenWorkspaceIds: 'sidebar.hidden_workspace_ids',
  sidebarCollapsedWorkspaces: 'sidebar.collapsed_workspaces',
  sidebarPinnedCollapsed: 'sidebar.pinned_collapsed',
  sidebarSessionsSectionCollapsed: 'sidebar.sessions_section_collapsed',
  sidebarPinnedSessionDisplayMode: 'sidebar.pinned_session_display_mode',
  sidebarViewMode: 'sidebar.view_mode',
  onboardingCompleted: 'onboarding.completed',
} as const;

export type UiPreferenceKey = (typeof UI_PREFERENCE_KEYS)[keyof typeof UI_PREFERENCE_KEYS];

export const UI_PREFERENCE_DEFINITIONS: Readonly<Record<UiPreferenceKey, UiPreferenceDefinition>> = {
  'sidebar.pinned_sessions': { merge: 'set' },
  'sidebar.pinned_workspaces': { merge: 'set' },
  'sidebar.pinned_order': { merge: 'ordered' },
  'sidebar.workspace_order': { merge: 'ordered' },
  'sidebar.workspace_sort': { merge: 'scalar' },
  'sidebar.workspace_recency_floor': { merge: 'map' },
  'sidebar.hidden_workspace_ids': { merge: 'set' },
  'sidebar.collapsed_workspaces': { merge: 'set' },
  'sidebar.pinned_collapsed': { merge: 'scalar' },
  'sidebar.sessions_section_collapsed': { merge: 'scalar' },
  'sidebar.pinned_session_display_mode': { merge: 'scalar' },
  'sidebar.view_mode': { merge: 'scalar' },
  'onboarding.completed': { merge: 'flag' },
};

const SCALAR: UiPreferenceDefinition = { merge: 'scalar' };

export function uiPreferenceDefinition(key: string): UiPreferenceDefinition {
  return (UI_PREFERENCE_DEFINITIONS as Readonly<Record<string, UiPreferenceDefinition>>)[key] ?? SCALAR;
}

export function isUiPreferenceKey(key: string): boolean {
  return UI_PREFERENCE_KEY_PATTERN.test(key);
}
