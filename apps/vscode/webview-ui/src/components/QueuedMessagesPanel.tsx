import { useState } from "react";
import { IconTrash, IconArrowUp, IconPencil, IconCheck, IconX, IconBolt } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { useChatStore } from "@/stores";
import { bridge } from "@/services";
import { Content } from "@/lib/content";

import type { ContentPart } from "shared/legacy-sdk";

function QueueItem({ id, content, isStreaming, onEdit }: { id: string; content: string | ContentPart[]; isStreaming: boolean; onEdit: (id: string) => void }) {
  const { removeFromQueue, moveQueueItemUp, queue } = useChatStore();
  const text = Content.getText(content);
  const hasMedia = Content.hasMedia(content);
  const isFirst = queue[0]?.id === id;

  const handleSteer = async () => {
    const result = await bridge.steerChat(content);
    if (result.ok) {
      removeFromQueue(id);
    }
  };

  return (
    <div className="group flex items-start px-2.5 py-0.5 hover:bg-muted/50 transition-colors">
      <div className="flex-1 min-w-0">
        <p className="text-xs line-clamp-2 text-foreground">{text || (hasMedia ? "(media)" : "")}</p>
        {hasMedia && text && <span className="text-[10px] text-muted-foreground">+ media</span>}
      </div>
      <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        {isStreaming && (
          <Button
            variant="ghost"
            size="icon"
            className="size-5 border-0! text-amber-500 hover:text-amber-600"
            onClick={() => {
              void handleSteer();
            }}
            title="Insert now (steer)"
          >
            <IconBolt className="size-3" />
          </Button>
        )}
        <Button variant="ghost" size="icon" className="size-5 border-0!" onClick={() => onEdit(id)}>
          <IconPencil className="size-3" />
        </Button>
        {!isFirst && (
          <Button variant="ghost" size="icon" className="size-5 border-0!" onClick={() => moveQueueItemUp(id)}>
            <IconArrowUp className="size-3" />
          </Button>
        )}
        <Button variant="ghost" size="icon" className="size-5 border-0! text-muted-foreground hover:text-destructive" onClick={() => removeFromQueue(id)}>
          <IconTrash className="size-3" />
        </Button>
      </div>
    </div>
  );
}

function EditingItem({ id, initialContent, onDone }: { id: string; initialContent: string; onDone: () => void }) {
  const [text, setText] = useState(initialContent);
  const { editQueueItem } = useChatStore();

  const handleSave = () => {
    if (text.trim()) {
      editQueueItem(id, text);
    }
    onDone();
  };

  return (
    <div className="flex items-center px-2.5 py-0.5">
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSave();
          if (e.key === "Escape") onDone();
        }}
        className="flex-1 min-w-0 text-xs bg-transparent border-b border-border outline-none py-0.5"
      />
      <Button variant="ghost" size="icon" className="size-5 border-0!" onClick={handleSave}>
        <IconCheck className="size-3" />
      </Button>
      <Button variant="ghost" size="icon" className="size-5 border-0!" onClick={onDone}>
        <IconX className="size-3" />
      </Button>
    </div>
  );
}

export function QueuedMessagesPanel() {
  const { queue, isStreaming } = useChatStore();
  const [editingId, setEditingId] = useState<string | null>(null);

  if (queue.length === 0) return null;

  return (
    <div className="max-h-48 overflow-y-auto bg-card shrink">
      {queue.map((item) =>
        editingId === item.id ? (
          <EditingItem key={item.id} id={item.id} initialContent={Content.getText(item.content)} onDone={() => setEditingId(null)} />
        ) : (
          <QueueItem key={item.id} id={item.id} content={item.content} isStreaming={isStreaming} onEdit={setEditingId} />
        ),
      )}
    </div>
  );
}
