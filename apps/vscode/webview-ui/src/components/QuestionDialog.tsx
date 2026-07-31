import { useState, useEffect } from "react";
import { IconCheck } from "@tabler/icons-react";
import { useChatStore } from "@/stores";
import { buildQuestionAnswers, type QuestionFormState } from "@/lib/question-answers";
import { cn } from "@/lib/utils";

const EMPTY_FORM: QuestionFormState = { single: {}, multi: {}, custom: {} };

export function QuestionDialog() {
  const { pendingQuestion, respondQuestion } = useChatStore();
  const [form, setForm] = useState<QuestionFormState>(EMPTY_FORM);
  const [customOpen, setCustomOpen] = useState<Record<number, boolean>>({});

  const questions = pendingQuestion?.questions ?? [];

  useEffect(() => {
    if (pendingQuestion) {
      setForm(EMPTY_FORM);
      setCustomOpen({});
    }
  }, [pendingQuestion?.id]);

  if (!pendingQuestion || questions.length === 0) return null;

  const answers = buildQuestionAnswers(questions, form);
  const answeredCount = Object.keys(answers).length;

  const handleSubmit = async () => {
    await respondQuestion(buildQuestionAnswers(questions, form));
  };

  const handleDismiss = async () => {
    await respondQuestion({});
  };

  const selectSingle = (questionIdx: number, optionIdx: number) => {
    setForm((f) => ({
      single: { ...f.single, [questionIdx]: optionIdx },
      multi: f.multi,
      // A chosen option and custom text are mutually exclusive for single-select.
      custom: { ...f.custom, [questionIdx]: "" },
    }));
  };

  const toggleMulti = (questionIdx: number, optionIdx: number) => {
    setForm((f) => {
      const next = new Set(f.multi[questionIdx] ?? []);
      if (next.has(optionIdx)) next.delete(optionIdx);
      else next.add(optionIdx);
      return { single: f.single, multi: { ...f.multi, [questionIdx]: next }, custom: f.custom };
    });
  };

  const setCustomText = (questionIdx: number, text: string, isMulti: boolean) => {
    setForm((f) => ({
      single: isMulti ? f.single : { ...f.single, [questionIdx]: undefined },
      multi: f.multi,
      custom: { ...f.custom, [questionIdx]: text },
    }));
  };

  return (
    <div className={cn("mb-0.5 border border-blue-200 dark:border-blue-800 rounded-lg overflow-hidden bg-background flex flex-col shrink")}>
      <div className="overflow-y-auto max-h-80">
        {questions.map((question, questionIdx) => {
          const options = question.options ?? [];
          const isMulti = question.multi_select === true;
          const customText = form.custom[questionIdx] ?? "";
          const customSelected = customText.trim().length > 0;
          return (
            <div key={questionIdx} className={cn("p-2 space-y-1.5", questionIdx > 0 && "border-t border-border/60")}>
              {question.header && <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{question.header}</div>}
              <div className="text-xs font-semibold text-foreground">{question.question}</div>
              {isMulti && <div className="text-[10px] text-muted-foreground">Select all that apply</div>}
              <div className="space-y-1.5">
                {options.map((option, optionIdx) => {
                  const selected = isMulti ? form.multi[questionIdx]?.has(optionIdx) === true : form.single[questionIdx] === optionIdx;
                  return (
                    <button
                      key={optionIdx}
                      onClick={() => (isMulti ? toggleMulti(questionIdx, optionIdx) : selectSingle(questionIdx, optionIdx))}
                      className={cn(
                        "w-full text-left px-2 py-1 rounded-md text-xs transition-colors",
                        "border cursor-pointer flex items-start",
                        selected
                          ? isMulti
                            ? "border-blue-500 bg-blue-500/10"
                            : "bg-blue-500 text-white border-blue-500"
                          : "border-border bg-background hover:bg-muted/50",
                      )}
                    >
                      {isMulti ? (
                        <span
                          className={cn(
                            "mr-2 mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border",
                            selected ? "bg-blue-500 border-blue-500 text-white" : "border-border",
                          )}
                        >
                          {selected && <IconCheck className="size-3" />}
                        </span>
                      ) : (
                        <span className={cn("mr-2", selected ? "text-blue-200" : "text-muted-foreground")}>{optionIdx + 1}</span>
                      )}
                      <span>
                        <span className="font-medium">{option.label}</span>
                        {option.description && (
                          <span className={cn("ml-2", selected && !isMulti ? "text-blue-200" : "text-muted-foreground")}>- {option.description}</span>
                        )}
                      </span>
                    </button>
                  );
                })}
                {customOpen[questionIdx] ? (
                  <input
                    autoFocus
                    value={customText}
                    onChange={(e) => setCustomText(questionIdx, e.target.value, isMulti)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) void handleSubmit();
                      if (e.key === "Escape") setCustomOpen((open) => ({ ...open, [questionIdx]: false }));
                    }}
                    placeholder={isMulti ? "Add another response..." : "Enter your response..."}
                    className="w-full px-2 py-1 rounded-md text-xs border border-border bg-background outline-none focus:border-blue-500"
                  />
                ) : (
                  <button
                    onClick={() => setCustomOpen((open) => ({ ...open, [questionIdx]: true }))}
                    className={cn(
                      "w-full text-left px-2 py-1 rounded-md text-xs transition-colors",
                      "border cursor-pointer",
                      customSelected
                        ? isMulti
                          ? "border-blue-500 bg-blue-500/10"
                          : "bg-blue-500 text-white border-blue-500"
                        : "border-border bg-background hover:bg-muted/50",
                    )}
                  >
                    <span className={cn("mr-2", customSelected && !isMulti ? "text-blue-200" : "text-muted-foreground")}>{options.length + 1}</span>
                    <span className="font-medium">{customSelected ? customText : "Custom response..."}</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="shrink-0 border-t border-border/60 p-2 space-y-1.5">
        {answeredCount < questions.length && (
          <div className="text-[10px] text-muted-foreground">
            {answeredCount} of {questions.length} answered — unanswered questions will be skipped.
          </div>
        )}
        <div className="flex gap-1.5">
          <button onClick={() => void handleSubmit()} className="px-2 py-1 rounded-md text-xs bg-blue-500 text-white cursor-pointer">
            Submit
          </button>
          <button onClick={() => void handleDismiss()} className="px-2 py-1 rounded-md text-xs text-muted-foreground hover:bg-muted/50 cursor-pointer">
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
