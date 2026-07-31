// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuestionDialog } from "../webview-ui/src/components/QuestionDialog";

const store = vi.hoisted(() => ({
  pendingQuestion: {
    id: "question-1",
    tool_call_id: "tool-1",
    questions: [
      {
        question: "Languages?",
        options: [{ label: "Go" }, { label: "TypeScript" }],
        multi_select: true,
      },
      {
        question: "Editor?",
        options: [{ label: "VS Code" }, { label: "Vim" }],
        multi_select: false,
      },
    ],
  },
  respondQuestion: vi.fn<(_: Record<string, string>) => Promise<void>>(),
}));

vi.mock("@/stores", () => ({ useChatStore: () => store }));

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(label),
  );
  if (!match) throw new Error(`button not found: ${label}`);
  return match;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("QuestionDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    store.respondQuestion.mockReset().mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<QuestionDialog />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("preserves multi and custom answers across Back and submits only explicitly", async () => {
    await click(button(container, "Go"));
    expect(store.respondQuestion).not.toHaveBeenCalled();

    await click(button(container, "Custom response"));
    const input = container.querySelector("input");
    if (!input) throw new Error("custom response input not found");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "Rust");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button(container, "Send"));
    await click(button(container, "Next"));
    await click(button(container, "Custom response"));
    const editorInput = container.querySelector("input");
    if (!editorInput) throw new Error("editor custom response input not found");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(editorInput, "Neovim");
      editorInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button(container, "Send"));
    expect(store.respondQuestion).not.toHaveBeenCalled();

    await click(button(container, "Back"));
    expect(container.textContent).toContain("Rust");
    await click(button(container, "Next"));

    const submit = button(container, "Submit answers");
    await act(async () => {
      submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(store.respondQuestion).toHaveBeenCalledTimes(1);
    expect(store.respondQuestion).toHaveBeenCalledWith({
      "Languages?": "Go, Rust",
      "Editor?": "Neovim",
    });
  });

  it("lets users remove a custom multi-select answer before submitting", async () => {
    await click(button(container, "Go"));
    await click(button(container, "Custom response"));
    const input = container.querySelector("input");
    if (!input) throw new Error("custom response input not found");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "Rust");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button(container, "Send"));

    await click(button(container, "Rust"));
    const reopenedInput = container.querySelector("input");
    if (!reopenedInput) throw new Error("reopened custom response input not found");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(reopenedInput, "");
      reopenedInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = button(container, "Send");
    expect(save.disabled).toBe(false);
    await click(save);

    await click(button(container, "Next"));
    await click(button(container, "VS Code"));
    await click(button(container, "Submit answers"));

    expect(store.respondQuestion).toHaveBeenCalledWith({
      "Languages?": "Go",
      "Editor?": "VS Code",
    });
  });
});
