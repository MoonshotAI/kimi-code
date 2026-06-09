import * as fs from "node:fs";
import * as toml from "toml";
import { z } from "zod/v3";
import { KimiPaths } from "./paths";
import type { KimiConfig, ModelConfig } from "./schema";

// ============================================================================
// Config Schema
// ============================================================================

const LLMProviderSchema = z.object({
  type: z.string(),
  base_url: z.string().optional(),
  api_key: z.string().optional(),
  env: z.record(z.string()).optional(),
  custom_headers: z.record(z.string()).optional(),
}).passthrough();

const LLMModelSchema = z.object({
  provider: z.string(),
  model: z.string(),
  max_context_size: z.number().int().positive(),
  capabilities: z.array(z.string()).optional(),
  display_name: z.string().optional(),
}).passthrough();

const LoopControlSchema = z.object({
  max_steps_per_turn: z.number().int().min(1).default(100),
  max_retries_per_step: z.number().int().min(1).default(3),
  max_ralph_iterations: z.number().int().min(-1).default(0),
});

const MoonshotSearchConfigSchema = z.object({
  base_url: z.string(),
  api_key: z.string(),
  custom_headers: z.record(z.string()).optional(),
});

const MoonshotFetchConfigSchema = z.object({
  base_url: z.string(),
  api_key: z.string(),
  custom_headers: z.record(z.string()).optional(),
});

const ServicesSchema = z.object({
  moonshot_search: MoonshotSearchConfigSchema.optional(),
  moonshot_fetch: MoonshotFetchConfigSchema.optional(),
});

const MCPClientConfigSchema = z.object({
  tool_call_timeout_ms: z.number().int().positive().default(60000),
});

const MCPConfigSchema = z.object({
  client: MCPClientConfigSchema.default({}),
});

const ConfigSchema = z.object({
  default_model: z.string().default(""),
  default_thinking: z.union([z.boolean(), z.enum(["on", "off"])]).default(false),
  models: z.record(LLMModelSchema).default({}),
  providers: z.record(LLMProviderSchema).default({}),
  loop_control: LoopControlSchema.partial().default({}),
  services: ServicesSchema.default({}),
  mcp: MCPConfigSchema.partial().default({}),
}).passthrough();

type Config = z.infer<typeof ConfigSchema>;

// Config Parsing
export function parseConfig(): KimiConfig {
  if (!fs.existsSync(KimiPaths.config)) {
    return { defaultModel: null, defaultThinking: false, models: [] };
  }

  try {
    const raw = toml.parse(fs.readFileSync(KimiPaths.config, "utf-8"));
    const config = ConfigSchema.parse(raw);
    return toKimiConfig(config);
  } catch (err) {
    console.warn("[config] Failed to parse config.toml:", err);
    return { defaultModel: null, defaultThinking: false, models: [] };
  }
}

function toKimiConfig(config: Config): KimiConfig {
  const models: ModelConfig[] = Object.entries(config.models).map(([id, model]) => ({
    id,
    name: model.display_name || id,
    capabilities: model.capabilities ?? [],
  }));

  models.sort((a, b) => a.name.localeCompare(b.name));

  return {
    defaultModel: config.default_model || null,
    defaultThinking: config.default_thinking === true || config.default_thinking === "on",
    models,
  };
}

// Config Saving
// This is deliberately simple and only handles the default_model setting.
// Otherwise the toml lib will change the format / default values.
export function saveDefaultModel(modelId: string, thinking?: boolean): void {
  const configPath = KimiPaths.config;

  if (!fs.existsSync(configPath)) {
    let content = `default_model = "${modelId}"\n`;
    if (thinking !== undefined) {
      content += `default_thinking = ${thinking ? "true" : "false"}\n`;
    }
    fs.writeFileSync(configPath, content, "utf-8");
    return;
  }

  let content = fs.readFileSync(configPath, "utf-8");

  // Update default_model
  const modelRegex = /^default_model\s*=\s*"[^"]*"/m;

  if (modelRegex.test(content)) {
    content = content.replace(modelRegex, `default_model = "${modelId}"`);
  } else {
    content = `default_model = "${modelId}"\n` + content;
  }

  // Update default_thinking if provided.
  // The kernel only accepts a BOOLEAN (`default_thinking: z.boolean()`) and the
  // CLI writes `default_thinking = true`. Match any existing assignment —
  // boolean OR a legacy quoted "on"/"off" — and replace it in place. Matching
  // only the quoted form would miss the boolean line and append a SECOND
  // `default_thinking`, producing invalid TOML (redefinition) that breaks the CLI.
  if (thinking !== undefined) {
    const thinkingValue = thinking ? "true" : "false";
    const thinkingRegex = /^default_thinking\s*=\s*.+$/m;
    if (thinkingRegex.test(content)) {
      content = content.replace(thinkingRegex, `default_thinking = ${thinkingValue}`);
    } else {
      // Insert after default_model
      content = content.replace(/^(default_model\s*=\s*"[^"]*")/m, `$1\ndefault_thinking = ${thinkingValue}`);
    }
  }

  fs.writeFileSync(configPath, content, "utf-8");
}

// Model Utilities
export function getModelById(models: ModelConfig[], modelId: string): ModelConfig | undefined {
  return models.find((m) => m.id === modelId);
}

export type ThinkingMode = "none" | "switch" | "always";

export function getModelThinkingMode(model: ModelConfig): ThinkingMode {
  if (model.capabilities.includes("always_thinking")) {
    return "always";
  }
  if (model.capabilities.includes("thinking")) {
    return "switch";
  }
  return "none";
}

export function isModelThinking(models: ModelConfig[], modelId: string): boolean {
  const model = getModelById(models, modelId);
  if (!model) {
    return false;
  }
  const mode = getModelThinkingMode(model);
  return mode === "always" || mode === "switch";
}
