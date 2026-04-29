import { normalizeTerminalError } from "../engine/normalization/index.js";

const pythonModuleLog = `
Traceback (most recent call last):
  File "src/main.py", line 2, in <module>
    import fastapix
ModuleNotFoundError: No module named 'fastapix'
`;

const pythonSyntaxLog = `
  File "src/app.py", line 10
    print("hello"
                 ^
SyntaxError: '(' was never closed
`;

const tsLog = `
src/example.ts:12:5 - error TS2322: Type 'string' is not assignable to type 'number'.
Found 1 error in src/example.ts:12
`;

const genericLog = `
Command failed with exit code 1
Something broke unexpectedly in pipeline
`;

const samples = [
  { name: "python-module", log: pythonModuleLog, kind: "run" as const },
  { name: "python-syntax", log: pythonSyntaxLog, kind: "run" as const },
  { name: "typescript-ts2322", log: tsLog, kind: "typecheck" as const },
  { name: "generic-unknown", log: genericLog, kind: "unknown" as const },
];

for (const sample of samples) {
  const out = normalizeTerminalError(sample.log, { command_kind: sample.kind });
  console.error(
    JSON.stringify(
      {
        sample: sample.name,
        error_class: out.error_class,
        detected_toolchain: out.detected_toolchain,
        detected_language: out.detected_language,
        normalized_error: out.normalized_error,
        confidence: out.confidence,
      },
      null,
      2,
    ),
  );
}
