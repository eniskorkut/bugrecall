export type VectorStoreState = "available" | "unavailable";

export type VectorStoreStatus = {
  state: VectorStoreState;
  enabled: boolean;
  reason?: string;
};

export type VectorIndexRow = {
  id: string;
  project_id: string;
  type: string;
  workspace: string | null;
  toolchain: string | null;
  language: string | null;
  error_class: string | null;
  model: string;
  dimension: number;
  vector: number[];
};

export type VectorSearchFilters = {
  type?: "incident" | "fact" | "decision" | "rejected_fix" | "project_preference";
  workspace?: string;
  toolchain?: string;
  language?: string;
  error_class?: string;
};

export type VectorSearchHit = {
  id: string;
  score: number;
  source: "vector";
};
