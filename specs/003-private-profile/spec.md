# Feature Specification: Private Profile

**Feature Branch**: `827-private-profile`

**Created**: 2026-08-27

**Status**: Draft

**Input**: User description: "add a private profile feature, extremely simple visible on the tui just like our custom favorites, a new tab Private, which has model,secondarymodel,squeezemodel,visionmodel, set exclusively and run only on those, it is more like a session specific models with a preset, so be pragmatic, logic implementation should require minimal change, when I toggle private mode on, it will appy those settings session only so it will not globally override the secondarymodel,squuezemodel,visionmodel."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Configure Private Profile (Priority: P1)

As a user, I want to set up a private profile that defines four model slots (primary, secondary, squeeze, vision) that I can quickly apply to any session without affecting global defaults.

**Why this priority**: This is the core capability that enables the entire feature. Without the ability to configure the private profile, the feature has no value.

**Independent Test**: Can be fully tested by configuring the four model slots via the Private tab and verifying they are saved persistently. Delivers the value of having a reusable preset.

**Acceptance Scenarios**:

1. **Given** the user opens the model selector dialog, **When** they navigate to the "Private" tab, **Then** they see four distinct model selection areas: Primary Model, Secondary Model, Squeeze Model, Vision Model.
2. **Given** the user is on the Private tab, **When** they select a model for each slot and confirm, **Then** the private profile is saved to configuration (tui.toml) and persists across sessions.
3. **Given** the user has previously configured a private profile, **When** they open the Private tab again, **Then** the previously selected models are displayed as the current private profile.

---

### User Story 2 - Toggle Private Mode On/Off (Priority: P1)

As a user, I want to toggle private mode on and off, so that I can temporarily apply my private profile to the current session without permanently changing global settings.

**Why this priority**: This is the essential interaction that makes the private profile useful. Without a toggle, the feature would require manual reconfiguration each time.

**Independent Test**: Can be fully tested by toggling private mode on, verifying session uses private models, toggling off, verifying session reverts to global defaults. Delivers the value of session-specific model isolation.

**Acceptance Scenarios**:

1. **Given** the user has a configured private profile, **When** they activate private mode (via slash command or keybinding), **Then** the current session immediately uses the four models from the private profile for all subsequent operations.
2. **Given** private mode is active, **When** the user deactivates private mode, **Then** the current session immediately reverts to using the global default models for primary, secondary, squeeze, and vision.
3. **Given** private mode is active in the current session, **When** the user starts a new session, **Then** the new session starts with private mode inactive.

---

### User Story 3 - Visual Feedback of Private Mode Status (Priority: P2)

As a user, I want clear visual indication of whether private mode is currently active, so I know which model configuration is being used.

**Why this priority**: This provides essential UX feedback to prevent confusion about which models are active.

**Independent Test**: Can be fully tested by observing UI indicators when toggling private mode on/off. Delivers the value of clear status awareness.

**Acceptance Scenarios**:

1. **Given** private mode is inactive, **When** the user views the TUI, **Then** there is no special indication (or a subtle "off" indicator).
2. **Given** private mode is active, **When** the user views the TUI, **Then** there is a visible indicator (e.g., "Private" badge, highlighted tab, or status line) showing private mode is on.

---

### Edge Cases

- What happens when the user tries to activate private mode but hasn't configured a private profile yet?
- What happens when a model in the private profile becomes unavailable (e.g., provider down, model removed)?
- What happens when the user toggles private mode multiple times rapidly?
- What happens when the user tries to configure a private profile while private mode is active?
- What happens when the user starts a session with private mode already active from a previous session?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a "Private" tab in the model selector dialog that displays four model selection areas: Primary Model, Secondary Model, Squeeze Model, Vision Model.
- **FR-002**: System MUST persist the private profile configuration to tui.toml under a `[private_profile]` section, preserving selections across sessions.
- **FR-003**: System MUST provide a mechanism to toggle private mode on/off (slash command `/private` and/or keybinding `Shift+P`).
- **FR-004**: When private mode is activated, System MUST apply the four private profile models to the current session only, overriding global defaults for primary, secondary, squeeze, and vision models.
- **FR-005**: When private mode is deactivated, System MUST revert the session to using global default models for all four model slots.
- **FR-006**: System MUST maintain private mode state per session (session-scoped, not persisted across sessions).
- **FR-007**: System MUST provide visual indication of private mode status (active/inactive) in the TUI.
- **FR-008**: System MUST handle the case where private mode is activated without a configured private profile by opening the Private tab in the model selector dialog and notifying the user to configure the profile; private mode remains inactive until the user completes configuration.
- **FR-009**: System MUST gracefully handle unavailable models in the private profile by falling back to global defaults for those specific slots and notifying the user.
- **FR-010**: System MUST NOT modify global configuration when private mode is activated; changes are session-scoped only.

### Key Entities

- **Private Profile**: A persistent configuration containing four model selections (primary, secondary, squeeze, vision) stored in tui.toml.
- **Private Mode**: A session-scoped boolean state that determines whether the session uses the private profile models or global defaults.
- **Model Slots**: The four distinct model selections within a private profile: Primary, Secondary, Squeeze, Vision.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can configure a private profile in under 2 minutes.
- **SC-002**: Users can toggle private mode on/off with a single action (keybinding or command).
- **SC-003**: When private mode is activated, the session uses the private profile models for all available model slots; unavailable slots fall back to global defaults.
- **SC-004**: When private mode is deactivated, the session reverts to global defaults within 1 second.
- **SC-005**: Private profile configuration persists across application restarts with 100% fidelity.
- **SC-006**: Visual indication of private mode status is immediately apparent to users.
- **SC-007**: The feature requires minimal changes to existing model selection logic (reuses existing session-only selection mechanism).

## Assumptions

- The existing model selector dialog can be extended with a new "Private" tab without major restructuring.
- The existing session-only selection mechanism (`onSessionOnlySelect`) can be extended to support multiple model slots.
- Users understand the concept of "session-only" vs "global" model settings.
- The tui.toml configuration file is the appropriate place to persist private profile settings.
- The feature is scoped to the TUI interface only (no CLI-only changes required).
- The existing model availability checks can be reused to validate private profile models.
- The feature does not require changes to the underlying agent-core or kap-server packages (minimal change requirement).