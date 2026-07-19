// @vitest-environment jsdom
/// <reference lib="dom" />

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionDialog } from "../webview-ui/src/components/QuestionDialog";

const { respondQuestion } = vi.hoisted(() => ({
  respondQuestion: vi.fn(async () => undefined),
}));

vi.mock("@/stores", () => ({
  useChatStore: () => ({
    pendingQuestion: {
      id: "question-request",
      tool_call_id: "tool-call",
      questions: [
        {
          header: "Target",
          question: "Choose a target",
          options: [{ label: "Tests" }],
        },
        {
          header: "Scope",
          question: "Choose a scope",
          options: [{ label: "Focused" }],
        },
      ],
    },
    respondQuestion,
  }),
}));

describe("QuestionDialog", () => {
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    container?.remove();
    container = undefined;
    respondQuestion.mockClear();
  });

  it("collects every question before submitting the response", async () => {
    const element = document.createElement("div");
    container = element;
    document.body.append(element);
    const root = createRoot(element);

    await act(async () => {
      root.render(React.createElement(QuestionDialog));
    });

    expect(element.textContent).toContain("Question 1 of 2");
    expect(element.textContent).toContain("Choose a target");

    await act(async () => {
      element.querySelector<HTMLButtonElement>("button")?.click();
    });

    expect(respondQuestion).not.toHaveBeenCalled();
    expect(element.textContent).toContain("Question 2 of 2");
    expect(element.textContent).toContain("Choose a scope");

    await act(async () => {
      element.querySelector<HTMLButtonElement>("button")?.click();
    });

    expect(respondQuestion).toHaveBeenCalledWith({
      "Choose a target": "Tests",
      "Choose a scope": "Focused",
    });

    await act(async () => {
      root.unmount();
    });
  });
});
