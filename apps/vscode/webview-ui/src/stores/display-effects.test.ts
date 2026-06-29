import { beforeEach, describe, expect, it, vi } from "vitest";

import { bridge } from "@/services";
import { runDisplayEffects } from "./display-effects";

vi.mock("@/services", () => ({
  bridge: {
    trackFiles: vi.fn().mockResolvedValue(undefined),
    clearTrackedFiles: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("runDisplayEffects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tracks files for TrackFiles effects", () => {
    runDisplayEffects([{ type: "TrackFiles", paths: ["a.ts", "b.ts"] }]);

    expect(bridge.trackFiles).toHaveBeenCalledWith(["a.ts", "b.ts"]);
  });

  it("clears tracked files for ClearTrackedFiles effects", () => {
    runDisplayEffects([{ type: "ClearTrackedFiles" }]);

    expect(bridge.clearTrackedFiles).toHaveBeenCalled();
  });
});
