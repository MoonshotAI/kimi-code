---
name: effort
description: Inspect, automatically detect, or adjust the reasoning/thinking effort level for models in Kimi Code CLI
type: prompt
whenToUse: When the user asks to check, change, or set reasoning/thinking effort (e.g. /effort, /effort high, /effort detect, /effort list), or when configuring third-party model thinking parameters
disableModelInvocation: false
arguments:
  - action
  - target
---

# Effort - Reasoning & Thinking Effort Manager for Kimi Code

This skill manages reasoning and thinking effort levels (such as `low`, `medium`, `high`, `max`) for third-party provider models configured in Kimi Code CLI (`config.toml`).

Invocation argument string: `$ARGUMENTS`
First argument: `$action`
Second argument: `$target`

---

## Instructions for Kimi Code

When this skill is invoked, execute the appropriate sub-command using `Bash` to run the plugin CLI runner script:
```bash
node "${KIMI_SKILL_DIR}/../../scripts/effort-cli.mjs" <command>
```
*(Fallback path if `${KIMI_SKILL_DIR}` is not expanded: `C:/Users/weo/plugins/kimi-effort/scripts/effort-cli.mjs` or `~/.kimi-code/plugins/managed/effort/scripts/effort-cli.mjs`)*

Follow the command mapping below based on `$ARGUMENTS`:

### 1. Show Status / Auto-detect (`/effort` without arguments, or `/effort status [model]`)
- **Condition**: `$ARGUMENTS` is empty, or starts with `status`.
- **Action**:
  1. Run:
     ```bash
     node "C:/Users/weo/plugins/kimi-effort/scripts/effort-cli.mjs" status $target
     ```
  2. If the output indicates that `support_efforts` is not yet detected or configured for the active model:
     - Automatically run detection:
       ```bash
       node "C:/Users/weo/plugins/kimi-effort/scripts/effort-cli.mjs" detect
       ```
     - Re-run `status` to get the updated configuration.
  3. Present the result cleanly in Markdown:
     - **Active Model** and **Provider**
     - **Thinking Enabled**: Yes / No
     - **Current Effort Level**: (e.g. `high`)
     - **Supported Effort Levels**: (e.g. `low`, `medium`, `high`, `max`)
     - If non-reasoning model: explain that this model does not support thinking parameters.
     - Provide actionable hints on how to adjust (e.g. `/effort low`, `/effort high`).

### 2. Set Effort Level (`/effort <level> [model]`)
- **Condition**: The first argument is an effort level: `low`, `medium`, `high`, `max`, `default`, `min`, or numeric value.
- **Action**:
  1. Run:
     ```bash
     node "C:/Users/weo/plugins/kimi-effort/scripts/effort-cli.mjs" set "$action" $target
     ```
  2. If the effort level is invalid or unsupported for that model:
     - Inform the user of valid choices for that model.
  3. If successful:
     - Confirm the updated effort level.
     - Remind the user: if needed, reload configuration via `/reload` or restart the session for settings to take full effect in the active provider client.

### 3. Force Re-detect / Probe (`/effort detect [model|all]` or `/effort probe [model|all]`)
- **Condition**: `$action` is `detect` or `probe`.
- **Action**:
  1. Determine target: `$target` or `"all"` if none specified.
  2. Run:
     ```bash
     node "C:/Users/weo/plugins/kimi-effort/scripts/effort-cli.mjs" detect $target
     ```
  3. Render a Markdown summary table of detected models:
     | Model Alias | Provider | Reasoning Model | Supported Efforts | Default Effort | Detection Method |
     | ----------- | -------- | --------------- | ----------------- | -------------- | ---------------- |
  4. Explain whether live API probing or heuristic analysis was used.

### 4. List All Models (`/effort list`)
- **Condition**: `$action` is `list`.
- **Action**:
  1. Run:
     ```bash
     node "C:/Users/weo/plugins/kimi-effort/scripts/effort-cli.mjs" list
     ```
  2. Format and render the model list and their reasoning capabilities in a neat Markdown table.

---

## Output Guidelines
- Keep responses compact, clean, and well-structured in Markdown.
- Always cite the active model alias and the affected `config.toml` file when changes are made.
- If an error occurs (such as invalid TOML syntax or unreachable network probe), clearly explain the root cause and provide troubleshooting steps.
