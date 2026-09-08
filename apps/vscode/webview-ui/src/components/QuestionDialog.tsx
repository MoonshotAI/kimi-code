import { useState, useEffect } from "react";
import { useChatStore } from "@/stores";
import { cn } from "@/lib/utils";

export function QuestionDialog() {
  const { pendingQuestion, respondQuestion } = useChatStore();
  const [customInput, setCustomInput] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(1);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [multiSelected, setMultiSelected] = useState<string[]>([]);

  const questions = pendingQuestion?.questions ?? [];
  const question = questions[questionIndex];
  const isMultiSelect = question?.multi_select === true;
  const isLastQuestion = questionIndex + 1 >= questions.length;

  useEffect(() => {
    if (pendingQuestion) {
      setShowCustom(false);
      setCustomInput("");
      setSelectedIndex(1);
      setQuestionIndex(0);
      setAnswers({});
      setMultiSelected([]);
    }
  }, [pendingQuestion?.id]);

  if (!pendingQuestion || !question) return null;

  // Step through the questions one by one; submit all answers after the last.
  const handleAnswer = async (answer: string) => {
    const nextAnswers = { ...answers, [question.question]: answer };
    if (!isLastQuestion) {
      setAnswers(nextAnswers);
      setQuestionIndex(questionIndex + 1);
      setShowCustom(false);
      setCustomInput("");
      setSelectedIndex(1);
      setMultiSelected([]);
    } else {
      await respondQuestion(nextAnswers);
    }
  };

  const handleSelect = async (optionLabel: string) => {
    if (isMultiSelect) {
      setMultiSelected((prev) =>
        prev.includes(optionLabel) ? prev.filter((value) => value !== optionLabel) : [...prev, optionLabel],
      );
      return;
    }
    await handleAnswer(optionLabel);
  };

  const handleCustomSubmit = async () => {
    const value = customInput.trim();
    if (!value) return;
    if (isMultiSelect) {
      setMultiSelected((prev) => (prev.includes(value) ? prev : [...prev, value]));
      setCustomInput("");
      setShowCustom(false);
      return;
    }
    await handleAnswer(value);
  };

  const options = question.options || [];
  const customIndex = options.length + 1;
  const customValues = multiSelected.filter((value) => !options.some((option) => option.label === value));

  return (
    <div className={cn("mb-0.5 border border-blue-200 dark:border-blue-800 rounded-lg overflow-hidden bg-background flex flex-col shrink")}>
      <div className="p-2 space-y-2">
        {questions.length > 1 && (
          <div className="text-[10px] text-muted-foreground">
            Question {questionIndex + 1} of {questions.length}
          </div>
        )}
        {question.header && <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{question.header}</div>}
        <div className="text-xs font-semibold text-foreground">{question.question}</div>
        {isMultiSelect && <div className="text-[10px] text-muted-foreground">Select all that apply</div>}
        <div className="space-y-1.5">
          {options.map((option, idx) => {
            const isChecked = isMultiSelect && multiSelected.includes(option.label);
            const isHighlighted = selectedIndex === idx + 1;
            return (
              <button
                key={idx}
                onClick={() => {
                  void handleSelect(option.label);
                }}
                onMouseEnter={() => setSelectedIndex(idx + 1)}
                className={cn(
                  "w-full text-left px-2 py-1 rounded-md text-xs transition-colors",
                  "border cursor-pointer",
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
              className={cn(
                "w-full text-left px-2 py-1 rounded-md text-xs transition-colors",
                "border cursor-pointer bg-blue-500/15 border-blue-500",
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
                onChange={(e) => setCustomInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCustomSubmit();
                  if (e.key === "Escape") setShowCustom(false);
                }}
                placeholder="Enter your response…"
                className="flex-1 px-2 py-1 rounded-md text-xs border border-border bg-background outline-none focus:border-blue-500"
              />
              <button
                onClick={() => {
                  void handleCustomSubmit();
                }}
                disabled={!customInput.trim()}
                className="px-2 py-1 rounded-md text-xs bg-blue-500 text-white disabled:opacity-50 cursor-pointer"
              >
                Send
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowCustom(true)}
              onMouseEnter={() => setSelectedIndex(customIndex)}
              className={cn(
                "w-full text-left px-2 py-1 rounded-md text-xs transition-colors",
                "border border-border cursor-pointer",
                selectedIndex === customIndex ? "bg-blue-500 text-white border-blue-500" : "bg-background hover:bg-muted/50",
              )}
            >
              <span className={cn("mr-2", selectedIndex === customIndex ? "text-blue-200" : "text-muted-foreground")}>{customIndex}</span>
              <span className="font-medium">Custom response…</span>
            </button>
          )}
          {isMultiSelect && (
            <button
              onClick={() => {
                void handleAnswer(multiSelected.join(", "));
              }}
              disabled={multiSelected.length === 0}
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
