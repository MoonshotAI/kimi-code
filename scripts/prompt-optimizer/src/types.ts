/**
 * Prompt Optimizer — Core type definitions.
 *
 * All modules (benchmark, pruner, ab-test, probe) share these types.
 */

// ─── Benchmark Types ────────────────────────────────────────────────────────

export interface BenchmarkCase {
  /** Unique task identifier */
  id: string;
  /** Human-readable description */
  description: string;
  /** Category for grouping */
  category: BenchmarkCategory;
  /** The user message(s) to send */
  userMessages: string[];
  /** Which prompt sections this case exercises (for pruner relevance) */
  relevantSections: string[];
  /** Evaluation criteria */
  evaluators: Evaluator[];
  /** Tools available to the model for this case (enables real tool-call testing) */
  availableTools?: import('./benchmark/runner').ToolDefinition[];
  /** Optional: mock tool responses for deterministic testing */
  mockResponses?: MockToolResponse[];
}

export type BenchmarkCategory =
  | 'rule-compliance'    // Does it follow prompt rules?
  | 'tool-selection'     // Does it pick the right tool?
  | 'minimal-change'     // Is the diff minimal?
  | 'format-compliance'  // Does output match format rules?
  | 'safety-boundary'    // Does it resist injection/forbidden actions?
  | 'context-recovery';  // Does it handle compaction correctly?

export interface Evaluator {
  /** What this evaluator checks */
  name: string;
  /** Evaluation function — returns 0-1 score */
  type: EvaluatorType;
  /** Parameters for the evaluator */
  params: Record<string, unknown>;
}

export type EvaluatorType =
  | 'contains'           // Output contains/not-contains a string
  | 'not-contains'       // Output must NOT contain
  | 'tool-called'        // Specific tool was called
  | 'tool-not-called'    // Specific tool was NOT called
  | 'output-length'      // Output length within range
  | 'regex-match'        // Output matches regex
  | 'regex-not-match'    // Output must NOT match regex
  | 'json-schema'        // Output conforms to JSON schema
  | 'llm-judge';         // Use another LLM to judge (last resort)

export interface MockToolResponse {
  toolName: string;
  inputPattern?: string;
  response: string;
}

export interface BenchmarkResult {
  taskId: string;
  promptVersion: string;
  model: string;
  scores: BenchmarkScores;
  violations: string[];
  latencyMs: number;
  tokenUsage: { input: number; output: number };
  rawOutput?: string;
}

export interface BenchmarkScores {
  /** Did the task complete correctly? */
  taskSuccess: boolean;
  /** 0-1, proportion of rules followed */
  ruleCompliance: number;
  /** Total tokens used (lower is better) */
  tokenEfficiency: number;
  /** 0-1, correct tool selection rate */
  toolAccuracy: number;
  /** 0-1, output conciseness score */
  outputConciseness: number;
}

// ─── Prompt Variant Types ───────────────────────────────────────────────────

export interface PromptVariant {
  /** Unique name for this variant */
  name: string;
  /** Description of what changed */
  description: string;
  /** The full rendered system prompt text */
  content: string;
  /** Which sections were modified/removed */
  modifiedSections: string[];
}

export interface PromptSection {
  /** Section heading (e.g. "# Language") */
  heading: string;
  /** Full text content including heading */
  content: string;
  /** Approximate token count */
  tokens: number;
  /** Start line in source file */
  startLine: number;
  /** End line in source file */
  endLine: number;
}

// ─── A/B Test Types ─────────────────────────────────────────────────────────

export interface ABExperiment {
  /** Experiment name */
  name: string;
  /** Target section(s) being tested */
  targetSections: string[];
  /** Variants to compare (first is always "control") */
  variants: PromptVariant[];
  /** Which benchmark cases to run */
  caseFilter: string[] | 'all';
  /** Number of repetitions per variant × case */
  repetitions: number;
  /** Model to test against */
  model: string;
}

export interface ABResult {
  experiment: string;
  variantResults: Map<string, BenchmarkResult[]>;
  comparison: ABComparison[];
}

export interface ABComparison {
  variantA: string;
  variantB: string;
  dimension: keyof BenchmarkScores;
  meanA: number;
  meanB: number;
  delta: number;
  deltaPercent: number;
  significant: boolean;
  verdict: 'A wins' | 'B wins' | 'tie';
}

// ─── Pruner Types ───────────────────────────────────────────────────────────

export interface PruneResult {
  section: string;
  tokens: number;
  impact: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
  verdict: 'PRUNE' | 'KEEP';
  reason: string;
  /** Score deltas when this section is removed */
  scoreDeltas: Partial<Record<keyof BenchmarkScores, number>>;
}

export interface PruneReport {
  promptVersion: string;
  model: string;
  totalTokens: number;
  prunableTokens: number;
  sections: PruneResult[];
}

// ─── Model Probe Types ──────────────────────────────────────────────────────

export type ProbeDimension =
  | 'long-paragraph-memory'
  | 'priority-reasoning'
  | 'negation-compliance'
  | 'numeric-constraints'
  | 'xml-tag-injection'
  | 'few-shot-sensitivity';

export interface ProbeResult {
  dimension: ProbeDimension;
  score: number;
  recommendation: string;
  /** Suggested prompt patch for this weakness */
  suggestedPatch?: string;
}

export interface ModelProfile {
  model: string;
  timestamp: string;
  dimensions: ProbeResult[];
  overallStrength: number;
}

// ─── Config ─────────────────────────────────────────────────────────────────

export interface OptimizerConfig {
  /** Path to the system.md template */
  systemPromptPath: string;
  /** Default model for testing */
  defaultModel: string;
  /** API base URL */
  apiBaseUrl: string;
  /** API key env var name */
  apiKeyEnvVar: string;
  /** Output directory for reports */
  outputDir: string;
  /** Number of parallel requests */
  concurrency: number;
}
