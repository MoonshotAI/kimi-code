import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatArea } from "@/components/ChatArea";
import { DesktopBanner } from "@/components/DesktopBanner";
import { WelcomeScreen } from "@/components/WelcomeScreen";
import { useChatStore, useSettingsStore } from "@/stores";

const desktopBridge = vi.hoisted(() => ({
  openInDesktop: vi.fn(),
  installDesktop: vi.fn(),
}));
const mockUseWelcomeHint = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ error: vi.fn(), warning: vi.fn() }));

vi.mock("@/services", () => ({
  bridge: desktopBridge,
}));

vi.mock("@/hooks/useWelcomeHint", () => ({
  useWelcomeHint: mockUseWelcomeHint,
}));

vi.mock("@/components/ui/sonner", () => ({ toast }));

beforeEach(() => {
  desktopBridge.openInDesktop.mockReset();
  desktopBridge.installDesktop.mockReset();
  desktopBridge.openInDesktop.mockResolvedValue({ ok: true });
  desktopBridge.installDesktop.mockResolvedValue({ ok: true });
  mockUseWelcomeHint.mockReset();
  toast.error.mockReset();
  toast.warning.mockReset();
  useChatStore.setState({ messages: [] });
  useSettingsStore.setState({ workspaceRoot: "/workspace", isRemote: false });
});

describe("DesktopBanner", () => {
  it("opens the current workspace and the installation page", () => {
    render(<DesktopBanner />);

    fireEvent.click(screen.getByRole("button", { name: "Open in Desktop" }));
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    expect(desktopBridge.openInDesktop).toHaveBeenCalledOnce();
    expect(desktopBridge.installDesktop).toHaveBeenCalledOnce();
  });

  it("shows an error toast instead of opening the installation page when Desktop cannot be opened", async () => {
    desktopBridge.openInDesktop.mockResolvedValue({ ok: false });
    render(<DesktopBanner />);

    fireEvent.click(screen.getByRole("button", { name: "Open in Desktop" }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Could not open Kimi Code Desktop. Install it and try again.");
    });
    expect(desktopBridge.openInDesktop).toHaveBeenCalledOnce();
    expect(desktopBridge.installDesktop).not.toHaveBeenCalled();
  });

  it("shows an error toast instead of opening the installation page when the Desktop request fails", async () => {
    desktopBridge.openInDesktop.mockRejectedValue(new Error("no scheme handler"));
    render(<DesktopBanner />);

    fireEvent.click(screen.getByRole("button", { name: "Open in Desktop" }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Could not open Kimi Code Desktop. Install it and try again.");
    });
    expect(desktopBridge.installDesktop).not.toHaveBeenCalled();
  });

  it("only offers Install when no workspace is open", () => {
    useSettingsStore.setState({ workspaceRoot: null });
    render(<DesktopBanner />);

    expect(screen.queryByRole("button", { name: "Open in Desktop" })).toBeNull();
    expect(screen.getByRole("button", { name: "Install" })).toBeTruthy();
  });

  it("only offers Install for a remote workspace", () => {
    useSettingsStore.setState({ isRemote: true });
    render(<DesktopBanner />);

    expect(screen.queryByRole("button", { name: "Open in Desktop" })).toBeNull();
    expect(screen.getByRole("button", { name: "Install" })).toBeTruthy();
  });
});

describe("WelcomeScreen", () => {
  it("places the banner between the Quick Start Guide title and body", () => {
    mockUseWelcomeHint.mockReturnValue({
      title: "Quick Start Guide",
      description: "",
      component: <div>Shortcut guide body</div>,
    });
    render(<WelcomeScreen />);

    const title = screen.getByText("Quick Start Guide");
    const banner = screen.getByText("✦ Kimi Code Desktop is here");
    const guide = screen.getByText("Shortcut guide body");

    expectBefore(title, banner);
    expectBefore(banner, guide);
  });

  it("places the banner below a returning user's hint", () => {
    mockUseWelcomeHint.mockReturnValue({
      title: "Context getting long?",
      description: "Type /compact to keep only the essentials",
    });
    render(<WelcomeScreen />);

    const description = screen.getByText("Type /compact to keep only the essentials");
    const banner = screen.getByText("✦ Kimi Code Desktop is here");

    expectBefore(description, banner);
  });
});

describe("ChatArea", () => {
  it("uses a scrollable full-height layout for an empty conversation", () => {
    mockUseWelcomeHint.mockReturnValue({ title: "Quick Start Guide", description: "" });
    const { container } = render(<ChatArea />);

    const scrollArea = container.firstElementChild;
    expect(scrollArea?.classList.contains("overflow-y-auto")).toBe(true);
    expect(scrollArea?.firstElementChild?.classList.contains("min-h-full")).toBe(true);
    expect(scrollArea?.firstElementChild?.firstElementChild?.classList.contains("py-6")).toBe(true);
  });
});

function expectBefore(earlier: HTMLElement, later: HTMLElement): void {
  expect(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}
