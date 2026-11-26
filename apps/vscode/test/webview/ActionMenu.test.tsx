import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUSINESS_MEMBERSHIP_REVOKED_MESSAGE } from "shared/errors";
import type { AccountProfileResponse, AccountProfileSnapshot, SwitchWorkspaceResponse } from "shared/types";

const bridgeMock = vi.hoisted(() => ({
  openSettings: vi.fn(async () => ({ ok: true })),
  reloadWebview: vi.fn(async () => ({ ok: true })),
  showLogs: vi.fn(async () => ({ ok: true })),
  login: vi.fn(async () => ({ success: true })),
  logout: vi.fn(async () => ({ success: true })),
  getAccountProfile: vi.fn<() => Promise<AccountProfileResponse>>(),
  switchWorkspace: vi.fn<() => Promise<SwitchWorkspaceResponse>>(),
  saveConfig: vi.fn(async () => ({ ok: true })),
}));

const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
}));

vi.mock("@/services", () => ({
  bridge: bridgeMock,
  Events: {
    ExtensionConfigChanged: "extensionConfigChanged",
    ModelCatalogChanged: "modelCatalogChanged",
    BusinessMembershipRevoked: "businessMembershipRevoked",
  },
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: toastMock,
}));

import { ActionMenu } from "@/components/ActionMenu";
import { BusinessMembershipRevokedDialog } from "@/components/BusinessMembershipRevokedDialog";
import { DEFAULT_EXTENSION_CONFIG, useSettingsStore } from "@/stores/settings.store";

const PERSONAL_PROFILE: AccountProfileSnapshot = {
  nickname: "Alex Chen",
  userLevelName: "Go",
  hasBusinessWorkspace: false,
  activeWorkspaceName: "Personal workspace",
  workspaces: [
    {
      kind: "personal",
      key: "personal",
      name: "Alex Chen",
      current: true,
      disabled: false,
      switchable: true,
      roles: ["ROLE_OWNER"],
    },
  ],
};

const BUSINESS_PROFILE: AccountProfileSnapshot = {
  nickname: "Alex Chen",
  userLevelName: "Go",
  hasBusinessWorkspace: true,
  activeWorkspaceName: "Personal workspace",
  workspaces: [
    {
      kind: "personal",
      key: "personal",
      name: "Alex Chen",
      current: true,
      disabled: false,
      switchable: true,
      roles: ["ROLE_OWNER"],
    },
    {
      kind: "business",
      key: "business:biz_acme",
      businessId: "biz_acme",
      name: "Acme AI",
      status: "STATUS_ACTIVE",
      current: false,
      disabled: false,
      switchable: true,
      roles: ["ROLE_MEMBER"],
    },
  ],
};

describe("ActionMenu and BusinessMembershipRevokedDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      isLoggedIn: true,
      extensionConfig: { ...DEFAULT_EXTENSION_CONFIG, version: "0.10.0" },
      accountProfile: null,
      accountProfileLoading: false,
      accountProfileError: null,
      recentWorkspaceKeys: [],
      switchingWorkspaceKey: null,
      membershipRevokedOpen: false,
      membershipRevokedMessage: BUSINESS_MEMBERSHIP_REVOKED_MESSAGE,
    });
  });

  it("keeps baseline menu without Workspace section for pure personal accounts", async () => {
    bridgeMock.getAccountProfile.mockResolvedValue({ kind: "ok", profile: PERSONAL_PROFILE });
    useSettingsStore.setState({ accountProfile: PERSONAL_PROFILE });

    render(<ActionMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Settings and account" }));

    await waitFor(() => expect(screen.getByText("Working Directory")).toBeTruthy());
    expect(screen.queryByText("Workspace")).toBeNull();
    expect(screen.queryByTestId("account-identity-row")).toBeNull();
    expect(screen.getByText("Sign out")).toBeTruthy();
  });

  it("renders Workspace section and Account plan row for business accounts and switches silently", async () => {
    const switchedProfile: AccountProfileSnapshot = {
      ...BUSINESS_PROFILE,
      userLevelName: "Premium",
      activeWorkspaceName: "Acme AI",
      workspaces: BUSINESS_PROFILE.workspaces.map((ws) => ({
        ...ws,
        current: ws.key === "business:biz_acme",
      })),
    };
    bridgeMock.getAccountProfile.mockResolvedValue({ kind: "ok", profile: BUSINESS_PROFILE });
    bridgeMock.switchWorkspace.mockResolvedValue({
      kind: "ok",
      target: { kind: "business", businessId: "biz_acme" },
      profile: switchedProfile,
    });
    useSettingsStore.setState({ accountProfile: BUSINESS_PROFILE });

    render(<ActionMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Settings and account" }));

    await waitFor(() => expect(screen.getByText("Workspace")).toBeTruthy());
    expect(screen.getByText("Personal workspace")).toBeTruthy();
    expect(screen.getByText("Business workspace")).toBeTruthy();
    expect(screen.getByTestId("account-identity-row").textContent).toContain("Go");

    const acmeBtn = screen.getByText("Acme AI").closest("button");
    if (!acmeBtn) throw new Error("Missing Acme AI workspace button");
    await act(async () => {
      fireEvent.click(acmeBtn);
    });

    expect(bridgeMock.switchWorkspace).toHaveBeenCalledWith(
      {
        kind: "business",
        businessId: "biz_acme",
      },
      "personal",
    );
    expect(toastMock.info).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().accountProfile?.userLevelName).toBe("Premium");
  });

  it("supports View all workspaces search subview, Escape back-navigation, and disabled workspace rows", async () => {
    const manyProfile: AccountProfileSnapshot = {
      nickname: "Alex Chen",
      userLevelName: "Premium",
      hasBusinessWorkspace: true,
      activeWorkspaceName: "Acme AI",
      workspaces: [
        {
          kind: "personal",
          key: "personal",
          name: "Alex Chen",
          current: false,
          disabled: false,
          switchable: true,
          roles: ["ROLE_OWNER"],
        },
        {
          kind: "business",
          key: "business:biz_acme",
          businessId: "biz_acme",
          name: "Acme AI",
          current: true,
          disabled: false,
          switchable: true,
          roles: ["ROLE_MEMBER"],
        },
        {
          kind: "business",
          key: "business:biz_archived",
          businessId: "biz_archived",
          name: "Archived Corp",
          status: "STATUS_DISABLED",
          current: false,
          disabled: true,
          switchable: false,
          roles: ["ROLE_MEMBER"],
        },
        {
          kind: "business",
          key: "business:biz_lab01",
          businessId: "biz_lab01",
          name: "Research Lab",
          current: false,
          disabled: false,
          switchable: true,
          roles: ["ROLE_MEMBER"],
        },
        {
          kind: "business",
          key: "business:biz_lab02",
          businessId: "biz_lab02",
          name: "Research Lab",
          current: false,
          disabled: false,
          switchable: true,
          roles: ["ROLE_MEMBER"],
        },
      ],
    };
    bridgeMock.getAccountProfile.mockResolvedValue({ kind: "ok", profile: manyProfile });
    useSettingsStore.setState({ accountProfile: manyProfile });

    render(<ActionMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Settings and account" }));

    const viewAllBtn = await screen.findByText("View all workspaces");
    fireEvent.click(viewAllBtn.closest("button")!);

    const searchInput = await screen.findByPlaceholderText("Search workspaces…");
    expect(screen.getByText("Disabled · Contact admin")).toBeTruthy();
    const disabledBtn = screen.getByText("Archived Corp").closest("button") as HTMLButtonElement;
    expect(disabledBtn.disabled).toBe(true);
    expect(screen.getByText("Business workspace · #ab01")).toBeTruthy();
    expect(screen.getByText("Business workspace · #ab02")).toBeTruthy();

    fireEvent.change(searchInput, { target: { value: "nonexistent" } });
    expect(await screen.findByText("No matching workspaces")).toBeTruthy();

    fireEvent.keyDown(searchInput, { key: "Escape" });
    expect(await screen.findByText("View all workspaces")).toBeTruthy();
  });

  it("blocks Escape dismissal on BusinessMembershipRevokedDialog and confirms relogin", async () => {
    const onConfirm = vi.fn();
    useSettingsStore.getState().triggerMembershipRevoked();

    render(<BusinessMembershipRevokedDialog onConfirm={onConfirm} />);

    expect(await screen.findByText("Removed from Business Workspace")).toBeTruthy();
    expect(screen.getByText(BUSINESS_MEMBERSHIP_REVOKED_MESSAGE)).toBeTruthy();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useSettingsStore.getState().membershipRevokedOpen).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(useSettingsStore.getState().membershipRevokedOpen).toBe(false);
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
