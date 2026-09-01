# Feature Specification: Fuck Permissions Mode

**Feature Branch**: `830-fuck-permissions`

**Created**: 2026-09-01

**Status**: Draft

**Input**: User description: "When on auto mode there are some restrictions. This Bash command could not be analyzed and is blocked in auto permission mode. Rewrite it with a literal command name and arguments, or ask the user to run it themselves. add a new mode /fuck-permissions that runs an auto mode with ALL RESTRICTIONS LIFTED."

---

## Summary

Add a `/fuck-permissions` slash command that activates a permission mode where every restriction enforced by auto mode is lifted: no dangerous-command denials, no unanalyzable-command denials, no `AskUserQuestion` denials — everything is auto-approved. This is auto mode with the safety guardrails removed.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Activate fuck-permissions mode (Priority: P1)

A user is in auto permission mode and hits a bash command that is blocked as "dangerous" or "could not be analyzed." They want to override all restrictions for the current session without switching to yolo mode.

**Why this priority**: The primary motivation — unblocking commands that auto mode would deny.

**Independent Test**: Run `/fuck-permissions`, then attempt a command that auto mode would block (e.g., an unanalyzable bash command), and confirm it is auto-approved instead of denied.

**Acceptance Scenarios**:

1. **Given** the user runs `/fuck-permissions`, **When** the mode activates, **Then** all permission checks that were denied in auto mode are now auto-approved.
2. **Given** `/fuck-permissions` is active, **When** an unanalyzable bash command is issued, **Then** it is approved rather than blocked with the "could not be analyzed" message.
3. **Given** `/fuck-permissions` is active, **When** a dangerous bash command is issued, **Then** it is approved rather than blocked with the "blocked in auto permission mode" message.

---

### User Story 2 - AskUserQuestion is allowed (Priority: P2)

A user wants to use `AskUserQuestion` while in the unrestricted mode.

**Why this priority**: Auto mode denies `AskUserQuestion`; fuck-permissions lifts that restriction too.

**Acceptance Scenarios**:

1. **Given** `/fuck-permissions` is active, **When** `AskUserQuestion` is called, **Then** it is allowed instead of being denied with "AskUserQuestion is disabled while auto permission mode is active."

---

### User Story 3 - Deactivate and return to previous mode (Priority: P2)

A user wants to turn off fuck-permissions mode and return to whatever mode was active before.

**Why this priority**: Users need a way to exit the unrestricted mode and restore safety guardrails.

**Acceptance Scenarios**:

1. **Given** `/fuck-permissions` was just activated, **When** the user switches back to auto mode, **Then** all the auto-mode restrictions are restored (dangerous commands denied again, AskUserQuestion denied again).
2. **Given** `/fuck-permissions` is active, **When** the user switches to yolo or manual mode, **Then** the unrestricted behavior stops and the new mode's rules take over.

---

### User Story 4 - Session-persistent mode selection (Priority: P3)

The mode selection should persist so that a new session inherits the last-selected mode.

**Why this priority**: Consistency with how other mode selections (permission mode, model, etc.) persist.

**Acceptance Scenarios**:

1. **Given** `/fuck-permissions` is set, **When** a new session starts, **Then** the mode is remembered and applied.

---

### Edge Cases

- If `/fuck-permissions` is called while already in fuck-permissions mode, it should be idempotent (no error, same state).
- Switching from `/fuck-permissions` to `/model` or `/permission` should work seamlessly — the new mode overrides.
- The mode indicator in the TUI status bar should clearly show `fuck-permissions` so the user knows restrictions are lifted.
- `/fuck-permissions` should NOT be the default mode — the user must explicitly opt in.

---

## Requirements *(mandatory)*

- **FR-001**: The system MUST add a new permission mode `'fuck'` alongside `'manual'`, `'auto'`, and `'yolo'`.
- **FR-002**: The `/fuck-permissions` slash command MUST set the permission mode to `'fuck'`.
- **FR-003**: When `'fuck'` mode is active, ALL permission policies that normally deny in `'auto'` mode MUST instead approve or skip.
- **FR-004**: Dangerous commands (e.g., `rm -rf`, `mkfs`, `systemctl reboot`) MUST be auto-approved in `'fuck'` mode instead of denied.
- **FR-005**: Unanalyzable commands (bash commands the parser cannot analyze) MUST be auto-approved in `'fuck'` mode instead of denied.
- **FR-006**: `AskUserQuestion` calls MUST be allowed in `'fuck'` mode instead of denied.
- **FR-007**: The `/fuck-permissions` command MUST display a clear status message indicating the unrestricted mode is active.
- **FR-008**: The status bar MUST display the current mode (e.g., `fuck-permissions`) so the user is aware restrictions are lifted.
- **FR-009**: The mode MUST persist across sessions (stored in `defaultPermissionMode` config section).
- **FR-010**: The `/fuck-permissions` command MUST be available via Tab autocompletion.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `/fuck-permissions` activates within 1 second from invocation to status display.
- **SC-002**: Every command that was previously denied in auto mode is auto-approved in fuck-permissions mode (0 denials).
- **SC-003**: The mode persists across session restarts (read back from `defaultPermissionMode` config).
- **SC-004**: Switching from auto mode to fuck-permissions and back does not break any existing policy behavior.
- **SC-005**: No existing permission policies are removed or modified — only a new mode and new policy are added.
- **SC-006**: The status bar clearly displays the active mode at all times.

---

## Assumptions

- The permission mode type (`PermissionMode`) is currently `'manual' | 'auto' | 'yolo'`; a new `'fuck'` value must be added to the type and the config schema.
- The `DefaultPermissionModeSchema` currently only allows `['manual', 'auto', 'yolo']`; it must be extended to include `'fuck'`.
- A new permission policy service is needed for `'fuck'` mode that mirrors `AutoModeApprovePermissionPolicyService` but does NOT deny dangerous commands, unanalyzable commands, or `AskUserQuestion`.
- The `DangerousCommandAskPermissionPolicyService` checks `this.modeService.mode === 'auto'` to decide whether to deny; it must also skip denial when mode is `'fuck'`.
- The `AutoModeAskUserQuestionDenyPermissionPolicyService` checks `this.modeService.mode !== 'auto'` to skip; it must also skip denial when mode is `'fuck'`.
- The slash command registration follows the existing pattern in `apps/kimi-code/src/tui/commands/config.ts`.
- The config section `defaultPermissionMode` stores the selected mode and persists it to `config.toml`.

---

## Notes

- This feature adds a new permission mode and a new slash command. It does NOT modify existing policy logic for auto or yolo modes — only adds a new code path for `'fuck'` mode.
- The `DangerousCommandAskPermissionPolicyService` is the key file: it currently branches on `mode === 'auto'` to deny dangerous and unanalyzable commands. In `'fuck'` mode, it must skip those denials entirely.
- The `AutoModeAskUserQuestionDenyPermissionPolicyService` similarly branches on `mode === 'auto'` to deny `AskUserQuestion`. In `'fuck'` mode, it must also skip.
- The new `'fuck'` policy should auto-approve everything, like `AutoModeApprovePermissionPolicyService`, but without the restrictive side policies active for `'fuck'`.
- The TUI status bar should display the mode name so the user is aware they are running unrestricted.
- This is a safety-critical feature — the spec should make clear that the user is explicitly opting into running without restrictions.
