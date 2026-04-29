export type CommandKind = "test" | "lint" | "build" | "typecheck" | "run" | "unknown";

export type NormalizedErrorOutput = {
  raw_log_tail: string;
  normalized_error: string;
  error_class: string;
  detected_toolchain: string;
  detected_language: string;
  detected_files: string[];
  confidence: number;
  suggested_memory_content: string;
  metadata: Record<string, unknown>;
};

export type NormalizationContext = {
  command_kind?: CommandKind;
  workspace?: string;
  files?: string[];
};

export type NormalizerParser = {
  name: string;
  parse: (rawLog: string, context: NormalizationContext) => NormalizedErrorOutput | null;
};
