# Agent Instructions Pack

## A. Minimal Bugrecall instruction

Use Bugrecall for this project. Bootstrap the project first, search project experience before debugging fixes, and only finalize memories after a fix is verified.

## B. Strict debug workflow

Use Bugrecall as the debug memory layer.

Required flow:
1. `bootstrap_project`
2. `get_project_profile`
3. On errors: `ingest_terminal_error` or `record_error_observation`
4. Before patching: `search_project_experience`
5. If result is relevant: `get_memory_detail`
6. Avoid `rejected_fix` / `project_preference` warnings
7. Use `run_project_command` for `test`/`lint`/`build`/`typecheck` when possible
8. Only after passing verification: `finalize_successful_fix`
9. If user rejects a strategy: `record_user_correction`

Do not:
- Create verified memory from unverified terminal errors
- Ignore user correction warnings
- Use rejected patterns
- Run arbitrary shell commands through Bugrecall

## C. User correction instruction

When I reject a fix strategy, record it in Bugrecall with `record_user_correction`. Store it as `rejected_fix` or `project_preference`, not as a verified fix.

## D. Monorepo instruction

When working in a monorepo, use the correct `workspace_path`, such as `apps/web` or `packages/api`, for all Bugrecall tools.

## E. Recurring error instruction

If an error repeats, check `get_recurring_errors` and prefer verified linked fixes when available.

## F. Short full instruction (paste into agent)

Use Bugrecall for this repository as the debug memory layer. Start with `bootstrap_project` and `get_project_profile`. For failures, call `ingest_terminal_error` (or `record_error_observation` in debug session flows), then call `search_project_experience` and `get_memory_detail` before patching. Respect `rejected_fix` and `project_preference` warnings. Use `run_project_command` for verification commands where possible. Only call `finalize_successful_fix` after verification passes. If I reject a strategy, call `record_user_correction`. In monorepos, pass `workspace_path` consistently.
