import { useRef, useMemo, useState, useEffect, useCallback } from "react";
import { useMemoizedFn } from "ahooks";
import { useShallow } from "zustand/react/shallow";
import {
  IconSend,
  IconPlayerStop,
  IconChevronDown,
  IconPlus,
  IconArrowUp,
  IconArrowDown,
  IconBolt,
  IconCheck,
  IconPencil,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ActionMenu } from "../ActionMenu";
import { SlashCommandMenu } from "../SlashCommandMenu";
import { FilePickerMenu } from "../FilePickerMenu";
import { MediaThumbnail } from "../MediaThumbnail";
import { MediaPreviewModal } from "../MediaPreviewModal";
import { FileChangesBar } from "../FileChangesBar";
import { ThinkingButton } from "../ThinkingButton";
import { ChatStatus } from "../ChatStatus";
import { useChatStore, useSettingsStore, getModelById, getModelsForMedia } from "@/stores";
import { bridge, Events } from "@/services";
import { Content } from "@/lib/content";
import { cn } from "@/lib/utils";
import { useSlashMenu, findActiveToken } from "./hooks/useSlashMenu";
import { useFilePicker } from "./hooks/useFilePicker";
import { useMediaUpload } from "./hooks/useMediaUpload";
import { useClickOutside } from "./hooks/useClickOutside";
import { computeMentionInsert } from "./utils";
import { availableCommandsToSlashCommands } from "@/services";
import type { DisplayMessage, DisplayPart } from "@moonshot-ai/kimi-code-vscode-display-model";

function updateMediaRequirementFromParts(parts: DisplayPart[], mediaReq: { image: boolean; video: boolean }): void {
  for (const part of parts) {
    if (part.type === "media") {
      if (part.kind === "image") {
        mediaReq.image = true;
      } else if (part.kind === "video") {
        mediaReq.video = true;
      }
    }

    if (part.type === "tool-call" && part.children) {
      for (const child of part.children) {
        updateMediaRequirementFromParts(child.parts, mediaReq);
      }
    }
  }
}

export function InputArea() {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const [previewMedia, setPreviewMedia] = useState<string | null>(null);
  const [editingQueuedId, setEditingQueuedId] = useState<string | null>(null);
  const [editingQueuedText, setEditingQueuedText] = useState("");

  const {
    isStreaming,
    sendMessage,
    abort,
    draftMedia,
    removeDraftMedia,
    hasProcessingMedia,
    pendingInput,
    queuedInputs,
    updateQueuedInput,
    removeQueuedInput,
    moveQueuedInput,
    clearQueuedInputs,
    steerQueuedInput,
    steerAllQueuedInputs,
    availableCommands,
  } = useChatStore(
    useShallow((state) => ({
      isStreaming: state.isStreaming,
      sendMessage: state.sendMessage,
      abort: state.abort,
      draftMedia: state.draftMedia,
      removeDraftMedia: state.removeDraftMedia,
      hasProcessingMedia: state.hasProcessingMedia,
      pendingInput: state.pendingInput,
      queuedInputs: state.queuedInputs,
      updateQueuedInput: state.updateQueuedInput,
      removeQueuedInput: state.removeQueuedInput,
      moveQueuedInput: state.moveQueuedInput,
      clearQueuedInputs: state.clearQueuedInputs,
      steerQueuedInput: state.steerQueuedInput,
      steerAllQueuedInputs: state.steerAllQueuedInputs,
      availableCommands: state.displayState.availableCommands,
    })),
  );
  const mediaReq = useChatStore(
    useShallow((state) => {
      let image = false;
      let video = false;

      for (const item of state.draftMedia) {
        if (!item.dataUri) {
          continue;
        }
        if (item.dataUri.startsWith("data:image/")) {
          image = true;
        } else if (item.dataUri.startsWith("data:video/")) {
          video = true;
        }
      }

      for (const message of state.displayState.messages) {
        const mediaReq: { image: boolean; video: boolean } = { image, video };
        updateMediaRequirementFromParts(message.parts, mediaReq);
        if (message.steps) {
          for (const step of message.steps) {
            updateMediaRequirementFromParts(step.parts, mediaReq);
          }
        }
        image = mediaReq.image;
        video = mediaReq.video;
        if (image && video) {
          break;
        }
      }

      return { image, video };
    }),
  );
  const { currentModel, thinkingEnabled, updateModel, toggleThinking, models, extensionConfig, getCurrentThinkingMode } = useSettingsStore(
    useShallow((state) => ({
      currentModel: state.currentModel,
      thinkingEnabled: state.thinkingEnabled,
      updateModel: state.updateModel,
      toggleThinking: state.toggleThinking,
      models: state.models,
      extensionConfig: state.extensionConfig,
      getCurrentThinkingMode: state.getCurrentThinkingMode,
    })),
  );

  const isProcessing = hasProcessingMedia();
  const thinkingMode = getCurrentThinkingMode();

  const availableModels = useMemo(() => getModelsForMedia(models, mediaReq), [models, mediaReq]);
  const currentModelConfig = getModelById(models, currentModel);

  // Auto-switch model if current model doesn't support required media
  useEffect(() => {
    if (!mediaReq.image && !mediaReq.video) {
      return;
    }
    const isCurrentModelValid = availableModels.some((m) => m.id === currentModel);
    if (isCurrentModelValid) {
      return;
    }
    if (availableModels.length > 0) {
      updateModel(availableModels[0].id);
    }
  }, [mediaReq.image, mediaReq.video, currentModel, availableModels, updateModel]);

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

  const { canAddMedia, handlePaste, handlePickMedia } = useMediaUpload();

  const adjustHeight = useMemoizedFn(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
    }
  });

  const clearInput = useMemoizedFn(() => {
    setText("");
    setCursorPos(0);
    setTimeout(adjustHeight, 0);
  });

  const handleSend = useMemoizedFn(() => {
    if (isProcessing || (!text.trim() && draftMedia.length === 0)) {
      return;
    }

    // While streaming, sendMessage queues the text (type-ahead). Queued items
    // auto-send FIFO when the current run completes; Ctrl/Cmd+S steers them.
    sendMessage(text);
    clearInput();
  });

  const handleSlashCommand = useMemoizedFn((name: string) => {
    sendMessage(`/${name}`);
    clearInput();
  });

  const steerCurrentOrQueued = useMemoizedFn(() => {
    if (!isStreaming) {
      return;
    }

    const currentText = text.trim() && draftMedia.length === 0 ? text.trim() : undefined;
    if (queuedInputs.length === 0 && !currentText) {
      return;
    }

    steerAllQueuedInputs(currentText);
    if (currentText) {
      clearInput();
    }
  });

  const startEditingQueuedInput = useMemoizedFn((id: string, value: string) => {
    setEditingQueuedId(id);
    setEditingQueuedText(value);
  });

  const cancelEditingQueuedInput = useMemoizedFn(() => {
    setEditingQueuedId(null);
    setEditingQueuedText("");
  });

  // If a queued item being edited is auto-sent or removed, clear the editing
  // state so the editing UI does not outlive the item ("ghost edit").
  useEffect(() => {
    if (editingQueuedId && !queuedInputs.some((item) => item.id === editingQueuedId)) {
      cancelEditingQueuedInput();
    }
  }, [queuedInputs, editingQueuedId, cancelEditingQueuedInput]);

  const saveEditingQueuedInput = useMemoizedFn((id: string) => {
    updateQueuedInput(id, editingQueuedText);
    setEditingQueuedId(null);
    setEditingQueuedText("");
  });

  const handleQueuedEditKeyDown = useMemoizedFn((e: React.KeyboardEvent<HTMLTextAreaElement>, id: string) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancelEditingQueuedInput();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      saveEditingQueuedInput(id);
    }
  });

  const applyMention = useMemoizedFn((filePath: string, isAppend: boolean) => {
    const { newText, newCursorPos } = computeMentionInsert({
      text,
      cursorPos,
      filePath,
      activeToken,
      isAppend,
    });

    setText(newText);
    setCursorPos(newCursorPos);

    if (isAppend) {
      setShowAddMenu(false);
    }

    setTimeout(() => {
      textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos);
      textareaRef.current?.focus();
      adjustHeight();
    }, 0);
  });

  const slashCommands = useMemo(() => availableCommandsToSlashCommands(availableCommands), [availableCommands]);

  const {
    showSlashMenu,
    filteredCommands,
    groupedCommands: groupedSlashCommands,
    selectedIndex: slashSelectedIndex,
    setSelectedIndex: setSlashSelectedIndex,
    handleSlashMenuKey,
    resetSlashMenu,
  } = useSlashMenu(activeToken, slashCommands, handleSlashCommand, clearInput);

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
    loadAllFiles,
    setShowAddMenu,
    showAddMenu,
  } = useFilePicker(
    activeToken,
    (filePath, isAddMenu) => applyMention(filePath, isAddMenu),
    () => {
      handlePickMedia();
      setShowAddMenu(false);
    },
    clearInput,
  );

  const closeMenus = useCallback(() => {
    if (showSlashMenu) {
      clearInput();
    }

    if (showFileMenu) {
      if (showAddMenu) {
        setShowAddMenu(false);
      } else {
        clearInput();
      }
    }
  }, [showSlashMenu, showFileMenu, showAddMenu, clearInput, setShowAddMenu]);

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

  const handleModelChange = useMemoizedFn((modelId: string) => {
    updateModel(modelId);
  });

  const handleKeyDown = useMemoizedFn((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) {
      return;
    }

    if (isStreaming && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      steerCurrentOrQueued();
      return;
    }

    if (handleSlashMenuKey(e)) {
      return;
    }

    if (handleFileMenuKey(e)) {
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
    setTimeout(adjustHeight, 0);
  };

  const handleSelect = () => {
    setCursorPos(textareaRef.current?.selectionStart ?? 0);
  };

  const handleAddButtonClick = useMemoizedFn(() => {
    setShowAddMenu(true);
    setFileSelectedIndex(0);
    loadAllFiles();
  });

  const hasModels = availableModels.length > 0;
  const canSend = (text.trim() || draftMedia.length > 0) && !isProcessing;
  const canSteerAll = isStreaming && (queuedInputs.length > 0 || (text.trim().length > 0 && draftMedia.length === 0));

  return (
    <div className="p-2 pt-0!">
      <FileChangesBar />

      <div className="relative">
        {showSlashMenu && filteredCommands.length > 0 && (
          <div ref={menuRef} className="absolute bottom-full left-0 right-0 mb-2 z-10">
            <SlashCommandMenu
              commands={filteredCommands}
              groupedCommands={groupedSlashCommands}
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
                handlePickMedia();
                setShowAddMenu(false);
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
              onSelectItem={(item) => applyMention(item.path, showAddMenu)}
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

          {queuedInputs.length > 0 && (
            <div className="mx-2 mt-2 space-y-1.5 rounded bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <span className="shrink-0 font-medium text-foreground/80">Queued {queuedInputs.length} ↵</span>
                <span className="min-w-0 flex-1 truncate">Ctrl/Cmd+S steers all queued messages.</span>
                <button
                  onClick={steerCurrentOrQueued}
                  disabled={!canSteerAll}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-500/10 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                  title="Steer all queued messages now"
                >
                  全部插队
                </button>
                <button
                  onClick={clearQueuedInputs}
                  className="shrink-0 rounded px-1.5 py-0.5 hover:text-foreground hover:bg-muted transition-colors"
                  title="Clear all queued messages"
                >
                  清空
                </button>
              </div>

              {queuedInputs.map((item, index) => {
                const isEditing = editingQueuedId === item.id;
                return (
                  <div key={item.id} className="flex items-start gap-1.5 rounded px-1 py-1 hover:bg-muted/50 transition-colors">
                    <span className="shrink-0 mt-px w-4 text-right text-foreground/60">{index + 1}.</span>
                    {isEditing ? (
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <textarea
                          value={editingQueuedText}
                          onChange={(e) => setEditingQueuedText(e.target.value)}
                          onKeyDown={(e) => handleQueuedEditKeyDown(e, item.id)}
                          className="min-h-12 w-full resize-y rounded border border-input bg-background px-2 py-1 text-[11px] leading-relaxed text-foreground outline-none focus:border-ring"
                          autoFocus
                        />
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => saveEditingQueuedInput(item.id)}
                            className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-foreground hover:bg-muted transition-colors"
                            title="Save queued message"
                          >
                            <IconCheck className="size-3.5" />
                            保存
                          </button>
                          <button
                            onClick={cancelEditingQueuedInput}
                            className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                            title="Cancel editing"
                          >
                            <IconX className="size-3.5" />
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 break-words whitespace-pre-wrap text-foreground/80 max-h-10 overflow-hidden">{item.text}</span>
                        <div className="flex shrink-0 items-center gap-0.5">
                          <button
                            onClick={() => steerQueuedInput(item.id)}
                            disabled={!isStreaming}
                            className="rounded p-0.5 text-blue-600 dark:text-blue-400 hover:bg-blue-500/10 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                            title="Steer this queued message now"
                          >
                            <IconBolt className="size-3.5" />
                          </button>
                          <button
                            onClick={() => moveQueuedInput(item.id, "up")}
                            disabled={index === 0}
                            className="rounded p-0.5 hover:bg-muted hover:text-foreground transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                            title="Move up"
                          >
                            <IconArrowUp className="size-3.5" />
                          </button>
                          <button
                            onClick={() => moveQueuedInput(item.id, "down")}
                            disabled={index === queuedInputs.length - 1}
                            className="rounded p-0.5 hover:bg-muted hover:text-foreground transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                            title="Move down"
                          >
                            <IconArrowDown className="size-3.5" />
                          </button>
                          <button
                            onClick={() => startEditingQueuedInput(item.id, item.text)}
                            className="rounded p-0.5 hover:bg-muted hover:text-foreground transition-colors"
                            title="Edit queued message"
                          >
                            <IconPencil className="size-3.5" />
                          </button>
                          <button
                            onClick={() => removeQueuedInput(item.id)}
                            className="rounded p-0.5 hover:bg-muted hover:text-foreground transition-colors"
                            title="Delete queued message"
                          >
                            <IconTrash className="size-3.5" />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onSelect={handleSelect}
            onPaste={handlePaste}
            placeholder={isStreaming ? "Type a follow-up… (queued until the run finishes; Ctrl/Cmd+S steers)" : "Ask Kimi... (/ for commands, @ for files)"}
            className={cn(
              "w-full min-h-12 max-h-35 px-2.5 py-1.5 text-xs leading-relaxed",
              "bg-transparent resize-none outline-none border-none overflow-y-auto",
              "placeholder:text-muted-foreground",
            )}
          />

          <div className="flex items-center justify-between px-1.5 pb-1.5">
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="gap-0.5 text-accent-foreground border-0! h-6 px-1.5 min-w-0 max-w-[calc(100%-4rem)] justify-start text-left"
                    disabled={isStreaming || !hasModels}
                  >
                    <span className="text-xs truncate block min-w-0 max-w-full text-left">{currentModelConfig?.name || "No model available"}</span>
                    {hasModels && <IconChevronDown className="size-3.5 shrink-0" />}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-52!" align="start">
                  {availableModels.map((model) => (
                    <DropdownMenuItem
                      key={model.id}
                      onClick={() => handleModelChange(model.id)}
                      className={cn("text-xs px-3 py-1.5 cursor-pointer min-w-0 max-w-full text-left", currentModel === model.id && "bg-accent")}
                    >
                      <span className="block min-w-0 max-w-full truncate text-left">{model.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <ThinkingButton mode={thinkingMode} enabled={thinkingEnabled} disabled={isStreaming} onToggle={toggleThinking} />
              <ChatStatus />
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-xs" onClick={handleAddButtonClick} className="text-muted-foreground" disabled={isStreaming}>
                    <IconPlus className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Add files or media</TooltipContent>
              </Tooltip>

              <ActionMenu />

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
    </div>
  );
}
