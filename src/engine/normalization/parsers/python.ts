import type { NormalizationContext, NormalizedErrorOutput, NormalizerParser } from "../types.js";

function tail(input: string): string {
  return input.split(/\r?\n/).slice(-30).join("\n");
}

function detectFiles(rawLog: string): string[] {
  const set = new Set<string>();
  const p1 = /File "([^"]+\.py)", line \d+/gm;
  const p2 = /(?:^|\s)([./\w-]+\.py):\d+/gm;
  let m: RegExpExecArray | null;
  while ((m = p1.exec(rawLog))) set.add(m[1].replace(/\\/g, "/"));
  while ((m = p2.exec(rawLog))) set.add(m[1].replace(/\\/g, "/"));
  return [...set];
}

function classify(rawLog: string): { cls: string; primary: string; confidence: number } | null {
  if (
    /E\s+AssertionError|AssertionError:|FAILED\s+|short test summary info|tests\/test_.*\.py/i.test(rawLog)
  ) {
    const line =
      rawLog
        .split(/\r?\n/)
        .find((l) => /AssertionError:|FAILED\s+|short test summary info/i.test(l)) ??
      "pytest assertion failure";
    return { cls: "python_test_failure", primary: line.trim(), confidence: 0.8 };
  }

  if (/ModuleNotFoundError:\s*No module named ['"][^'"]+['"]/i.test(rawLog)) {
    const match = rawLog.match(/ModuleNotFoundError:\s*No module named ['"]([^'"]+)['"]/i);
    return {
      cls: "python_module_not_found",
      primary: `ModuleNotFoundError: No module named '${match?.[1] ?? "unknown"}'`,
      confidence: 0.9,
    };
  }
  if (/ImportError:/i.test(rawLog)) {
    const line = rawLog.split(/\r?\n/).find((l) => /ImportError:/i.test(l)) ?? "ImportError";
    return { cls: "python_import_error", primary: line.trim(), confidence: 0.82 };
  }
  if (/IndentationError:/i.test(rawLog)) {
    const line = rawLog.split(/\r?\n/).find((l) => /IndentationError:/i.test(l)) ?? "IndentationError";
    return { cls: "python_indentation_error", primary: line.trim(), confidence: 0.9 };
  }
  if (/SyntaxError:/i.test(rawLog)) {
    const line = rawLog.split(/\r?\n/).find((l) => /SyntaxError:/i.test(l)) ?? "SyntaxError";
    return { cls: "python_syntax_error", primary: line.trim(), confidence: 0.9 };
  }
  if (/Traceback \(most recent call last\):/i.test(rawLog)) {
    const line = rawLog.split(/\r?\n/).find((l) => /^[A-Za-z]+Error:/.test(l.trim())) ?? "python traceback";
    return { cls: "python_traceback_error", primary: line.trim(), confidence: 0.7 };
  }
  return null;
}

export const pythonParser: NormalizerParser = {
  name: "python",
  parse(rawLog: string, context: NormalizationContext): NormalizedErrorOutput | null {
    if (!/Traceback|SyntaxError|IndentationError|ModuleNotFoundError|ImportError|pytest|AssertionError/i.test(rawLog)) {
      return null;
    }
    const classified = classify(rawLog);
    if (!classified) return null;
    const files = [...new Set([...(context.files ?? []), ...detectFiles(rawLog)])];
    const normalized = `${classified.primary}${files.length ? ` | files: ${files.join(", ")}` : ""}`;
    const isPytestContext =
      context.command_kind === "test" ||
      /pytest|short test summary info|FAILED\s+|tests\/test_.*\.py|AssertionError:/i.test(rawLog);
    return {
      raw_log_tail: tail(rawLog),
      normalized_error: normalized.slice(0, 500),
      error_class: classified.cls,
      detected_toolchain: isPytestContext ? "pytest" : "python",
      detected_language: "python",
      detected_files: files,
      confidence: classified.confidence,
      suggested_memory_content: `[python] ${classified.primary}`,
      metadata: {
        parser: "python",
        command_kind: context.command_kind ?? "unknown",
      },
    };
  },
};
