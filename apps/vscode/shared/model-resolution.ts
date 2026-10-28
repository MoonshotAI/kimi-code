import type { ModelConfig, ThinkingMode } from "./legacy-sdk";

export interface MediaRequirements {
  image: boolean;
  video: boolean;
}

/** Metadata-driven only; mirrors the TUI's thinkingAvailability rules. */
export function getModelThinkingMode(model: ModelConfig): ThinkingMode {
  if ((model.support_efforts?.length ?? 0) > 0) {
    return "effort";
  }
  if (model.capabilities.includes("always_thinking")) {
    return "always";
  }
  if (model.capabilities.includes("thinking") || model.adaptive_thinking === true) {
    return "switch";
  }
  return "none";
}

export function defaultEffortForModel(model: ModelConfig, defaultThinking: boolean, configuredEffort?: string): string {
  const mode = getModelThinkingMode(model);
  if (mode === "none") return "off";
  const efforts = model.support_efforts ?? [];
  if (efforts.length > 0) {
    const alwaysOn = model.capabilities.includes("always_thinking");
    if (!defaultThinking && !alwaysOn) return "off";
    if (configuredEffort && efforts.includes(configuredEffort)) return configuredEffort;
    if (model.default_effort && efforts.includes(model.default_effort)) return model.default_effort;
    return efforts[Math.floor(efforts.length / 2)] ?? "off";
  }
  if (mode === "always") return "on";
  return defaultThinking ? "on" : "off";
}

export function supportsThinkingEffort(model: ModelConfig, effort: string): boolean {
  if (model.strict_thinking_validation !== true) return true;
  const mode = getModelThinkingMode(model);
  if (mode === "none") return effort === "off";
  if (mode === "switch") return effort === "off" || effort === "on";
  if (mode === "always") return effort === "on";
  if (effort === "off") return !model.capabilities.includes("always_thinking");
  return effort !== "on" && (model.support_efforts ?? []).includes(effort);
}

export function isImageModel(model: ModelConfig): boolean {
  return model.capabilities.includes("image_in");
}

export function isVideoModel(model: ModelConfig): boolean {
  return model.capabilities.includes("video_in");
}

export function getModelById(models: ModelConfig[], id: string): ModelConfig | undefined {
  return models.find((m) => m.id === id);
}

export function getModelsForMedia(models: ModelConfig[], mediaReq: MediaRequirements): ModelConfig[] {
  return models.filter((m) => {
    if (mediaReq.image && !isImageModel(m)) {
      return false;
    }
    if (mediaReq.video && !isVideoModel(m)) {
      return false;
    }
    return true;
  });
}

export function resolveSendModel(
  models: ModelConfig[],
  currentModel: string,
  defaultModel: string | null,
  mediaReq?: MediaRequirements,
): ModelConfig | undefined {
  const candidates = mediaReq === undefined ? models : getModelsForMedia(models, mediaReq);
  return getModelById(candidates, currentModel) ?? getModelById(candidates, defaultModel ?? "");
}

export function resolveThinkingEffortForSend(
  model: ModelConfig,
  currentEffort: string,
  defaultThinking: boolean,
  defaultThinkingEffort?: string,
): string {
  return supportsThinkingEffort(model, currentEffort)
    ? currentEffort
    : defaultEffortForModel(model, defaultThinking, defaultThinkingEffort);
}
