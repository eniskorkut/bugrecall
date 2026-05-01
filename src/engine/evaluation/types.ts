export type EvalMode = "auto" | "text" | "vector" | "hybrid";

export type EvalSeedVerifiedMemory = {
  label: string;
  type: "incident" | "fact" | "decision";
  error_class?: string;
  language?: string;
  framework?: string;
  toolchain?: string;
  summary: string;
  content?: string;
  root_cause?: string;
  fix_pattern?: string;
  anti_patterns?: string[];
  confidence?: number;
};

export type EvalSeedUserCorrection = {
  label: string;
  correction_type: "rejected_fix" | "project_preference";
  context: string;
  user_feedback: string;
  rejected_pattern?: string;
  preferred_pattern?: string;
  future_rule: string;
  applies_to?: {
    language?: string;
    framework?: string;
    toolchain?: string;
    error_class?: string;
    file_path?: string;
    error_signature_id?: string;
    error_signature_hash?: string;
  };
  confidence?: number;
};

export type EvalCase = {
  name: string;
  query: string;
  filters?: {
    type?: string;
    workspace?: string;
    toolchain?: string;
    language?: string;
    framework?: string;
    error_class?: string;
    min_confidence?: number;
  };
  expected_top_label?: string;
  expected_top3_labels?: string[];
  expected_warning_labels?: string[];
  must_not_top1_labels?: string[];
  must_not_top3_labels?: string[];
};

export type RetrievalEvalFixture = {
  name: string;
  description?: string;
  workspace_path: string;
  mode?: EvalMode;
  detail_level?: "summary" | "full";
  include_warnings?: boolean;
  thresholds?: {
    top1_accuracy?: number;
    top3_recall?: number;
    mrr?: number;
    warning_recall?: number;
    false_positive_count?: number;
  };
  seed: {
    verified_memories: EvalSeedVerifiedMemory[];
    user_corrections: EvalSeedUserCorrection[];
  };
  cases: EvalCase[];
};

export type RetrievalEvalCaseReport = {
  name: string;
  passed: boolean;
  top_labels: string[];
  warning_labels: string[];
  failures: string[];
  rank_of_expected_top: number | null;
  sample_ranking_reasons: string[];
  sample_ranking_breakdown: Record<string, unknown> | null;
};

export type RetrievalEvalMetrics = {
  top1_accuracy: number;
  top3_recall: number;
  mrr: number;
  warning_recall: number;
  false_positive_count: number;
};

export type RetrievalEvalReport = {
  name: string;
  description?: string;
  mode: EvalMode;
  detail_level: "summary" | "full";
  include_warnings: boolean;
  workspace_path: string;
  passed: boolean;
  thresholds: Required<NonNullable<RetrievalEvalFixture["thresholds"]>>;
  metrics: RetrievalEvalMetrics;
  cases: RetrievalEvalCaseReport[];
  seeded: {
    verified_count: number;
    correction_count: number;
  };
};

export type RunRetrievalEvalOptions = {
  fixturePath: string;
  modeOverride?: EvalMode;
  workspacePathOverride?: string;
  keepTemp?: boolean;
};
