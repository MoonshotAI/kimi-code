import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsageStatus } from "@/components/UsageStatus";
import { useSettingsStore } from "@/stores";

const bridgeMocks = vi.hoisted(() => ({
  getPlanUsage: vi.fn(),
  on: vi.fn(() => vi.fn()),
}));

vi.mock("@/services", () => ({
  bridge: bridgeMocks,
  Events: { StreamEvent: "streamEvent" },
}));

function enableManagedUsage() {
  useSettingsStore.setState({
    currentModel: "kimi",
    models: [{
      id: "kimi",
      name: "Kimi",
      provider: "managed:kimi-code",
      capabilities: [],
    }],
    isLoggedIn: true,
  });
}

describe("UsageStatus", () => {
  beforeEach(() => {
    bridgeMocks.getPlanUsage.mockReset();
    bridgeMocks.on.mockClear();
    enableManagedUsage();
  });

  it("shows overall and 5h remaining percentages with explicit left semantics", async () => {
    bridgeMocks.getPlanUsage.mockResolvedValue({
      kind: "ok",
      overall: { label: "Overall", percentLeft: 72 },
      fiveHour: { label: "5h", percentLeft: 39 },
      fetchedAt: "2030-01-01T00:00:00Z",
    });

    render(<UsageStatus />);

    const usage = await screen.findByRole("button", {
      name: "Kimi plan usage: Overall 72% left, 5h 39% left",
    });
    expect(usage.textContent).toContain("Overall 72% left");
    expect(usage.textContent).toContain("5h 39% left");
  });

  it("keeps the explicit Weekly label when monthly overall data is absent", async () => {
    bridgeMocks.getPlanUsage.mockResolvedValue({
      kind: "ok",
      overall: { label: "Weekly", percentLeft: 91 },
      fiveHour: { label: "5h", percentLeft: 84 },
      fetchedAt: "2030-01-01T00:00:00Z",
    });

    render(<UsageStatus />);
    expect(await screen.findByRole("button", {
      name: "Kimi plan usage: Weekly 91% left, 5h 84% left",
    })).toBeTruthy();
  });

  it("shows an actionable unavailable state instead of invented zeroes", async () => {
    bridgeMocks.getPlanUsage.mockResolvedValue({
      kind: "error",
      message: "Usage endpoint unavailable",
    });

    render(<UsageStatus />);
    await waitFor(() => {
      expect(screen.getByRole("button", {
        name: "Kimi plan usage unavailable: Usage endpoint unavailable",
      }).textContent).toContain("Usage unavailable");
    });
    expect(screen.queryByText("0%", { exact: false })).toBeNull();

    fireEvent.click(screen.getByRole("button", {
      name: "Kimi plan usage unavailable: Usage endpoint unavailable",
    }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Usage endpoint unavailable");
    expect(screen.getByText("Usage endpoint unavailable", { exact: true }).className).toContain("text-destructive");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(bridgeMocks.getPlanUsage).toHaveBeenLastCalledWith("managed:kimi-code", true));
  });

  it("exposes progress semantics and non-color low/critical labels", async () => {
    bridgeMocks.getPlanUsage.mockResolvedValue({
      kind: "ok",
      overall: { label: "Overall", percentLeft: 18 },
      fiveHour: { label: "5h", percentLeft: 4 },
      fetchedAt: "2030-01-01T00:00:00Z",
    });

    render(<UsageStatus />);
    fireEvent.click(await screen.findByRole("button", {
      name: "Kimi plan usage: Overall 18% left, 5h 4% left",
    }));
    expect((await screen.findByRole("progressbar", { name: "Overall usage remaining" })).getAttribute("aria-valuetext")).toBe("18% left, Low");
    expect(screen.getByRole("progressbar", { name: "5h usage remaining" }).getAttribute("aria-valuetext")).toBe("4% left, Critical");
    expect(screen.getByText("18% left · Low")).toBeTruthy();
    expect(screen.getByText("4% left · Critical")).toBeTruthy();
  });

  it("renders an em dash without a percent sign when a window is absent", async () => {
    bridgeMocks.getPlanUsage.mockResolvedValue({
      kind: "ok",
      overall: { label: "Overall", percentLeft: 72 },
      fetchedAt: "2030-01-01T00:00:00Z",
    });

    render(<UsageStatus />);
    const usage = await screen.findByRole("button", {
      name: "Kimi plan usage: Overall 72% left",
    });
    expect(usage.textContent).toContain("5h —");
    expect(usage.textContent).not.toContain("—%");
  });

  it("does not render for a non-managed provider", () => {
    useSettingsStore.setState({
      currentModel: "custom",
      models: [{ id: "custom", name: "Custom", provider: "openai", capabilities: [] }],
      isLoggedIn: true,
    });
    const { container } = render(<UsageStatus />);
    expect(container.firstChild).toBeNull();
    expect(bridgeMocks.getPlanUsage).not.toHaveBeenCalled();
  });
});
