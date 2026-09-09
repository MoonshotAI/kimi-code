# kimi-effort Plugin

`kimi-effort` is a Kimi Code CLI plugin designed to automatically detect the reasoning and thinking effort capabilities of third-party provider models (such as `google/gemini-3.8-flash`, `openai/gpt-5.6-sol`, `openai/gpt-6-astra`, `cpa-claude/claude-opus-4-8`, `claude-opus-4-8`) and provide seamless adjustment via the `/effort` command.

Rather than relying purely on hardcoded rules, `kimi-effort` combines active live API probing with intelligent heuristics to inspect provider models, write detected capabilities into your `~/.kimi-code/config.toml`, and allow real-time tuning of thinking budgets and effort levels.

---

## Features

- **Live Capability Probing**:
  - Probes OpenAI-compatible endpoints with `reasoning_effort` (`low`, `medium`, `high`) or checks model metadata (e.g. verified on `openai/gpt-5.6-sol` and `google/gemini-3.8-flash`).
  - Probes Anthropic endpoints with `thinking` parameters (`budget_tokens`), mapping to standard levels (`low`, `medium`, `high`, `max`) (e.g. verified on `cpa-claude/claude-opus-4-8`).
  - Probes Google GenAI endpoints with `thinkingConfig` (`thinking_budget`), mapping to (`low`, `high`).
- **Intelligent Heuristics Sniffing**:
  - Automatically identifies model families (e.g. `gpt-5.6-sol`, `gpt-6-astra`, `claude-opus-4-8`, `gemini-3.8-flash`, `deepseek-r1`) when network probing is unavailable or inconclusive.
  - Correctly marks non-reasoning models (e.g. `openrouter/minimax/minimax-m3:free`) as non-thinking models.
- **Seamless `/effort` Commands & Skill**:
  - Run `/effort` to view current model (`google/gemini-3.8-flash`) thinking status and valid effort levels.
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

### Method 1: Install from GitHub (Recommended)

Run the `/plugins install` command inside Kimi Code CLI:

```bash
/plugins install https://github.com/WENGENG-boop/kimi-effort-plugin
```

### Method 2: Local Plugin Installation via CLI

Run `/plugins install` with your local directory path:

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

## Usage Examples

### 1. View Current Effort Status
Type `/effort` or `/effort status`:
```bash
/effort
```
Outputs the active model, provider, thinking status, current effort level, and supported options. If the active model has not been inspected yet, detection is triggered automatically.

**Example Output:**
```text
=== Kimi Code Reasoning Effort Status ===

   Config File:     C:\Users\weo\.kimi-code\config.toml
   Model Alias:     google/gemini-3.8-flash (default_model)
   Actual Model:    gemini-3.8-flash
   Provider:        google [openai]
   Thinking State:  Enabled (Capability: Supported)
   Current Effort:  medium (model default)
   Supported Levels:[ low, medium, high ]
```

### 2. Adjust Effort Level
Pass the desired effort level directly to `/effort`:
```bash
# Adjust effort for active model (e.g. google/gemini-3.8-flash)
/effort high
/effort low

# Or explicitly target a configured model:
/effort high openai/gpt-5.6-sol
/effort low openai/gpt-6-astra
/effort max cpa-claude/claude-opus-4-8
```
The plugin validates the requested level against the model's supported choices, updates `config.toml`, and reminds you if a `/reload` is recommended.

### 3. Detect / Re-probe Models
Force re-detection using live API probes and heuristics:
```bash
# Probe active model:
/effort detect

# Probe a specific model:
/effort detect openai/gpt-5.6-sol

# Probe all configured models at once:
/effort detect all
```

**Real Detection Results on Configured Models:**

| Model Alias | Provider | Reasoning Model | Supported Efforts | Default Effort | Detection Method |
|---|---|---|---|---|---|
| `google/gemini-3.8-flash` | `google` | Yes | `[low, medium, high]` | `medium` | Live API Probe |
| `openai/gpt-5.6-sol` | `openai` | Yes | `[low, medium, high]` | `medium` | Live API Probe |
| `openai/gpt-6-astra` | `openai` | Yes | `[low, medium, high]` | `medium` | Heuristics |
| `cpa-claude/claude-opus-4-8` | `cpa-claude` | Yes | `[low, medium, high, max]` | `high` | Live API Probe |
| `claude-opus-4-8` | `custom` | Yes | `[low, medium, high]` | `medium` | Live API Probe |
| `openrouter/minimax/minimax-m3:free` | `openrouter` | No | `[]` | *(none)* | Heuristics |

### 4. List All Configured Models
View all configured models and their reasoning capabilities:
```bash
/effort list
```

---

## CLI Runner Direct Invocation

You can also execute the standalone CLI runner directly with Node.js:

```bash
# Check status of active or specific model
node scripts/effort-cli.mjs status
node scripts/effort-cli.mjs status openai/gpt-5.6-sol

# Probe all configured models and update config.toml
node scripts/effort-cli.mjs detect all

# Set thinking effort
node scripts/effort-cli.mjs set high
node scripts/effort-cli.mjs set max cpa-claude/claude-opus-4-8

# List all models
node scripts/effort-cli.mjs list
```

---

## Supported Reasoning Levels by Model Family

| Model Family / Example | Detected Effort Options | Default Effort | Detection Method |
| --- | --- | --- | --- |
| **OpenAI GPT-5.6 Sol (`gpt-5.6-sol`)** | `low`, `medium`, `high` | `medium` | Live API Probe / Heuristic |
| **OpenAI GPT-6 Astra (`gpt-6-astra`)** | `low`, `medium`, `high` | `medium` | Heuristic / Live API Probe |
| **Anthropic Claude Opus 4.8 (`claude-opus-4-8`)** | `low`, `medium`, `high`, `max` | `high` | Live API Probe / Heuristic |
| **Google Gemini 3.8 Flash (`gemini-3.8-flash`)** | `low`, `medium`, `high` | `medium` | Live API Probe / Heuristic |
| **DeepSeek R1 (`deepseek-r1`)** | `default`, `high` | `high` | Heuristic / Metadata |
| **Non-Reasoning Models (`minimax-m3:free`)** | *(none / unsupported)* | *(none)* | Catalog / Heuristic |

---

## Frequently Asked Questions (FAQ)

### Q: Why doesn't `/effort` in the TUI show the new model's effort levels (e.g. `max`) after switching models?

**A:** This is due to how Kimi Code CLI caches configuration in memory:
1. When you launch Kimi Code, it reads `config.toml` into memory (`availableModels`).
2. When you switch models (via `/model`) or when the plugin detects/updates `support_efforts` in `config.toml`, the active TUI session retains the previously loaded in-memory model specifications until refreshed.
3. **Solution:** Simply type **`/reload`** in Kimi Code. This tells Kimi Code to re-read `config.toml` from disk, instantly updating the in-memory `/effort` picker with the newly active model's full set of effort options (such as `max`).
4. **Model Alias Verification:** Also check if you have multiple aliases configured for the same model. For example, if you configured both `claude-opus-4-8` under an OpenAI proxy (which only supports `[low, medium, high]`) and `cpa-claude/claude-opus-4-8` under native Anthropic (which supports `[low, medium, high, max]`), ensure you selected the Anthropic-backed alias (`cpa-claude/claude-opus-4-8`).

---

## License

MIT
