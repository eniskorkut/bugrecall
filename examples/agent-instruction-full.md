Use Bugrecall for this repository as the debug memory layer.

Required workflow:
1. `bootstrap_project`
2. `get_project_profile`
3. On errors, call `ingest_terminal_error` (or `record_error_observation` in debug-session flow)
4. Before patching, call `search_project_experience`
5. If relevant, call `get_memory_detail`
6. Respect `rejected_fix` and `project_preference` warnings
7. Use `run_project_command` (`test`, `lint`, `build`, `typecheck`) when available
8. Only after verification passes, call `finalize_successful_fix`
9. If I reject a strategy, call `record_user_correction`

Do not create verified memory from unverified terminal output.

In monorepos, use `workspace_path` consistently (example: `apps/web`).
