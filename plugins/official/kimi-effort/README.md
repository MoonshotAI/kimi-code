# kimi-effort Plugin

`kimi-effort` is a Kimi Code CLI plugin designed to automatically detect the reasoning and thinking effort capabilities of third-party provider models (such as OpenAI, Anthropic, Google GenAI, OpenRouter, and custom endpoints) and provide seamless adjustment via the `/effort` command.

Rather than relying purely on hardcoded rules, `kimi-effort` combines active live API probing with intelligent heuristics to inspect provider models, write detected capabilities into your `~/.kimi-code/config.toml`, and allow real-time tuning of thinking budgets and effort levels.

---

## Features

- **Live Capability Probing**:
  - Probes OpenAI-compatible endpoints with `reasoning_effort` (`low`, `medium`, `high`) or checks model metadata (e.g. OpenRouter supported parameters).
  - Probes Anthropic endpoints with `thinking` parameters (`budget_tokens`), mapping to standard levels (`low`, `medium`, `high`, `max`).
  - Probes Google GenAI endpoints with `thinkingConfig` (`thinking_budget`), mapping to (`low`, `high`).
- **Intelligent Heuristics Sniffing**:
  - Automatically identifies model families (e.g. `o1`, `o3`, `gpt-5`, `claude-3-7`, `gemini-2.5`, `deepseek-r1`, `qwq`) when network probing is unavailable or inconclusive.
  - Correctly marks non-reasoning models (e.g. `gpt-4o`, `claude-3-5-haiku`) as non-thinking models.
- **Seamless `/effort` Commands & Skill**:
  - Run `/effort` to view current model thinking status and valid effort levels.
  - Run `/effort <level>` to quickly switch between `low`, `medium`, `high`, `max`.
  - Run `/effort detect` or `/effort probe` to run capability detection on your models.
  - Run `/effort list` to inspect all configured models at a glance.
- **Preserves Configuration**:
  - Intelligently updates `~/.kimi-code/config.toml` while preserving comments, indentation, structure, and existing settings.
- **SessionStart Lifecycle Hook**:
  - Automatically checks if your active model has reasoning effort configuration when a session starts, sniffing and setting capabilities in the background without blocking your workflow.

---

## Directory Structure

```text
kimi-effort/
├── kimi.plugin.json           # Plugin manifest (name, skills, commands, hooks)
├── README.md                  # Plugin documentation
├── commands/
│   └── effort.md              # Slash command mapping /effort -> skill
├── hooks/
│   └── session-start.mjs      # Fail-open SessionStart lifecycle hook
├── scripts/
│   ├── config-manager.mjs     # Safe parser and editor for config.toml
│   ├── effort-detector.mjs    # Live API prober and heuristic detector
│   └── effort-cli.mjs         # CLI tool for status, detect, set, and list
└── skills/
    └── effort/
        └── SKILL.md           # Kimi Code agent skill for /effort
```

---

## Installation

### Method 1: Local Plugin Installation via CLI

Run the `/plugins` command inside Kimi Code CLI:

```bash
/plugins install C:/Users/weo/plugins/kimi-effort
```

Or copy the directory to the managed plugins path:

```bash
mkdir -p ~/.kimi-code/plugins/managed/effort
cp -r C:/Users/weo/plugins/kimi-effort/* ~/.kimi-code/plugins/managed/effort/
```

After installation, reload your session:

```bash
/reload
```

---

## Usage

### 1. View Current Effort Status
Type `/effort` or `/effort status`:
```bash
/effort
```
Outputs the active model, provider, thinking status, current effort level, and supported options. If the active model has not been inspected yet, detection is triggered automatically.

### 2. Adjust Effort Level
Pass the desired effort level directly to `/effort`:
```bash
/effort low
/effort medium
/effort high
/effort max
```
The plugin validates the requested level against the model's supported choices, updates `config.toml`, and reminds you if a `/reload` is recommended.

You can also specify a target model alias:
```bash
/effort high openai/gpt-5.6-sol
```

### 3. Detect / Re-probe Models
Force re-detection using live API probes and heuristics:
```bash
/effort detect
# or probe all configured models:
/effort detect all
# or detect a specific model:
/effort detect google/gemini-3.8-flash
```

### 4. List All Configured Models
View all configured models and their reasoning capabilities:
```bash
/effort list
```

---

## CLI Runner Direct Invocation

You can also execute the standalone CLI runner directly with Node.js:

```bash
node scripts/effort-cli.mjs status
node scripts/effort-cli.mjs detect all
node scripts/effort-cli.mjs set high
node scripts/effort-cli.mjs list
```

---

## Supported Reasoning Levels by Model Family

| Model Family | Detected Effort Options | Default Effort |
| --- | --- | --- |
| **OpenAI o1 / o3 / GPT-5 / GPT-6** | `low`, `medium`, `high` | `medium` / `high` |
| **Anthropic Claude 3.7 / Opus 4** | `low`, `medium`, `high`, `max` | `high` |
| **Google Gemini 2.0 Flash / 2.5 / 3.x** | `low`, `high` | `high` |
| **DeepSeek R1 / QwQ** | `default`, `high` | `high` |
| **Standard Non-Reasoning Models** | *(none / unsupported)* | *(none)* |

---

## License

MIT
