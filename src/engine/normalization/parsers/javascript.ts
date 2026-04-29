import type { NormalizationContext, NormalizedErrorOutput, NormalizerParser } from "../types.js";

function tail(input: string): string {
  return input.split(/\r?\n/).slice(-30).join("\n");
}

function detectFiles(rawLog: string): string[] {
  const set = new Set<string>();
  const patterns = [
    /(?:^|\s)([./\w-]+\.(?:js|jsx|mjs|cjs)):\d+(?::\d+)?/gm,
    /(?:^|\s)([./\w-]+\.(?:ts|tsx)):\d+(?::\d+)?/gm,
    /([./\w-]+\.(?:js|jsx|mjs|cjs))\(\d+,\d+\)/gm,
    /([./\w-]+\.(?:ts|tsx))\(\d+,\d+\)/gm,
  ];
  for (const p of patterns) {
    let m: RegExpExecArray | null;
    while ((m = p.exec(rawLog))) set.add(m[1].replace(/\\/g, "/"));
  }
  return [...set];
}

export const javascriptParser: NormalizerParser = {
  name: "javascript",
  parse(rawLog: string, context: NormalizationContext): NormalizedErrorOutput | null {
    const hasNextSignal =
      /next\.js|next build|Failed to compile|Compiled with problems|\.next\/|app\/|pages\//i.test(rawLog);
    const hasEslintSignal = /eslint|ESLint|no-unused-vars|@typescript-eslint\//i.test(rawLog);
    const hasTsCompilerSignal = /error\s+TS\d{4}|TS\d{4}:/i.test(rawLog);

    if (hasTsCompilerSignal && !hasNextSignal && !hasEslintSignal) {
      return null;
    }

    if (
      !/jest|vitest|eslint|ESLint|no-unused-vars|@typescript-eslint|next\.js|next build|Failed to compile|Compiled with problems|\.next\/|app\/|pages\/|ReferenceError|TypeError|Cannot find module|\.jsx?\b|\.tsx?\b/i.test(
        rawLog,
      )
    ) {
      return null;
    }

    const fileList = [...new Set([...(context.files ?? []), ...detectFiles(rawLog)])];
    const moduleMiss = rawLog.match(/Cannot find module ['"]([^'"]+)['"]/i);
    const nextErr =
      rawLog.match(/Next\.js.+error|Error:\s+.*next|Failed to compile|Compiled with problems|next build/i) ??
      null;
    const assertErr = rawLog.match(/AssertionError:|expect\(.+\)\.to/i);
    const eslintErr =
      rawLog.match(/error\s+.+\s+eslint/i) ??
      rawLog.match(/^\s*\d+:\d+\s+error\s+.+$/m) ??
      rawLog.match(/no-unused-vars|@typescript-eslint\//i);

    let errorClass = "javascript_runtime_error";
    let normalized = "JavaScript error";
    let toolchain = "node";
    let confidence = 0.68;

    if (nextErr || hasNextSignal) {
      errorClass = "nextjs_error";
      normalized = (nextErr?.[0] ?? "Next.js error").trim();
      toolchain = "nextjs";
      confidence = 0.8;
    } else if (eslintErr) {
      errorClass = "javascript_lint_error";
      normalized = typeof eslintErr[0] === "string" ? eslintErr[0].trim() : "ESLint error";
      toolchain = "eslint";
      confidence = 0.8;
    } else if (moduleMiss) {
      errorClass = "javascript_module_not_found";
      normalized = `Cannot find module '${moduleMiss[1]}'`;
      confidence = 0.85;
    } else if (assertErr) {
      errorClass = "javascript_test_assertion_failure";
      normalized = assertErr[0].trim();
      toolchain = /vitest/i.test(rawLog) ? "vitest" : "jest";
      confidence = 0.72;
    }

    if (/eslint/i.test(rawLog)) toolchain = "eslint";
    if (/vitest/i.test(rawLog)) toolchain = "vitest";
    if (/jest/i.test(rawLog)) toolchain = "jest";

    if (fileList.length) normalized = `${normalized} | files: ${fileList.join(", ")}`;

    const hasTypeScriptFile = fileList.some((f) => /\.(ts|tsx)$/i.test(f)) || /\.tsx?\b/i.test(rawLog);
    const language = hasTypeScriptFile ? "typescript" : "javascript";

    return {
      raw_log_tail: tail(rawLog),
      normalized_error: normalized.slice(0, 500),
      error_class: errorClass,
      detected_toolchain: toolchain,
      detected_language: language,
      detected_files: fileList,
      confidence,
      suggested_memory_content: `[javascript] ${normalized.slice(0, 250)}`,
      metadata: {
        parser: "javascript",
        command_kind: context.command_kind ?? "unknown",
      },
    };
  },
};
