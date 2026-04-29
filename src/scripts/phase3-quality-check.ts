import { normalizeTerminalError } from "../engine/normalization/index.js";

type Case = {
  id: string;
  log: string;
  commandKind: "test" | "lint" | "build" | "typecheck" | "run" | "unknown";
  expected: {
    error_class: string;
    detected_language: string;
    detected_toolchain: string;
  };
};

const cases: Case[] = [
  {
    id: "python-syntax",
    commandKind: "run",
    log: `File "src/app.py", line 10
  print("hello"
               ^
SyntaxError: '(' was never closed`,
    expected: {
      error_class: "python_syntax_error",
      detected_language: "python",
      detected_toolchain: "python",
    },
  },
  {
    id: "python-indentation",
    commandKind: "run",
    log: `File "src/tasks.py", line 42
    return value
    ^
IndentationError: unexpected indent`,
    expected: {
      error_class: "python_indentation_error",
      detected_language: "python",
      detected_toolchain: "python",
    },
  },
  {
    id: "python-module-not-found",
    commandKind: "run",
    log: `Traceback (most recent call last):
  File "src/main.py", line 2, in <module>
    import fastapix
ModuleNotFoundError: No module named 'fastapix'`,
    expected: {
      error_class: "python_module_not_found",
      detected_language: "python",
      detected_toolchain: "python",
    },
  },
  {
    id: "python-pytest-assertion",
    commandKind: "test",
    log: `_____________________ test_sum _____________________
>       assert add(2, 2) == 5
E       AssertionError: assert 4 == 5
tests/test_math.py:10: AssertionError`,
    expected: {
      error_class: "python_test_failure",
      detected_language: "python",
      detected_toolchain: "pytest",
    },
  },
  {
    id: "python-traceback-generic",
    commandKind: "run",
    log: `Traceback (most recent call last):
  File "src/server.py", line 55, in <module>
    run()
  File "src/server.py", line 51, in run
    raise RuntimeError("boom")
RuntimeError: boom`,
    expected: {
      error_class: "python_traceback_error",
      detected_language: "python",
      detected_toolchain: "python",
    },
  },
  {
    id: "typescript-ts2322",
    commandKind: "typecheck",
    log: `src/example.ts:12:5 - error TS2322: Type 'string' is not assignable to type 'number'.`,
    expected: {
      error_class: "typescript_type_error",
      detected_language: "typescript",
      detected_toolchain: "tsc",
    },
  },
  {
    id: "typescript-ts2307",
    commandKind: "typecheck",
    log: `src/app.ts:1:24 - error TS2307: Cannot find module 'zood' or its corresponding type declarations.`,
    expected: {
      error_class: "typescript_type_error",
      detected_language: "typescript",
      detected_toolchain: "tsc",
    },
  },
  {
    id: "eslint-error",
    commandKind: "lint",
    log: `src/app.js
  12:10  error  'unusedVar' is assigned a value but never used  no-unused-vars`,
    expected: {
      error_class: "javascript_lint_error",
      detected_language: "javascript",
      detected_toolchain: "eslint",
    },
  },
  {
    id: "nextjs-build-error",
    commandKind: "build",
    log: `info  - Creating an optimized production build...
Failed to compile.
./src/app/page.tsx:5:10
Error: Next.js build error: Cannot read properties of undefined`,
    expected: {
      error_class: "nextjs_error",
      detected_language: "typescript",
      detected_toolchain: "nextjs",
    },
  },
  {
    id: "unknown-generic",
    commandKind: "unknown",
    log: `Command failed with exit code 1
Something broke unexpectedly in a custom pipeline`,
    expected: {
      error_class: "unknown_error",
      detected_language: "unknown",
      detected_toolchain: "unknown",
    },
  },
];

type Row = {
  id: string;
  expected_error_class: string;
  actual_error_class: string;
  expected_language: string;
  actual_language: string;
  expected_toolchain: string;
  actual_toolchain: string;
  detected_files: string[];
  confidence: number;
  pass: boolean;
};

const rows: Row[] = cases.map((c) => {
  const out = normalizeTerminalError(c.log, { command_kind: c.commandKind });
  const pass =
    out.error_class === c.expected.error_class &&
    out.detected_language === c.expected.detected_language &&
    out.detected_toolchain === c.expected.detected_toolchain;
  return {
    id: c.id,
    expected_error_class: c.expected.error_class,
    actual_error_class: out.error_class,
    expected_language: c.expected.detected_language,
    actual_language: out.detected_language,
    expected_toolchain: c.expected.detected_toolchain,
    actual_toolchain: out.detected_toolchain,
    detected_files: out.detected_files,
    confidence: out.confidence,
    pass,
  };
});

const passCount = rows.filter((r) => r.pass).length;
const failRows = rows.filter((r) => !r.pass);
const lowConfidence = rows.filter((r) => r.confidence < 0.7);

console.error("Phase3 Quality Matrix");
for (const row of rows) {
  console.error(
    JSON.stringify(
      {
        id: row.id,
        expected_error_class: row.expected_error_class,
        actual_error_class: row.actual_error_class,
        expected_language: row.expected_language,
        actual_language: row.actual_language,
        expected_toolchain: row.expected_toolchain,
        actual_toolchain: row.actual_toolchain,
        detected_files: row.detected_files,
        confidence: row.confidence,
        pass: row.pass,
      },
      null,
      2,
    ),
  );
}

console.error(
  JSON.stringify(
    {
      summary: {
        total: rows.length,
        passed: passCount,
        failed: rows.length - passCount,
        low_confidence_count: lowConfidence.length,
        low_confidence_ids: lowConfidence.map((r) => r.id),
      },
    },
    null,
    2,
  ),
);

if (failRows.length > 0) {
  process.exitCode = 1;
}
