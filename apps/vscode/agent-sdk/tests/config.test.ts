import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getModelById, getModelThinkingMode, isModelThinking } from "../config";
import type { ModelConfig } from "../schema";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("node:fs", () => fsMock);

function resetFsMock(): void {
  fsMock.existsSync.mockReset();
  fsMock.readFileSync.mockReset();
  fsMock.writeFileSync.mockReset();
}

// ============================================================================
// Test Data
// ============================================================================
const testModels: ModelConfig[] = [
  { id: "kimi-k2", name: "Kimi K2", capabilities: [] },
  { id: "kimi-k2-thinking", name: "Kimi K2 Thinking", capabilities: ["thinking"] },
  { id: "kimi-k2-always", name: "Kimi K2 Always Think", capabilities: ["always_thinking"] },
  { id: "o1-preview", name: "o1-preview", capabilities: ["thinking"] },
  { id: "deepthink-r1", name: "DeepThink R1", capabilities: [] },
  { id: "gpt-4", name: "GPT-4", capabilities: ["image_in"] },
];

// ============================================================================
// getModelById Tests
// ============================================================================
describe("getModelById", () => {
  it("finds model by id", () => {
    const model = getModelById(testModels, "kimi-k2");
    expect(model).toBeDefined();
    expect(model?.name).toBe("Kimi K2");
  });

  it("returns undefined for unknown id", () => {
    const model = getModelById(testModels, "nonexistent");
    expect(model).toBeUndefined();
  });

  it("returns undefined for empty array", () => {
    const model = getModelById([], "kimi-k2");
    expect(model).toBeUndefined();
  });

  it("handles case-sensitive matching", () => {
    const model = getModelById(testModels, "KIMI-K2");
    expect(model).toBeUndefined();
  });
});

// ============================================================================
// getModelThinkingMode Tests
// ============================================================================
describe("getModelThinkingMode", () => {
  it("returns 'none' for model without thinking capability", () => {
    const model: ModelConfig = { id: "basic", name: "Basic Model", capabilities: [] };
    expect(getModelThinkingMode(model)).toBe("none");
  });

  it("returns 'none' for model with only image_in capability", () => {
    const model: ModelConfig = { id: "vision", name: "Vision Model", capabilities: ["image_in"] };
    expect(getModelThinkingMode(model)).toBe("none");
  });

  it("returns 'switch' for model with thinking capability", () => {
    const model: ModelConfig = { id: "smart", name: "Smart Model", capabilities: ["thinking"] };
    expect(getModelThinkingMode(model)).toBe("switch");
  });

  it("returns 'always' for model with always_thinking capability", () => {
    const model: ModelConfig = { id: "always", name: "Always On", capabilities: ["always_thinking"] };
    expect(getModelThinkingMode(model)).toBe("always");
  });

  it("does not infer thinking from model name", () => {
    const models: ModelConfig[] = [
      { id: "1", name: "DeepThink R1", capabilities: [] },
      { id: "2", name: "THINKING MODEL", capabilities: [] },
      { id: "3", name: "some-think-model", capabilities: [] },
    ];
    for (const model of models) {
      expect(getModelThinkingMode(model)).toBe("none");
    }
  });

  it("uses configured capabilities even when model name contains think", () => {
    const model: ModelConfig = { id: "test", name: "Think Model", capabilities: ["thinking"] };
    expect(getModelThinkingMode(model)).toBe("switch");
  });

  it("handles multiple capabilities", () => {
    const model: ModelConfig = {
      id: "multi",
      name: "Multi Model",
      capabilities: ["image_in", "thinking", "video_in"],
    };
    expect(getModelThinkingMode(model)).toBe("switch");
  });
});

// ============================================================================
// isModelThinking Tests
// ============================================================================
describe("isModelThinking", () => {
  it("returns true for model with thinking capability", () => {
    expect(isModelThinking(testModels, "kimi-k2-thinking")).toBe(true);
  });

  it("returns true for model with always_thinking capability", () => {
    expect(isModelThinking(testModels, "kimi-k2-always")).toBe(true);
  });

  it("returns false for model with think in name but no thinking capability", () => {
    expect(isModelThinking(testModels, "deepthink-r1")).toBe(false);
  });

  it("returns false for model without thinking", () => {
    expect(isModelThinking(testModels, "kimi-k2")).toBe(false);
    expect(isModelThinking(testModels, "gpt-4")).toBe(false);
  });

  it("returns false for unknown model", () => {
    expect(isModelThinking(testModels, "nonexistent")).toBe(false);
  });

  it("returns false for empty models array", () => {
    expect(isModelThinking([], "any")).toBe(false);
  });
});

// ============================================================================
// parseConfig Tests
// ============================================================================
describe("parseConfig", () => {
  beforeEach(() => {
    resetFsMock();
  });

  it("returns default config when file does not exist", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(false);

    vi.resetModules();
    const { parseConfig } = await import("../config.js");
    const config = parseConfig();

    expect(config).toEqual({
      defaultModel: null,
      defaultThinking: false,
      models: [],
    });
  });

  it("parses valid TOML config", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(`
default_model = "kimi-k2"
default_thinking = "on"

[models.kimi-k2]
provider = "kimi"
model = "kimi-k2"
max_context_size = 128000
capabilities = ["thinking", "image_in"]

[providers.kimi]
type = "kimi"
base_url = "https://api.example.com/v1"
api_key = "YOUR_API_KEY"
`);

    vi.resetModules();
    const { parseConfig } = await import("../config.js");
    const config = parseConfig();

    expect(config.defaultModel).toBe("kimi-k2");
    expect(config.defaultThinking).toBe(true);
    expect(config.models).toHaveLength(1);
    expect(config.models[0].id).toBe("kimi-k2");
    expect(config.models[0].capabilities).toContain("thinking");
  });

  it("returns default config on parse error", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("invalid { toml [");

    vi.resetModules();
    const { parseConfig } = await import("../config.js");
    const config = parseConfig();

    expect(config).toEqual({
      defaultModel: null,
      defaultThinking: false,
      models: [],
    });
  });
});

// ============================================================================
// saveDefaultModel Tests
// ============================================================================
describe("saveDefaultModel", () => {
  beforeEach(() => {
    resetFsMock();
  });

  it("creates new file when config does not exist", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(false);

    vi.resetModules();
    const { saveDefaultModel } = await import("../config.js");
    saveDefaultModel("kimi-k2");

    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), 'default_model = "kimi-k2"\n', "utf-8");
  });

  it("creates new file with thinking setting", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(false);

    vi.resetModules();
    const { saveDefaultModel } = await import("../config.js");
    saveDefaultModel("kimi-k2", true);

    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), 'default_model = "kimi-k2"\ndefault_thinking = true\n', "utf-8");
  });

  it("updates existing default_model", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('default_model = "old-model"\n\n[providers]\n');

    vi.resetModules();
    const { saveDefaultModel } = await import("../config.js");
    saveDefaultModel("new-model");

    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('default_model = "new-model"'), "utf-8");
  });

  it("adds default_model to existing config without it", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("[providers]\n");

    vi.resetModules();
    const { saveDefaultModel } = await import("../config.js");
    saveDefaultModel("kimi-k2");

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    expect(written).toContain('default_model = "kimi-k2"');
    expect(written).toContain("[providers]");
  });

  it("migrates a legacy quoted default_thinking to a boolean (in place)", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('default_model = "kimi-k2"\ndefault_thinking = "off"\n');

    vi.resetModules();
    const { saveDefaultModel } = await import("../config.js");
    saveDefaultModel("kimi-k2", true);

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    expect(written).toContain("default_thinking = true");
    expect(written).not.toContain('default_thinking = "');
    // exactly one default_thinking line — no duplicate/redefinition
    expect(written.match(/default_thinking/g)).toHaveLength(1);
  });

  it("replaces an existing boolean default_thinking without duplicating it", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    // The CLI writes the boolean form; saveDefaultModel must update it in place,
    // not append a second key (which would make the TOML invalid).
    vi.mocked(fs.readFileSync).mockReturnValue("default_thinking = true\ndefault_model = \"kimi-k2\"\n");

    vi.resetModules();
    const { saveDefaultModel } = await import("../config.js");
    saveDefaultModel("kimi-k2", false);

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    expect(written).toContain("default_thinking = false");
    expect(written.match(/default_thinking/g)).toHaveLength(1);
  });

  it("adds default_thinking after default_model", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('default_model = "kimi-k2"\n\n[providers]\n');

    vi.resetModules();
    const { saveDefaultModel } = await import("../config.js");
    saveDefaultModel("kimi-k2", false);

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    expect(written).toContain("default_thinking = false");
  });
});
