# Kimi Code UI visual verification contract

The header and plan-usage browser gate must run against the exact production bundle on
`http://127.0.0.1:4201`. The harness must fail when `location.port !== "4201"`.

Every changed interactive primitive and every conditional branch must have a machine-readable
baseline plus hover, keyboard-focus, held-pointer active, expanded, and disabled evidence where
applicable. The inventory includes the usage trigger, refresh button, new-session-tab button, and
the unavailable-state Retry button.

Required fixtures: light and dark; 320, 520, and 1280 px; 390 and 359 px at reduced usable height;
normal, low, critical, stale, loading, and unavailable usage; normal and failure popovers. Record
computed styles, rectangles, text ranges, icon centers, contrast ratios, scroll geometry, focus
traces, `:focus-visible`, and `:active`. Capture narrow and desktop header crops. Baselines must
clear transient hover/focus and wait past the longest transition.

Pointer-state families must reset keyboard focus first. Reduced-height scroll evidence must include
both top and bottom artifacts, the first and last item rectangles, and exact minimum/maximum
`scrollTop` values. Failure copy must differ from ordinary foreground through the shared destructive
treatment while retaining at least 4.5:1 contrast.
Every shared severity foreground/background pairing, including inline recovery actions, must also
meet 4.5:1 in the dense rail.

The gate also injects a deterministic assistant turn containing thinking,
progress text, an edit diff, and a final response. It must prove the shared
Work details disclosure is expanded while active, collapsed after completion
and approval requests, unchanged when a question asks for user input, manually
and keyboard reopenable, left open on runtime failure, at least 44 px high,
and free of horizontal overflow at 320, 520, and 1280 px in light and dark
themes.

Because the rounded disclosure clips overflow, its keyboard focus ring must paint
inward. The harness rejects the Work details control unless a real Tab focus
produces an inset computed shadow in both light and dark themes; a clipped
outward shadow is not valid focus evidence.
The effective ring color, after alpha compositing over the rendered trigger
surface, must retain at least 3:1 contrast in both themes.

Count semantic activity items, not SDK step containers: thinking blocks, tools,
edits, compaction, and nested agent work each count once; streamed text does not.
At 320, 520, and 1280 px, two-turn fixtures must prove unique `aria-controls`
and independent expansion arrays for all-collapsed, first-only, both-open, and
second-only states.

Dense nested-expansion fixtures must reproduce 30 activities, long thinking,
Shell output, AskUserQuestion, and a 30-file `+3392 -224` changes bar. Opening
each nested card must increase outer Work details height with no difference
between `scrollHeight` and `clientHeight`; maximum transcript scroll must keep
the final activity reachable above the non-overlapping input rail at reduced
heights. This prevents stale Radix content-height clipping.
