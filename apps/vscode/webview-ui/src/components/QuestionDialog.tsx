import { useState, useEffect, useRef } from "react";
import { useChatStore } from "@/stores";
import { cn } from "@/lib/utils";
import {
  answerQuestionWithCustom,
  canAdvanceQuestion,
  createQuestionFlow,
  moveQuestion,
  removeCustomAnswer,
  toggleQuestionOption,
} from "./question-flow";

export function QuestionDialog() {
  const { pendingQuestion, respondQuestion } = useChatStore();
  const [customDrafts, setCustomDrafts] = useState<Record<number, string>>({});
  const [selectedIndex, setSelectedIndex] = useState(1);
  const [showCustom, setShowCustom] = useState(false);
  const [flow, setFlow] = useState(() => createQuestionFlow([]));
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const questions = pendingQuestion?.questions ?? [];
  const question = questions[flow.questionIndex];
  const isMultiSelect = question?.multi_select === true;
  const customInput = customDrafts[flow.questionIndex] ?? "";

  useEffect(() => {
    if (pendingQuestion) {
      setShowCustom(false);
      setCustomDrafts({});
      setSelectedIndex(1);
      setFlow(createQuestionFlow(pendingQuestion.questions));
      setSubmitting(false);
      submittingRef.current = false;
    }
  }, [pendingQuestion?.id]);

  if (!pendingQuestion || !question) return null;

  const updateCustomInput = (value: string) => {
    setCustomDrafts((current) => ({ ...current, [flow.questionIndex]: value }));
  };

  const handleSelect = (optionLabel: string) => {
    setFlow((current) => toggleQuestionOption(current, question, optionLabel));
  };

  const handleCustomSubmit = () => {
    const normalizedInput = customInput.trim();
    if (!normalizedInput) return;
    setFlow((current) => answerQuestionWithCustom(current, question, normalizedInput));
    updateCustomInput("");
    setShowCustom(false);
  };

  const openCustom = () => {
    updateCustomInput(isMultiSelect ? customInput : (flow.customAnswers[question.question]?.[0] ?? customInput));
    setShowCustom(true);
  };

  const submitAnswers = async () => {
    if (submittingRef.current || !canAdvanceQuestion(flow, question)) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await respondQuestion(flow.answers);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const move = (offset: number) => {
    setFlow((current) => moveQuestion(current, offset, questions.length));
    setShowCustom(false);
    setSelectedIndex(1);
  };

  const options = question.options || [];
  const customIndex = options.length + 1;

  return (
    <div className={cn("mb-0.5 border border-blue-200 dark:border-blue-800 rounded-lg overflow-hidden bg-background flex flex-col shrink")}>
      <div className="p-2 space-y-2">
        {questions.length > 1 && (
          <div className="text-[10px] text-muted-foreground">
            Question {flow.questionIndex + 1} of {questions.length}
          </div>
        )}
        {question.header && <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{question.header}</div>}
        <div className="text-xs font-semibold text-foreground">{question.question}</div>
        {isMultiSelect && <div className="text-[10px] text-muted-foreground">Select all that apply</div>}
        <div className="space-y-1.5">
          {options.map((option, idx) => {
            const isChecked = flow.selections[question.question]?.includes(option.label) === true;
            return (
              <button
                key={idx}
                onClick={() => {
                  handleSelect(option.label);
                }}
                onMouseEnter={() => setSelectedIndex(idx + 1)}
                disabled={submitting}
                className={cn(
                  "w-full text-left px-2 py-1 rounded-md text-xs transition-colors border cursor-pointer",
                  isChecked
                    ? "bg-blue-500/15 border-blue-500"
                    : selectedIndex === idx + 1
                      ? "bg-blue-500 text-white border-blue-500"
                      : "bg-background border-border hover:bg-muted/50",
                )}
              >
                <span className="mr-2 text-muted-foreground">{isChecked ? "✓" : idx + 1}</span>
                <span className="font-medium">{option.label}</span>
                {option.description && (
                  <span className="ml-2 text-muted-foreground">- {option.description}</span>
                )}
              </button>
            );
          })}
          {(flow.customAnswers[question.question] ?? []).map((value) => isMultiSelect && (
            <button
              key={value}
              type="button"
              disabled={submitting}
              onClick={() => setFlow((current) => removeCustomAnswer(current, question, value))}
              className="w-full text-left px-2 py-1 rounded-md text-xs border border-blue-500 bg-blue-500/15 disabled:opacity-50"
            >
              <span className="mr-2 text-muted-foreground">✓</span>
              <span className="font-medium">{value}</span>
            </button>
          ))}
          {showCustom ? (
            <div className="flex gap-1.5">
              <input
                autoFocus
                value={customInput}
                onChange={(e) => {
                  updateCustomInput(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === "Enter") handleCustomSubmit();
                  if (e.key === "Escape") setShowCustom(false);
                }}
                disabled={submitting}
                placeholder="Enter your response…"
                className="flex-1 px-2 py-1 rounded-md text-xs border border-border bg-background outline-none focus:border-blue-500"
              />
              <button
                onClick={() => {
                  handleCustomSubmit();
                }}
                disabled={submitting || !customInput.trim()}
                className="px-2 py-1 rounded-md text-xs bg-blue-500 text-white disabled:opacity-50 cursor-pointer"
              >
                Send
              </button>
            </div>
          ) : (
            <button
              onClick={() => {
                openCustom();
              }}
              onMouseEnter={() => setSelectedIndex(customIndex)}
              disabled={submitting}
              className={cn(
                "w-full text-left px-2 py-1 rounded-md text-xs transition-colors border cursor-pointer",
                flow.customAnswers[question.question]?.length
                  ? "bg-blue-500/15 border-blue-500"
                  : "bg-background border-border hover:bg-muted/50",
              )}
            >
              <span className="mr-2 text-muted-foreground">
                {isMultiSelect && flow.customAnswers[question.question]?.length ? "✓" : customIndex}
              </span>
              <span className="font-medium">
                {isMultiSelect || !flow.customAnswers[question.question]?.length
                  ? "Custom response..."
                  : `Custom response: ${flow.customAnswers[question.question][0]}`}
              </span>
            </button>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 pt-1">
          <button
            type="button"
            disabled={flow.questionIndex === 0 || submitting}
            onClick={() => {
              move(-1);
            }}
            className="px-2 py-1 rounded-md text-xs border border-border disabled:opacity-50"
          >
            Back
          </button>
          {flow.questionIndex + 1 < questions.length ? (
            <button
              type="button"
              disabled={!canAdvanceQuestion(flow, question) || submitting}
              onClick={() => {
                move(1);
              }}
              className="px-2 py-1 rounded-md text-xs bg-blue-500 text-white disabled:opacity-50"
            >
              Next
            </button>
          ) : (
            <button
              type="button"
              disabled={!canAdvanceQuestion(flow, question) || submitting}
              onClick={() => {
                void submitAnswers();
              }}
              className="px-2 py-1 rounded-md text-xs bg-blue-500 text-white disabled:opacity-50"
            >
              {submitting ? "Submitting..." : "Submit answers"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
