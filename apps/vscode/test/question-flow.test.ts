import { describe, expect, it } from "vitest";
import {
  answerQuestion,
  answerQuestionWithCustom,
  canAdvanceQuestion,
  createQuestionFlow,
  moveQuestion,
  toggleQuestionOption,
} from "../webview-ui/src/components/question-flow";

const questions = [
  { question: "Languages?", multi_select: true },
  { question: "Editor?", multi_select: false },
] as const;
const languageQuestion = questions[0];
const editorQuestion = questions[1];

describe("question flow", () => {
  it("keeps multi-select choices on the current question until the user advances", () => {
    let flow = createQuestionFlow(questions);

    flow = toggleQuestionOption(flow, languageQuestion, "Go");
    flow = toggleQuestionOption(flow, languageQuestion, "TypeScript");

    expect(flow.questionIndex).toBe(0);
    expect(flow.answers).toEqual({ "Languages?": "Go, TypeScript" });
    expect(canAdvanceQuestion(flow, languageQuestion)).toBe(true);
  });

  it("can return to an earlier question without losing either answer", () => {
    let flow = createQuestionFlow(questions);
    flow = answerQuestion(flow, languageQuestion, "Go");
    flow = moveQuestion(flow, 1, questions.length);
    flow = answerQuestion(flow, editorQuestion, "VS Code");

    flow = moveQuestion(flow, -1, questions.length);

    expect(flow.questionIndex).toBe(0);
    expect(flow.answers).toEqual({ "Languages?": "Go", "Editor?": "VS Code" });
  });

  it("does not advance beyond the final review step", () => {
    let flow = createQuestionFlow(questions);
    flow = answerQuestion(flow, languageQuestion, "Go");
    flow = moveQuestion(flow, 1, questions.length);
    flow = answerQuestion(flow, editorQuestion, "VS Code");

    expect(moveQuestion(flow, 1, questions.length).questionIndex).toBe(1);
    expect(flow.answers).toEqual({ "Languages?": "Go", "Editor?": "VS Code" });
  });

  it("combines a custom response with multi-select options and restores it", () => {
    let flow = createQuestionFlow(questions);
    flow = toggleQuestionOption(flow, languageQuestion, "Go");
    flow = answerQuestionWithCustom(flow, languageQuestion, "Rust");

    expect(flow.answers).toEqual({ "Languages?": "Go, Rust" });
    expect(flow.customAnswers["Languages?"]).toBe("Rust");
    expect(flow.selections["Languages?"]).toEqual(["Go"]);
  });

  it("can advance with only a custom response", () => {
    const flow = answerQuestionWithCustom(createQuestionFlow(questions), editorQuestion, "Neovim");

    expect(canAdvanceQuestion(flow, editorQuestion)).toBe(true);
    expect(flow.answers).toEqual({ "Editor?": "Neovim" });
  });

  it("removes a cleared custom response while preserving selected options", () => {
    let flow = createQuestionFlow(questions);
    flow = toggleQuestionOption(flow, languageQuestion, "Go");
    flow = answerQuestionWithCustom(flow, languageQuestion, "Rust");

    flow = answerQuestionWithCustom(flow, languageQuestion, "");

    expect(flow.answers).toEqual({ "Languages?": "Go" });
    expect(flow.customAnswers).toEqual({});
    expect(flow.selections["Languages?"]).toEqual(["Go"]);
  });
});
