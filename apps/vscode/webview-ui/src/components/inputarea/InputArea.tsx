import { Fragment, useRef, useMemo, useState, useEffect, useCallback } from "react";
import { useMemoizedFn } from "ahooks";
import { IconSend, IconPlayerStop, IconChevronDown, IconPlus } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ActionMenu } from "../ActionMenu";
import { SlashCommandMenu } from "../SlashCommandMenu";
import { FilePickerMenu } from "../FilePickerMenu";
import { MediaThumbnail } from "../MediaThumbnail";
import { MediaPreviewModal } from "../MediaPreviewModal";
import { BottomToolbar } from "../BottomToolbar";
import { StreamingConfirmDialog } from "../StreamingConfirmDialog";
import { ThinkingButton } from "../ThinkingButton";
import { PlanModeButton } from "../PlanModeButton";
import {
  getModelById,
  getMediaFallbackModel,
  getModelsForMedia,
  groupModelsByProvider,
  providerDisplayName,
  useChatStore,
  useSettingsStore,
} from "@/stores";
import { bridge, Events } from "@/services";
import { Content } from "@/lib/content";
import { cn } from "@/lib/utils";
import { useSlashMenu, findActiveToken } from "./hooks/useSlashMenu";
import { useFilePicker } from "./hooks/useFilePicker";
import { useMediaUpload } from "./hooks/useMediaUpload";
import { useClickOutside } from "./hooks/useClickOutside";
import { useInputHistory } from "./hooks/useInputHistory";
import { computeMentionInsert } from "./utils";

interface InputAreaProps {
  onAuthAction?: () => void;
}

const SWITCH_CACHE_NOTE =
  "Note: Switching models or thinking effort invalidates the existing prompt cache. Start a new conversation to avoid extra token costs.";

export function InputArea({ onAuthAction }: InputAreaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const [previewMedia, setPreviewMedia] = useState<string | null>(null);

  const { isStreaming, sendMessage, abort, draftMedia, removeDraftMedia, hasProcessingMedia, getMediaInConversation, pendingInput, planMode, messages } = useChatStore();
  const { currentModel, thinkingEffort, updateModel, toggleThinking, selectThinkingEffort, models, extensionConfig, getCurrentThinkingMode } = useSettingsStore();

  const isProcessing = hasProcessingMedia();
  const thinkingMode = getCurrentThinkingMode();
  // A switch from a non-empty conversation resends the accumulated context,
  // losing the prompt cache — surface the cost note in the switcher dropdowns.
  const hasConversationHistory = messages.some((message) => message.role === "user");

  const [showPlanModeConfirm, setShowPlanModeConfirm] = useState(false);

  const handleTogglePlanMode = () => {
    // Turning OFF during streaming needs confirmation — user may want next turn, not current
    if (planMode && isStreaming) {
      setShowPlanModeConfirm(true);
      return;
    }
    const newState = !planMode;
    useChatStore.setState({ planMode: newState }); // optimistic
    void bridge.setPlanMode(newState);
  };

  const handleConfirmExitPlanMode = () => {
    useChatStore.setState({ planMode: false });
    void bridge.setPlanMode(false);
    setShowPlanModeConfirm(false);
  };

  const mediaReq = useMemo(() => {
    const media = getMediaInConversation();
    return { image: media.hasImage, video: media.hasVideo };
  }, [getMediaInConversation, draftMedia]);

  const availableModels = useMemo(() => getModelsForMedia(models, mediaReq), [models, mediaReq]);
  const currentModelConfig = getModelById(models, currentModel);
  const modelGroups = useMemo(() => groupModelsByProvider(availableModels), [availableModels]);
  const showProviderGroups = modelGroups.length > 1;
  const currentModelLabel = currentModelConfig === undefined
    ? "No models available"
    : showProviderGroups
      ? `${currentModelConfig.name} · ${providerDisplayName(currentModelConfig.provider)}`
      : currentModelConfig.name;

  // Auto-switch model if current model doesn't support required media
  useEffect(() => {
    if (!mediaReq.image && !mediaReq.video) {
      return;
    }
    const isCurrentModelValid = availableModels.some((m) => m.id === currentModel);
    if (isCurrentModelValid) {
      return;
    }
    const fallbackModel = getMediaFallbackModel(availableModels, currentModelConfig);
    if (fallbackModel !== undefined) {
      updateModel(fallbackModel.id);
    }
  }, [mediaReq.image, mediaReq.video, currentModel, currentModelConfig, availableModels, updateModel]);

  // Restore pending input
  useEffect(() => {
    if (!pendingInput || isStreaming) {
      return;
    }

    // 只在输入框为空时恢复
    if (text.trim()) {
      return;
    }

    const textContent = Content.getText(pendingInput.content);
    if (textContent) {
      setText(textContent);
      setTimeout(() => {
        textareaRef.current?.focus();
        adjustHeight();
      }, 0);
    }
  }, [pendingInput, isStreaming]);

  const activeToken = useMemo(() => findActiveToken(text, cursorPos), [text, cursorPos]);

  const { handlePaste, handlePickMedia } = useMediaUpload();

  const adjustHeight = useMemoizedFn(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
    }
  });

  const {
    handleKey: handleHistoryKey,
    add: addToHistory,
    reset: resetHistoryIndex,
  } = useInputHistory({
    text,
    setText,
    onHeightChange: () => setTimeout(adjustHeight, 0),
  });

  const clearInput = useMemoizedFn(() => {
    setText("");
    setCursorPos(0);
    setTimeout(adjustHeight, 0);
  });

  const removeActiveToken = useMemoizedFn(() => {
    if (!activeToken) return;
    const newText = text.slice(0, activeToken.start) + text.slice(cursorPos);
    const newCursorPos = activeToken.start;
    setText(newText);
    setCursorPos(newCursorPos);
    setTimeout(() => {
      textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos);
      adjustHeight();
    }, 0);
  });

  const handleSend = useMemoizedFn(() => {
    if (isProcessing || (!text.trim() && draftMedia.length === 0)) {
      return;
    }

    addToHistory(text);
    sendMessage(text);
    clearInput();
  });

  const handleSlashCommand = useMemoizedFn((name: string) => {
    sendMessage(`/${name}`);
    clearInput();
  });

  const applyMention = useMemoizedFn((filePath: string) => {
    const { newText, newCursorPos } = computeMentionInsert({
      text,
      cursorPos,
      filePath,
      activeToken,
      isAppend: false,
    });

    setText(newText);
    setCursorPos(newCursorPos);
    setTimeout(() => {
      textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos);
      textareaRef.current?.focus();
      adjustHeight();
    }, 0);
  });

  const {
    showSlashMenu,
    filteredCommands,
    selectedIndex: slashSelectedIndex,
    setSelectedIndex: setSlashSelectedIndex,
    handleSlashMenuKey,
    resetSlashMenu,
  } = useSlashMenu(activeToken, handleSlashCommand, removeActiveToken);

  const {
    showFileMenu,
    filePickerMode,
    folderPath,
    fileItems,
    selectedIndex: fileSelectedIndex,
    isLoading: isFileLoading,
    showMediaOption,
    setSelectedIndex: setFileSelectedIndex,
    setFilePickerMode,
    setFolderPath,
    handleFileMenuKey,
    resetFilePicker,
  } = useFilePicker(
    activeToken,
    applyMention,
    () => {
      void handlePickMedia();
    },
    removeActiveToken,
  );

  const closeMenus = useCallback(() => {
    if (showSlashMenu || showFileMenu) {
      removeActiveToken();
    }
  }, [showSlashMenu, showFileMenu, removeActiveToken]);

  useClickOutside([textareaRef, menuRef], showSlashMenu || showFileMenu, closeMenus);

  useEffect(() => {
    resetSlashMenu();
  }, [showSlashMenu, resetSlashMenu]);

  useEffect(() => {
    if (!showFileMenu) {
      resetFilePicker();
    }
  }, [showFileMenu, resetFilePicker]);

  useEffect(() => {
    const unsub = bridge.on<{ mention: string }>(Events.InsertMention, ({ mention }) => {
      setText((prev) => prev + mention + " ");

      setTimeout(() => {
        textareaRef.current?.focus();
        adjustHeight();
      }, 0);
    });

    return unsub;
  }, [adjustHeight]);

  const handleKeyDown = useMemoizedFn((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) {
      return;
    }

    if (handleSlashMenuKey(e)) {
      return;
    }

    if (handleFileMenuKey(e)) {
      return;
    }

    if (handleHistoryKey(e)) {
      return;
    }

    if (extensionConfig.useCtrlEnterToSend) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSend();
      }
    } else {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    }
  });

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    setCursorPos(e.target.selectionStart);
    resetHistoryIndex();
    setTimeout(adjustHeight, 0);
  };

  const handleSelect = () => {
    setCursorPos(textareaRef.current?.selectionStart ?? 0);
  };

  const handleAddButtonClick = useMemoizedFn(() => {
    const newText = text + "@";
    setText(newText);
    setCursorPos(newText.length);
    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(newText.length, newText.length);
      adjustHeight();
    }, 0);
  });

  const hasModels = availableModels.length > 0;
  const canSend = (text.trim() || draftMedia.length > 0) && !isProcessing;

  return (
    <div className="p-2 pt-0! flex flex-col min-h-0">
      <BottomToolbar />
      <div className="relative shrink-0">
        {showSlashMenu && filteredCommands.length > 0 && (
          <div ref={menuRef} className="absolute bottom-full left-0 right-0 mb-2 z-10">
            <SlashCommandMenu
              commands={filteredCommands}
              query={activeToken?.query || ""}
              selectedIndex={slashSelectedIndex}
              onSelect={handleSlashCommand}
              onHover={setSlashSelectedIndex}
            />
          </div>
        )}

        {showFileMenu && (
          <div ref={menuRef} className="absolute bottom-full left-0 right-0 mb-2 z-10">
            <FilePickerMenu
              mode={filePickerMode}
              items={fileItems}
              currentPath={folderPath}
              selectedIndex={fileSelectedIndex}
              isLoading={isFileLoading}
              showMediaOption={showMediaOption}
              onSelectMedia={() => {
                void handlePickMedia();
              }}
              onSwitchToFolder={() => {
                setFilePickerMode("folder");
                setFolderPath("");
                setFileSelectedIndex(0);
              }}
              onSwitchToSearch={() => {
                setFilePickerMode("search");
                setFolderPath("");
                setFileSelectedIndex(0);
              }}
              onSelectItem={(item) => applyMention(item.path)}
              onNavigateUp={() => {
                setFolderPath(folderPath.split("/").slice(0, -1).join("/"));
                setFileSelectedIndex(0);
              }}
              onNavigateInto={(item) => {
                setFilePickerMode("folder");
                setFolderPath(item.path);
                setFileSelectedIndex(0);
              }}
              onHover={setFileSelectedIndex}
            />
          </div>
        )}

        <div className="border border-input rounded-md overflow-hidden">
          {draftMedia.length > 0 && (
            <div className="flex gap-2 p-2 overflow-x-auto">
              {draftMedia.map((item) => (
                <MediaThumbnail
                  key={item.id}
                  src={item.dataUri}
                  size="sm"
                  onClick={item.dataUri ? () => setPreviewMedia(item.dataUri!) : undefined}
                  onRemove={() => removeDraftMedia(item.id)}
                />
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onSelect={handleSelect}
            onPaste={handlePaste}
            placeholder={isStreaming ? "Add a follow-up..." : "Ask Kimi Code... (/ commands · @ files · Alt+K code)"}
            className={cn(
              "w-full min-h-12 max-h-35 px-2.5 py-1.5 text-xs leading-relaxed",
              "bg-transparent resize-none outline-none border-none overflow-y-auto",
              "placeholder:text-muted-foreground",
            )}
          />

          <div className="flex items-center justify-between px-1.5 pb-1.5">
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="gap-0.5 text-accent-foreground border-0! h-6 px-1.5 min-w-0 max-w-[calc(100%-4rem)]"
                        disabled={isStreaming || !hasModels}
                      >
                        {/* Name stays readable longest: the dimmed provider
                            suffix carries a higher shrink factor so space
                            pressure truncates it before the model name, and
                            below 520px it drops out entirely (still shown in
                            the tooltip and the dropdown) — a narrow sidebar
                            has no room for both. */}
                        <span className="flex min-w-0 items-center text-xs">
                          <span className="truncate">{currentModelConfig?.name ?? "No models available"}</span>
                          {currentModelConfig !== undefined && showProviderGroups && (
                            <span className="shrink-[3] truncate text-muted-foreground max-[520px]:hidden">
                              {" · "}{providerDisplayName(currentModelConfig.provider)}
                            </span>
                          )}
                        </span>
                        {hasModels && <IconChevronDown className="size-3.5 shrink-0" />}
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{currentModelLabel}</TooltipContent>
                </Tooltip>
                <DropdownMenuContent className="w-52!" align="start">
                  {modelGroups.map((group, groupIndex) => (
                    <Fragment key={group.provider}>
                      {showProviderGroups && <DropdownMenuLabel>{group.label}</DropdownMenuLabel>}
                      {group.models.map((model) => (
                        <DropdownMenuItem
                          key={model.id}
                          onClick={() => updateModel(model.id)}
                          className={cn("text-xs px-3 py-1.5 cursor-pointer", currentModel === model.id && "bg-accent")}
                        >
                          {model.name}
                        </DropdownMenuItem>
                      ))}
                      {showProviderGroups && groupIndex < modelGroups.length - 1 && <DropdownMenuSeparator />}
                    </Fragment>
                  ))}
                  {hasConversationHistory && (
                    <>
                      <DropdownMenuSeparator />
                      <div className="px-3 py-1.5 text-[10px] leading-snug whitespace-normal text-muted-foreground">
                        {SWITCH_CACHE_NOTE}
                      </div>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>

              <ThinkingButton
                mode={thinkingMode}
                effort={thinkingEffort}
                efforts={currentModelConfig?.support_efforts}
                alwaysOn={currentModelConfig?.capabilities.includes("always_thinking")}
                disabled={isStreaming}
                cacheNote={hasConversationHistory ? SWITCH_CACHE_NOTE : undefined}
                onToggle={toggleThinking}
                onSelectEffort={selectThinkingEffort}
              />
              <PlanModeButton active={planMode} onToggle={handleTogglePlanMode} />
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-xs" onClick={handleAddButtonClick} className="text-muted-foreground">
                    <IconPlus className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Add files or media</TooltipContent>
              </Tooltip>

              <ActionMenu onAuthAction={onAuthAction} />

              {isStreaming ? (
                <Button variant="destructive" size="icon-xs" onClick={abort}>
                  <IconPlayerStop className="size-3.5" />
                </Button>
              ) : (
                <Button variant="default" size="icon-xs" onClick={handleSend} disabled={!canSend}>
                  <IconSend className="size-3.5" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
      <MediaPreviewModal src={previewMedia} onClose={() => setPreviewMedia(null)} />
      <StreamingConfirmDialog
        open={showPlanModeConfirm}
        onOpenChange={setShowPlanModeConfirm}
        title="Exit Plan Mode"
        description="The agent is still working. Exiting plan mode now will affect the current turn. Are you sure you want to exit plan mode immediately?"
        confirmLabel="Exit Now"
        onConfirm={handleConfirmExitPlanMode}
      />
    </div>
  );
}
