import type { NormalizationContext, NormalizedErrorOutput, NormalizerParser } from "../types.js";

function tail(input: string, maxLines: number): string {
  const lines = input.split(/\r?\n/).filter((line) => line.trim() !== "");
  return lines.slice(-maxLines).join("\n");
}

function meaningfulLines(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => /error|exception|fail|traceback|cannot|not found|syntax/i.test(line));
}

function detectFiles(input: string): string[] {
  const patterns = [
    /(?:^|\s)([./\w-]+\.(?:ts|tsx|js|jsx|py|mjs|cjs)):\d+(?::\d+)?/gm,
    /File "([^"]+\.(?:py|ts|tsx|js|jsx))", line \d+/gm,
    /([./\w-]+\.(?:ts|tsx|js|jsx|py))\(\d+,\d+\)/gm,
  ];
  const set = new Set<string>();
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    match = pattern.exec(input);
    while (match) {
      const candidate = match[1].replace(/\\/g, "/");
      set.add(candidate.startsWith("/") ? candidate.split("/").slice(-3).join("/") : candidate);
      match = pattern.exec(input);
    }
  }
  return [...set];
}

export const genericParser: NormalizerParser = {
  name: "generic",
  parse(rawLog: string, context: NormalizationContext): NormalizedErrorOutput {
    const lines = meaningfulLines(rawLog);
    const summary = lines.slice(0, 2).concat(lines.slice(-2)).join(" | ") || "Unclassified terminal error";
    const detectedFiles = [...new Set([...(context.files ?? []), ...detectFiles(rawLog)])];
    return {
      raw_log_tail: tail(rawLog, 30),
      normalized_error: summary.slice(0, 500),
      error_class: "unknown_error",
      detected_toolchain: "unknown",
      detected_language: "unknown",
      detected_files: detectedFiles,
      confidence: 0.35,
      suggested_memory_content: `Unknown error. Summary: ${summary.slice(0, 300)}`,
      metadata: {
        parser: "generic",
        command_kind: context.command_kind ?? "unknown",
      },
    };
  },
};
