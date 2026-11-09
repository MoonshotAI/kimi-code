import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ChatMessage, countAssistantActivities, partitionAssistantSteps } from "@/components/ChatMessage";
import type { ChatMessage as ChatMessageType, UIStep } from "@/stores/chat.store";

function assistant(workState: ChatMessageType["workState"]): ChatMessageType {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "Progress before edit.Final answer remains visible.",
    timestamp: 1,
    workState,
    steps: [
      {
        n: 1,
        items: [
          { type: "thinking", content: "Inspecting the file", finished: true },
          { type: "text", content: "Progress before edit.", finished: true },
          {
            type: "tool_use",
            id: "write-1",
            call: { id: "write-1", name: "WriteFile", arguments: JSON.stringify({ path: "src/file.ts", mode: "overwrite" }) },
            result: { is_error: false, output: "ok", message: "", display: [] },
          },
          { type: "text", content: "Final answer remains visible.", finished: true },
        ],
      },
    ],
  };
}

describe("partitionAssistantSteps", () => {
  it("groups thinking, edits, and pre-edit progress while leaving the trailing answer visible", () => {
    const steps = assistant("complete").steps as UIStep[];
    const result = partitionAssistantSteps(steps);

    expect(result.activitySteps).toHaveLength(1);
    expect(result.activitySteps[0].items.map((item) => item.type)).toEqual(["thinking", "text", "tool_use"]);
    expect(result.responseItems.map(({ item }) => item.type)).toEqual(["text"]);
    expect(result.responseItems[0].item).toMatchObject({ content: "Final answer remains visible." });
  });

  it("omits the disclosure for a text-only answer", () => {
    const result = partitionAssistantSteps([{ n: 1, items: [{ type: "text", content: "Answer", finished: true }] }]);
    expect(result.activitySteps).toEqual([]);
    expect(result.responseItems).toHaveLength(1);
  });

  it("counts activities inside one SDK step instead of counting the container", () => {
    const step: UIStep = {
      n: 1,
      items: [
        { type: "thinking", content: "First thought" },
        { type: "tool_use", id: "read-1", call: { id: "read-1", name: "ReadFile", arguments: "{}" } },
        { type: "thinking", content: "Second thought" },
        { type: "tool_use", id: "read-2", call: { id: "read-2", name: "ReadFile", arguments: "{}" } },
        { type: "tool_use", id: "read-3", call: { id: "read-3", name: "ReadFile", arguments: "{}" } },
        { type: "tool_use", id: "edit-1", call: { id: "edit-1", name: "StrReplaceFile", arguments: "{}" } },
        { type: "tool_use", id: "edit-2", call: { id: "edit-2", name: "WriteFile", arguments: "{}" } },
        { type: "text", content: "Text does not inflate activity count" },
      ],
    };

    expect(countAssistantActivities([step])).toBe(7);
  });

  it("counts nested subagent activity recursively but excludes nested text", () => {
    const step: UIStep = {
      n: 1,
      items: [{
        type: "tool_use",
        id: "task-1",
        call: { id: "task-1", name: "Task", arguments: "{}" },
        subagent_steps: [{
          n: 1,
          items: [
            { type: "thinking", content: "Inspect" },
            { type: "tool_use", id: "read-1", call: { id: "read-1", name: "ReadFile", arguments: "{}" } },
            { type: "tool_use", id: "edit-1", call: { id: "edit-1", name: "StrReplaceFile", arguments: "{}" } },
            { type: "text", content: "Child answer" },
          ],
        }],
      }],
    };

    expect(countAssistantActivities([step])).toBe(4);
  });
});

describe("ChatMessage work details", () => {
  it("starts expanded while working and collapses once the response completes", () => {
    const { rerender } = render(<ChatMessage message={assistant("working")} isStreaming />);
    const trigger = screen.getByRole("button", { name: /Work details/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.textContent).toContain("2 steps");
    expect(screen.getByText("Final answer remains visible.")).toBeTruthy();

    rerender(<ChatMessage message={assistant("complete")} isStreaming={false} />);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Final answer remains visible.")).toBeTruthy();

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    rerender(<ChatMessage message={assistant("complete")} isStreaming={false} />);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("collapses for input, then reopens when work resumes", () => {
    const { rerender } = render(<ChatMessage message={assistant("working")} isStreaming />);
    const trigger = screen.getByRole("button", { name: /Work details/ });

    rerender(<ChatMessage message={assistant("input_needed")} isStreaming />);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Input needed")).toBeTruthy();

    rerender(<ChatMessage message={assistant("working")} isStreaming />);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("preserves the disclosure choice when a question asks for input", () => {
    const { rerender } = render(<ChatMessage message={assistant("working")} isStreaming />);
    const trigger = screen.getByRole("button", { name: /Work details/ });
    const thinking = screen.getByRole("button", { name: /Thinking/ });
    thinking.focus();

    rerender(<ChatMessage message={assistant("question_pending")} isStreaming />);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(thinking);
    expect(screen.getByText("Input needed")).toBeTruthy();

    rerender(<ChatMessage message={assistant("working")} isStreaming />);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    rerender(<ChatMessage message={assistant("question_pending")} isStreaming />);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps stopped work expanded and restores focus before automatic collapse", () => {
    const { rerender } = render(<ChatMessage message={assistant("working")} isStreaming />);
    const trigger = screen.getByRole("button", { name: /Work details/ });
    const thinking = screen.getByRole("button", { name: /Thinking/ });
    thinking.focus();

    rerender(<ChatMessage message={assistant("complete")} isStreaming={false} />);
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    rerender(<ChatMessage message={assistant("stopped")} isStreaming={false} />);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Work stopped")).toBeTruthy();
  });

  it("keeps expansion isolated per assistant turn", () => {
    const first = { ...assistant("complete"), id: "assistant-first" };
    const second = { ...assistant("complete"), id: "assistant-second" };
    render(
      <>
        <ChatMessage message={first} isStreaming={false} />
        <ChatMessage message={second} isStreaming={false} />
      </>,
    );

    const triggers = screen.getAllByRole("button", { name: /Work details/ });
    const expanded = () => triggers.map((trigger) => trigger.getAttribute("aria-expanded"));
    expect(expanded()).toEqual(["false", "false"]);

    fireEvent.click(triggers[0]);
    expect(expanded()).toEqual(["true", "false"]);

    fireEvent.click(triggers[1]);
    expect(expanded()).toEqual(["true", "true"]);
    expect(triggers[0].getAttribute("aria-controls")).toBeTruthy();
    expect(triggers[1].getAttribute("aria-controls")).toBeTruthy();
    expect(triggers[0].getAttribute("aria-controls")).not.toBe(triggers[1].getAttribute("aria-controls"));

    fireEvent.click(triggers[0]);
    expect(expanded()).toEqual(["false", "true"]);
  });
});
