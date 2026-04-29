import { genericParser } from "./parsers/generic.js";
import { javascriptParser } from "./parsers/javascript.js";
import { pythonParser } from "./parsers/python.js";
import { typescriptParser } from "./parsers/typescript.js";
import type { NormalizationContext, NormalizedErrorOutput, NormalizerParser } from "./types.js";

const PARSERS: NormalizerParser[] = [pythonParser, javascriptParser, typescriptParser];

function stripAbsolutePaths(input: string): string {
  return input.replace(/\/(?:Users|home|var|private|tmp)\/[^\s"')]+/g, (match) => {
    const parts = match.split("/").filter(Boolean);
    return parts.slice(-3).join("/");
  });
}

export function normalizeTerminalError(rawLog: string, context: NormalizationContext): NormalizedErrorOutput {
  const sanitizedLog = stripAbsolutePaths(rawLog);
  const sanitize = (out: NormalizedErrorOutput): NormalizedErrorOutput => ({
    ...out,
    raw_log_tail: stripAbsolutePaths(out.raw_log_tail),
    normalized_error: stripAbsolutePaths(out.normalized_error),
    suggested_memory_content: stripAbsolutePaths(out.suggested_memory_content),
  });

  for (const parser of PARSERS) {
    const parsed = parser.parse(sanitizedLog, context);
    if (parsed) {
      return sanitize(parsed);
    }
  }
  const fallback = genericParser.parse(sanitizedLog, context);
  if (!fallback) {
    return sanitize({
      raw_log_tail: sanitizedLog.split(/\r?\n/).slice(-30).join("\n"),
      normalized_error: "Unclassified terminal error",
      error_class: "unknown_error",
      detected_toolchain: "unknown",
      detected_language: "unknown",
      detected_files: [],
      confidence: 0.3,
      suggested_memory_content: "Unknown error",
      metadata: { parser: "none", command_kind: context.command_kind ?? "unknown" },
    });
  }
  return sanitize(fallback);
}
