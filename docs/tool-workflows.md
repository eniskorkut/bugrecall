# Tool Workflows

## 1. Bootstrap workflow

1. `bootstrap_project`
2. `get_project_profile`

## 2. Terminal error workflow

1. `ingest_terminal_error`
2. `search_project_experience`
3. `get_memory_detail` (optional deep read)

## 3. Debug session workflow

1. `create_debug_session`
2. `record_error_observation`
3. `suggest_next_actions`
4. `run_project_command`
5. `finalize_successful_fix`

Command override note:
- For Docker/remote-runtime projects, add command arrays in `.agent/bugrecall.config.json` (or `bugrecall.config.json`) and keep `shell:false` execution.
- Example:
  - `"test": ["docker", "compose", "run", "--rm", "valuation-app", "python", "-m", "pytest"]`

## 4. User rejected strategy workflow

1. `record_user_correction`
2. `search_project_experience` (warnings should surface)

## 5. Recurring error workflow

1. Repeat `ingest_terminal_error` for same normalized failure
2. `get_recurring_errors`
3. After successful fix, `finalize_successful_fix` links verified memory

## 6. Patch safety workflow

1. `apply_search_replace_patch`
2. `restore_snapshot` (if rollback needed)

## 7. Optional dashboard management workflow

1. Inspect memories / recurring errors / corrections
2. Export project data as JSON
3. Delete obsolete memory or correction records explicitly (with confirmation)
