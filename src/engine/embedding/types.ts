export type EmbeddingJob = {
  request_id: string;
  record_id: string;
  model: string;
  text: string;
};

export type EmbeddingResult = {
  request_id: string;
  record_id: string;
  model: string;
  dimension: number;
  vector: number[];
};

export type EmbeddingError = {
  request_id: string;
  record_id: string;
  error: string;
};
