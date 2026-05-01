# Architecture (Concise)

Bugrecall architecture is local-first and MCP-driven.

## Core runtime

- MCP stdio server (`node bin/pma.js`)
- Dashboard server (`node bin/pma.js dashboard`, localhost by default)

## Data layer

- SQLite is source-of-truth (`.agent/memory.db`)
- Memory records, task runs, attempts, patches, snapshots, signatures, recurring counters

## Retrieval layer

- Summary-first retrieval with progressive detail fetch
- Deterministic ranking with ranking breakdown/reasons
- User correction warnings separated from normal solution results

## Error intelligence

- Terminal error normalization
- Deterministic error signatures
- Recurring error tracking
- Verified fix linking to signatures

## Embeddings and vectors (optional)

- Local embedding worker (optional)
- Optional LanceDB vector index
- Graceful fallback to SQLite text retrieval

## Safety controls

- Safe exact+unique search/replace patching
- Snapshot/restore with workspace isolation
- Structured command runner (no arbitrary command text)

## Evaluation harness

- Fixture-driven retrieval evaluation
- Deterministic metrics:
  - top1_accuracy
  - top3_recall
  - mrr
  - warning_recall
  - false_positive_count
