import { useState, useEffect } from "react";
import { useChatStore } from "@/stores";
import { cn } from "@/lib/utils";

export function QuestionDialog() {
  const { pendingQuestion, respondQuestion } = useChatStore();
  const [customDrafts, setCustomDrafts] = useState<Record<number, string>>({});
  const [showCustom, setShowCustom] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(1);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const questions = pendingQuestion?.questions ?? [];
  const question = questions[questionIndex];
  const isMultiSelect = question?.multi_select === true;
  const isLastQuestion = questionIndex + 1 >= questions.length;
  const currentAnswer = question ? answers[question.question] : undefined;
  const selectedValues = Array.isArray(currentAnswer) ? currentAnswer : typeof currentAnswer === "string" ? [currentAnswer] : [];
  const customInput = customDrafts[questionIndex] ?? "";

  useEffect(() => {
    if (pendingQuestion) {
      setShowCustom(false);
      setCustomDrafts({});
      setSelectedIndex(1);
      setQuestionIndex(0);
      setAnswers({});
      setIsSubmitting(false);
    }
  }, [pendingQuestion?.id]);

  if (!pendingQuestion || !question) return null;

  const updateCustomInput = (value: string) => {
    setCustomDrafts((currentDrafts) => ({ ...currentDrafts, [questionIndex]: value }));
  };

  // Step through the questions one by one; submit all answers after the last.
  const handleAnswer = async (answer: string | string[]) => {
    const nextAnswers = { ...answers, [question.question]: answer };
    if (!isLastQuestion) {
      setAnswers(nextAnswers);
      setQuestionIndex(questionIndex + 1);
      setShowCustom(false);
      setSelectedIndex(1);
    } else {
      setIsSubmitting(true);
      try {
        await respondQuestion(
          Object.fromEntries(Object.entries(nextAnswers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value])),
        );
      } finally {
        setIsSubmitting(false);
      }
    }
  };

  const handleBack = () => {
    setQuestionIndex(questionIndex - 1);
    setShowCustom(false);
    setSelectedIndex(1);
  };

  const handleSelect = async (optionLabel: string) => {
    if (isMultiSelect) {
      setAnswers((currentAnswers) => {
        const answer = currentAnswers[question.question];
        const values = Array.isArray(answer) ? answer : [];
        return {
          ...currentAnswers,
          [question.question]: values.includes(optionLabel)
            ? values.filter((value) => value !== optionLabel)
            : [...values, optionLabel],
        };
      });
      return;
    }
    await handleAnswer(optionLabel);
  };

  const handleCustomSubmit = async () => {
    const value = customInput.trim();
    if (!value) return;
    if (isMultiSelect) {
      if (!selectedValues.includes(value)) await handleSelect(value);
      updateCustomInput("");
      setShowCustom(false);
      return;
    }
    await handleAnswer(value);
    updateCustomInput("");
  };

  const options = question.options || [];
  const customIndex = options.length + 1;
  const customValues = selectedValues.filter((value) => !options.some((option) => option.label === value));

  return (
    <div className={cn("mb-0.5 border border-blue-200 dark:border-blue-800 rounded-lg overflow-hidden bg-background flex flex-col shrink")}>
      <div className="p-2 space-y-2">
        {questions.length > 1 && (
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span>
              Question {questionIndex + 1} of {questions.length}
            </span>
            {questionIndex > 0 && (
              <button onClick={handleBack} disabled={isSubmitting} className="cursor-pointer hover:text-foreground disabled:opacity-50">
                Back
              </button>
            )}
          </div>
        )}
        {question.header && <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{question.header}</div>}
        <div className="text-xs font-semibold text-foreground">{question.question}</div>
        {isMultiSelect && <div className="text-[10px] text-muted-foreground">Select all that apply</div>}
        <div className="space-y-1.5">
          {options.map((option, idx) => {
            const isChecked = selectedValues.includes(option.label);
            const isHighlighted = selectedIndex === idx + 1;
            return (
              <button
                key={idx}
                onClick={() => {
                  void handleSelect(option.label);
                }}
                onMouseEnter={() => setSelectedIndex(idx + 1)}
                disabled={isSubmitting}
                className={cn(
                  "w-full text-left px-2 py-1 rounded-md text-xs transition-colors",
                  "border cursor-pointer disabled:opacity-50",
                  isChecked
                    ? "bg-blue-500/15 border-blue-500"
                    : isHighlighted
                      ? "bg-blue-500 text-white border-blue-500"
                      : "bg-background border-border hover:bg-muted/50",
                )}
              >
                <span className={cn("mr-2", isHighlighted && !isChecked ? "text-blue-200" : "text-muted-foreground")}>
                  {isChecked ? "✓" : idx + 1}
                </span>
                <span className="font-medium">{option.label}</span>
                {option.description && (
                  <span className={cn("ml-2", isHighlighted && !isChecked ? "text-blue-200" : "text-muted-foreground")}>- {option.description}</span>
                )}
              </button>
            );
          })}
          {customValues.map((value) => (
            <button
              key={value}
              onClick={() => {
                void handleSelect(value);
              }}
              disabled={isSubmitting}
              className={cn(
                "w-full text-left px-2 py-1 rounded-md text-xs transition-colors",
                "border cursor-pointer bg-blue-500/15 border-blue-500 disabled:opacity-50",
              )}
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
                  if (e.key === "Enter") void handleCustomSubmit();
                  if (e.key === "Escape") setShowCustom(false);
                }}
                disabled={isSubmitting}
                placeholder="Enter your response…"
                className="flex-1 px-2 py-1 rounded-md text-xs border border-border bg-background outline-none focus:border-blue-500 disabled:opacity-50"
              />
              <button
                onClick={() => {
                  void handleCustomSubmit();
                }}
                disabled={isSubmitting || !customInput.trim()}
                className="px-2 py-1 rounded-md text-xs bg-blue-500 text-white disabled:opacity-50 cursor-pointer"
              >
                Send
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowCustom(true)}
              onMouseEnter={() => setSelectedIndex(customIndex)}
              disabled={isSubmitting}
              className={cn(
                "w-full text-left px-2 py-1 rounded-md text-xs transition-colors",
                "border border-border cursor-pointer disabled:opacity-50",
                selectedIndex === customIndex ? "bg-blue-500 text-white border-blue-500" : "bg-background hover:bg-muted/50",
              )}
            >
              <span className={cn("mr-2", selectedIndex === customIndex ? "text-blue-200" : "text-muted-foreground")}>{customIndex}</span>
              <span className="font-medium">Custom response…</span>
            </button>
          )}
          {!isMultiSelect && !isLastQuestion && currentAnswer !== undefined && (
            <button
              onClick={() => {
                void handleAnswer(currentAnswer);
              }}
              disabled={isSubmitting}
              className="w-full px-2 py-1 rounded-md text-xs bg-blue-500 text-white disabled:opacity-50 cursor-pointer"
            >
              Next
            </button>
          )}
          {isMultiSelect && (
            <button
              onClick={() => {
                void handleAnswer(selectedValues);
              }}
              disabled={isSubmitting || selectedValues.length === 0}
              className="w-full px-2 py-1 rounded-md text-xs bg-blue-500 text-white disabled:opacity-50 cursor-pointer"
            >
              {isLastQuestion ? "Submit" : "Next"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
