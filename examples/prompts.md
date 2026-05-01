# Example Prompts

## Bootstrap prompt

"Use Bugrecall to bootstrap this project and show me the detected project profile."

## Debug prompt

"Use Bugrecall while debugging. Ingest terminal errors, search project experience before patching, and finalize a successful fix only after tests/typecheck pass."

## Rejection prompt

"Record this in Bugrecall as a user correction: do not solve TypeScript errors with `as any`; fix the actual type."

## Monorepo prompt

"Use Bugrecall with workspace_path `apps/web` for this task."
