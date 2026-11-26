import { useEffect, useMemo, useState } from "react";
import {
  IconArrowLeft,
  IconCheck,
  IconChevronRight,
  IconFileText,
  IconFolder,
  IconLoader2,
  IconLogin,
  IconLogout,
  IconRefresh,
  IconServer,
  IconSettings,
} from "@tabler/icons-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { useSettingsStore } from "@/stores";
import { bridge } from "@/services";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import type { ManagedWorkspaceItem } from "shared/types";

const INLINE_WORKSPACE_THRESHOLD = 3;
const COLLAPSED_INLINE_COUNT = 2;
const EMPTY_WORKSPACES: readonly ManagedWorkspaceItem[] = [];

interface ActionMenuProps {
  className?: string;
  onAuthAction?: () => void;
}

function MenuSection({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="py-1">
      <div className="px-2.5 py-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center justify-between">
        <span>{title}</span>
        {subtitle && <span className="normal-case tracking-normal">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

function MenuItem({
  onClick,
  disabled,
  danger,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "w-full flex items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-accent transition-colors text-left cursor-pointer",
        disabled && "opacity-50 cursor-not-allowed hover:bg-transparent",
        danger && "text-red-500 hover:text-red-600",
      )}
    >
      {children}
    </button>
  );
}

function avatarInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "W";
  return (Array.from(trimmed)[0] ?? "W").toUpperCase();
}

function IdentityAvatar({
  src,
  name,
  shape,
}: {
  src?: string;
  name: string;
  shape: "circle" | "square";
}) {
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setImgFailed(false);
  }, [src]);

  if (src && !imgFailed) {
    return (
      <img
        src={src}
        alt=""
        onError={() => setImgFailed(true)}
        className={cn(
          "size-6 shrink-0 object-cover bg-muted",
          shape === "circle" ? "rounded-full" : "rounded-md",
        )}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-6 shrink-0 inline-flex items-center justify-center bg-muted text-foreground text-[11px] font-medium select-none",
        shape === "circle" ? "rounded-full" : "rounded-md",
      )}
    >
      {avatarInitial(name)}
    </span>
  );
}

function WorkspaceRow({
  workspace,
  avatarSrc,
  subtitle,
  switching,
  disabled,
  onSelect,
}: {
  workspace: ManagedWorkspaceItem;
  avatarSrc?: string;
  subtitle: string;
  switching: boolean;
  disabled: boolean;
  onSelect: (workspace: ManagedWorkspaceItem) => void;
}) {
  const tooltip = workspace.disabled
    ? `${workspace.name} · Workspace disabled (contact your workspace administrator)`
    : `${workspace.name} · ${subtitle}`;

  return (
    <MenuItem
      onClick={() => onSelect(workspace)}
      disabled={disabled}
      title={tooltip}
    >
      <IdentityAvatar
        src={workspace.kind === "personal" ? avatarSrc : undefined}
        name={workspace.name}
        shape={workspace.kind === "personal" ? "circle" : "square"}
      />
      <span className="flex-1 min-w-0 flex flex-col">
        <span className="text-xs leading-[17px] text-foreground truncate">{workspace.name}</span>
        <span className="text-[11px] leading-4 text-muted-foreground truncate">{subtitle}</span>
      </span>
      {(switching || workspace.current) && (
        <span className="size-4 shrink-0 inline-flex items-center justify-center" aria-hidden="true">
          {switching ? (
            <IconLoader2 className="size-4 animate-spin text-muted-foreground" />
          ) : (
            <IconCheck className="size-4 text-foreground" />
          )}
        </span>
      )}
    </MenuItem>
  );
}

export function ActionMenu({ className, onAuthAction }: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<"menu" | "workspaces">("menu");
  const [searchQuery, setSearchQuery] = useState("");
  const {
    setMCPModalOpen,
    isLoggedIn,
    setIsLoggedIn,
    extensionConfig,
    accountProfile,
    accountProfileError,
    recentWorkspaceKeys,
    switchingWorkspaceKey,
    membershipRevokedOpen,
    loadAccountProfile,
    switchWorkspace,
  } = useSettingsStore();

  const isSwitchingWorkspace = switchingWorkspaceKey !== null;
  const hasBusinessWorkspace = isLoggedIn && Boolean(accountProfile?.hasBusinessWorkspace);
  const workspaces = accountProfile?.workspaces ?? EMPTY_WORKSPACES;

  useEffect(() => {
    if (!open) {
      setView("menu");
      setSearchQuery("");
      return;
    }
    if (isLoggedIn && !useSettingsStore.getState().switchingWorkspaceKey) {
      void loadAccountProfile();
    }
  }, [open, isLoggedIn, loadAccountProfile]);

  useEffect(() => {
    if (open && (!isLoggedIn || membershipRevokedOpen)) {
      setOpen(false);
    }
  }, [open, isLoggedIn, membershipRevokedOpen]);

  const duplicateBusinessNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ws of workspaces) {
      if (ws.kind !== "business") continue;
      counts.set(ws.name, (counts.get(ws.name) ?? 0) + 1);
    }
    const duplicates = new Set<string>();
    for (const [name, count] of counts) {
      if (count > 1) duplicates.add(name);
    }
    return duplicates;
  }, [workspaces]);

  const primaryWorkspaces = useMemo(() => {
    if (workspaces.length <= INLINE_WORKSPACE_THRESHOLD) return workspaces;
    const picked: ManagedWorkspaceItem[] = [];
    const pickedKeys = new Set<string>();
    const add = (item: ManagedWorkspaceItem | undefined) => {
      if (!item || pickedKeys.has(item.key) || picked.length >= COLLAPSED_INLINE_COUNT) return;
      picked.push(item);
      pickedKeys.add(item.key);
    };
    add(workspaces.find((ws) => ws.current));
    for (const key of recentWorkspaceKeys) {
      add(workspaces.find((ws) => ws.key === key));
    }
    for (const ws of workspaces) {
      add(ws);
    }
    return picked;
  }, [workspaces, recentWorkspaceKeys]);

  const filteredWorkspaces = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return workspaces;
    return workspaces.filter((ws) => {
      if (ws.name.toLowerCase().includes(q)) return true;
      if (ws.kind === "business" && ws.businessId?.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [workspaces, searchQuery]);

  const formatWorkspaceSubtitle = (ws: ManagedWorkspaceItem): string => {
    if (ws.kind === "personal") return "Personal workspace";
    if (ws.disabled) return "Disabled · Contact admin";
    if (duplicateBusinessNames.has(ws.name) && ws.businessId) {
      return `Business workspace · #${ws.businessId.slice(-4)}`;
    }
    return "Business workspace";
  };

  const handleSelectWorkspace = async (ws: ManagedWorkspaceItem) => {
    if (ws.disabled || isSwitchingWorkspace) return;
    if (ws.current) {
      setOpen(false);
      return;
    }
    const target =
      ws.kind === "personal"
        ? ({ kind: "personal" } as const)
        : ({ kind: "business", businessId: ws.businessId ?? "" } as const);
    const outcome = await switchWorkspace(target);
    if (outcome.ok) {
      setOpen(false);
      if (outcome.warning) {
        toast.warning(outcome.warning);
      }
      return;
    }
    if (!outcome.revoked && outcome.error) {
      toast.error(outcome.error);
    }
  };

  const renderWorkspaceItems = (items: readonly ManagedWorkspaceItem[]) =>
    items.map((ws) => (
      <WorkspaceRow
        key={ws.key}
        workspace={ws}
        avatarSrc={accountProfile?.avatar}
        subtitle={formatWorkspaceSubtitle(ws)}
        switching={switchingWorkspaceKey === ws.key}
        disabled={ws.disabled || isSwitchingWorkspace}
        onSelect={(item) => {
          void handleSelectWorkspace(item);
        }}
      />
    ));

  const handleOpenSettings = () => {
    void bridge.openSettings();
    setOpen(false);
  };

  const handleOpenMCPServers = () => {
    setMCPModalOpen(true);
    setOpen(false);
  };

  const handleChangeWorkDir = () => {
    useSettingsStore.getState().setWorkDirModalOpen(true);
    setOpen(false);
  };

  const handleReset = () => {
    setOpen(false);
    void bridge.reloadWebview();
  };

  const handleShowLogs = () => {
    void bridge.showLogs();
    setOpen(false);
  };

  const handleAuthAction = async () => {
    setLoading(true);
    try {
      if (isLoggedIn) {
        await bridge.logout();
        setIsLoggedIn(false);
      } else {
        const result = await bridge.login();
        if (result.success) {
          setIsLoggedIn(true);
        } else {
          toast.error(result.error ?? "Sign-in failed. Check the logs for details.");
        }
      }
    } finally {
      setLoading(false);
      setOpen(false);
    }
    onAuthAction?.();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Settings and account"
          className={cn("text-muted-foreground", className)}
        >
          <IconSettings className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[calc(100vw-1rem)] max-w-72 p-1.5 gap-0!"
        align="end"
        side="top"
        onEscapeKeyDown={(event) => {
          if (view === "workspaces") {
            event.preventDefault();
            setView("menu");
            setSearchQuery("");
          }
        }}
      >
        {view === "workspaces" && hasBusinessWorkspace ? (
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5 px-1.5 py-1">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Back to menu"
                onClick={() => {
                  setView("menu");
                  setSearchQuery("");
                }}
              >
                <IconArrowLeft className="size-3.5" />
              </Button>
              <span className="text-xs font-medium text-foreground">Workspaces</span>
            </div>
            <div className="px-2 pb-1.5">
              <Input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search workspaces…"
                autoFocus
                className="h-7 text-xs"
              />
            </div>
            <Separator className="my-px" />
            <div className="max-h-60 overflow-y-auto py-1">
              {filteredWorkspaces.length === 0 ? (
                <div className="px-2.5 py-4 flex flex-col items-center gap-2 text-center">
                  <span className="text-xs text-muted-foreground">No matching workspaces</span>
                  {searchQuery.trim().length > 0 && (
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => setSearchQuery("")}
                    >
                      Clear search
                    </Button>
                  )}
                </div>
              ) : (
                renderWorkspaceItems(filteredWorkspaces)
              )}
            </div>
          </div>
        ) : (
          <>
            {hasBusinessWorkspace && (
              <>
                <MenuSection title="Workspace">
                  {renderWorkspaceItems(primaryWorkspaces)}
                  {workspaces.length > INLINE_WORKSPACE_THRESHOLD && (
                    <MenuItem onClick={() => setView("workspaces")}>
                      <IconServer className="size-4 text-muted-foreground" />
                      <span className="flex-1">View all workspaces</span>
                      <span className="text-[10px] text-muted-foreground">
                        {workspaces.length}
                      </span>
                      <IconChevronRight className="size-3.5 text-muted-foreground" />
                    </MenuItem>
                  )}
                </MenuSection>
                <Separator className="my-px" />
              </>
            )}

            <MenuSection title="Settings">
              <MenuItem onClick={handleChangeWorkDir}>
                <IconFolder className="size-4 text-muted-foreground" />
                <span className="flex-1">Working Directory</span>
              </MenuItem>
              <MenuItem onClick={handleOpenMCPServers}>
                <IconServer className="size-4 text-muted-foreground" />
                <span className="flex-1">MCP Servers</span>
              </MenuItem>
              <MenuItem onClick={handleOpenSettings}>
                <IconSettings className="size-4 text-muted-foreground" />
                <span className="flex-1">General Config</span>
                <span className="text-[10px] text-muted-foreground">↗</span>
              </MenuItem>
            </MenuSection>

            <Separator className="my-px" />

            <MenuSection
              title="Support"
              subtitle={extensionConfig.version ? `v${extensionConfig.version}` : undefined}
            >
              <MenuItem onClick={handleShowLogs}>
                <IconFileText className="size-4 text-muted-foreground" />
                <span className="flex-1">Show Logs</span>
              </MenuItem>
              <MenuItem onClick={handleReset}>
                <IconRefresh className="size-4 text-muted-foreground" />
                <span className="flex-1">Reset Kimi</span>
              </MenuItem>
            </MenuSection>

            <Separator className="my-px" />

            <MenuSection title="Account">
              {isLoggedIn && !accountProfile && accountProfileError && (
                <div className="px-2.5 py-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="truncate">Failed to load workspaces</span>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      void loadAccountProfile();
                    }}
                  >
                    Retry
                  </Button>
                </div>
              )}
              {hasBusinessWorkspace && accountProfile && (
                <div
                  className="flex items-center gap-2 px-2.5 py-1.5"
                  data-testid="account-identity-row"
                >
                  <IdentityAvatar
                    src={accountProfile.avatar}
                    name={accountProfile.nickname || "Kimi User"}
                    shape="circle"
                  />
                  <span className="flex-1 min-w-0 truncate text-xs text-foreground">
                    {accountProfile.nickname || "Kimi User"}
                  </span>
                  {accountProfile.userLevelName && (
                    <Badge variant="secondary" className="h-5 px-2 text-[11px] font-medium">
                      {accountProfile.userLevelName}
                    </Badge>
                  )}
                </div>
              )}
              <MenuItem
                onClick={() => {
                  void handleAuthAction();
                }}
                disabled={loading || isSwitchingWorkspace}
                danger={isLoggedIn}
              >
                {loading ? (
                  <IconLoader2 className="size-4 animate-spin" />
                ) : isLoggedIn ? (
                  <IconLogout className="size-4" />
                ) : (
                  <IconLogin className="size-4 text-muted-foreground" />
                )}
                <span className="flex-1">
                  {loading ? "Processing…" : isLoggedIn ? "Sign out" : "Sign in"}
                </span>
              </MenuItem>
            </MenuSection>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
