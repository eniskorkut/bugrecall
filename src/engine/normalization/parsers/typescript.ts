import type { NormalizationContext, NormalizedErrorOutput, NormalizerParser } from "../types.js";

function tail(input: string): string {
  return input.split(/\r?\n/).slice(-30).join("\n");
}

function detectFiles(rawLog: string): string[] {
  const set = new Set<string>();
  const patterns = [
    /(?:^|\s)([./\w-]+\.(?:ts|tsx)):\d+(?::\d+)?/gm,
    /([./\w-]+\.(?:ts|tsx))\(\d+,\d+\)/gm,
  ];
  for (const p of patterns) {
    let m: RegExpExecArray | null;
    while ((m = p.exec(rawLog))) set.add(m[1].replace(/\\/g, "/"));
  }
  return [...set];
}

export const typescriptParser: NormalizerParser = {
  name: "typescript",
  parse(rawLog: string, context: NormalizationContext): NormalizedErrorOutput | null {
    if (/next\.js|next build|Failed to compile|Compiled with problems|\.next\/|app\/|pages\//i.test(rawLog)) {
      return null;
    }
    if (/eslint|ESLint|no-unused-vars|@typescript-eslint\//i.test(rawLog)) {
      return null;
    }

    const hasTsSignal = /TS\d{4}|typescript|tsc|\.tsx?\b/i.test(rawLog);
    if (!hasTsSignal) return null;

    const tsMatch = rawLog.match(/error\s+TS(\d{4}):\s*(.+)/i) ?? rawLog.match(/TS(\d{4}):\s*(.+)/i);
    const cantFindModule = rawLog.match(/Cannot find module ['"]([^'"]+)['"]/i);
    const fileList = [...new Set([...(context.files ?? []), ...detectFiles(rawLog)])];

    let errorClass = "typescript_error";
    let normalized = "TypeScript error";
    let confidence = 0.72;

    if (tsMatch) {
      errorClass = "typescript_type_error";
      normalized = `TS${tsMatch[1]}: ${tsMatch[2]}`;
      confidence = 0.9;
    } else if (cantFindModule) {
      errorClass = "typescript_module_not_found";
      normalized = `Cannot find module '${cantFindModule[1]}'`;
      confidence = 0.85;
    }

    if (fileList.length) normalized = `${normalized} | files: ${fileList.join(", ")}`;

    return {
      raw_log_tail: tail(rawLog),
      normalized_error: normalized.slice(0, 500),
      error_class: errorClass,
      detected_toolchain: /eslint/i.test(rawLog) ? "eslint" : /vitest|jest/i.test(rawLog) ? "vitest" : "tsc",
      detected_language: "typescript",
      detected_files: fileList,
      confidence,
      suggested_memory_content: `[typescript] ${normalized.slice(0, 250)}`,
      metadata: {
        parser: "typescript",
        command_kind: context.command_kind ?? "unknown",
        ts_code: tsMatch ? `TS${tsMatch[1]}` : null,
      },
    };
  },
};
