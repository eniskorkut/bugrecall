export type RetrievalLevel =
  | "signature_exact"
  | "signature_linked_memory"
  | "user_correction_warning"
  | "hybrid"
  | "vector"
  | "text"
  | "fallback";

export type RankingContext = {
  query: string;
  filters?: Record<string, unknown>;
  project_id: string;
  workspace_relative_path: string;
  requested_error_signature: boolean;
  requested_error_signature_id: string | null;
  requested_error_signature_hash: string | null;
  linked_memory_id: string | null;
  language: string | null;
  toolchain: string | null;
  framework: string | null;
  error_class: string | null;
};

export type RankingBreakdown = {
  semantic_score: number;
  keyword_score: number;
  metadata_score: number;
  signature_score: number;
  memory_type_score: number;
  quality_score: number;
  stale_penalty: number;
  final_score: number;
};

export type RankedSearchResult = {
  id: string;
  type: string;
  summary: string;
  content: string;
  metadata: Record<string, unknown>;
  confidence: number;
  score: number;
  reason: string;
  created_at: string;
  retrieval_hits: number;
  retrieval_level: RetrievalLevel;
  why_relevant: string[];
  ranking_breakdown: RankingBreakdown;
  ranking_reasons: string[];
};

type RankInput = {
  context: RankingContext;
  results: Array<Record<string, unknown>>;
};

type WarningInput = {
  context: RankingContext;
  warnings: Array<Record<string, unknown>>;
};

export function rankSearchResults(params: RankInput): RankedSearchResult[] {
  const ranked = params.results.map((row) => {
    const metadata = asObject(row.metadata);
    const summary = asString(row.summary) || asString(row.content);
    const content = asString(row.content);
    const semanticScore = normalizeScore(toNumber(row.score));
    const keywordScore = computeKeywordScore(params.context.query, `${summary} ${content} ${JSON.stringify(metadata)}`);
    const metadataScore = computeMetadataScore(params.context, { ...row, metadata });
    const signatureScore = computeSignatureScore(params.context, row, metadata);
    const memoryTypeScore = computeMemoryTypeScore(asString(row.type), metadata);
    const qualityScore = computeQualityScore({
      confidence: toNumber(row.confidence),
      retrieval_hits: toNumber(row.retrieval_hits),
    });
    const stalePenalty = computeStalePenalty({ created_at: asString(row.created_at), metadata, retrieval_hits: toNumber(row.retrieval_hits) });
    const finalScore = normalizeScore(
      0.3 * semanticScore +
        0.2 * keywordScore +
        0.2 * metadataScore +
        0.15 * signatureScore +
        0.1 * memoryTypeScore +
        0.05 * qualityScore -
        stalePenalty,
    );
    const rankingReasons = buildRankingReasons({
      semanticScore,
      metadataScore,
      signatureScore,
      memoryTypeScore,
      qualityScore,
      keywordScore,
      stalePenalty,
      context: params.context,
      row,
      metadata,
    });
    const retrievalLevel = signatureScore >= 1 ? "signature_linked_memory" : (asString(row.retrieval_level) as RetrievalLevel) || "text";

    return {
      id: asString(row.id),
      type: asString(row.type),
      summary,
      content,
      metadata,
      confidence: toNumber(row.confidence),
      score: finalScore,
      reason: asString(row.reason),
      created_at: asString(row.created_at),
      retrieval_hits: toNumber(row.retrieval_hits),
      retrieval_level: retrievalLevel,
      why_relevant: rankingReasons,
      ranking_breakdown: {
        semantic_score: semanticScore,
        keyword_score: keywordScore,
        metadata_score: metadataScore,
        signature_score: signatureScore,
        memory_type_score: memoryTypeScore,
        quality_score: qualityScore,
        stale_penalty: stalePenalty,
        final_score: finalScore,
      },
      ranking_reasons: rankingReasons,
    } satisfies RankedSearchResult;
  });

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.created_at.localeCompare(a.created_at);
  });

  return ranked;
}

export function rankWarnings(params: WarningInput): Array<Record<string, unknown>> {
  const q = tokenize(params.context.query);
  return params.warnings
    .map((warning) => {
      const rejectedPattern = asString(warning.rejected_pattern).toLowerCase();
      const futureRule = asString(warning.future_rule);
      const preferredPattern = asString(warning.preferred_pattern);
      const confidence = toNumber(warning.confidence);
      const type = asString(warning.type);
      const warningText = `${futureRule} ${preferredPattern} ${rejectedPattern}`;
      const keyword = computeKeywordScore(params.context.query, warningText);
      const patternMatch = rejectedPattern && q.some((token) => rejectedPattern.includes(token)) ? 1 : 0;
      const metadataMatch =
        Number(asString(warning.reason).includes("matching_error_class")) * 0.5 +
        Number(asString(warning.reason).includes("matching_toolchain")) * 0.3 +
        Number(asString(warning.reason).includes("matching_language")) * 0.2;
      const warningScore = normalizeScore(0.5 * patternMatch + 0.25 * keyword + 0.15 * metadataMatch + 0.1 * confidence);
      const warningReasons = [
        ...(patternMatch > 0 ? ["rejected_pattern_match"] : []),
        ...(keyword > 0.2 ? ["future_rule_keyword_match"] : []),
        ...(metadataMatch > 0 ? ["metadata_match"] : []),
      ];
      return {
        ...warning,
        type,
        summary: asString(warning.summary) || futureRule || preferredPattern || rejectedPattern,
        warning_score: warningScore,
        warning_reasons: warningReasons,
      };
    })
    .sort((a, b) => toNumber(b.warning_score) - toNumber(a.warning_score));
}

export function computeKeywordScore(query: string, text: string): number {
  const q = tokenize(query);
  if (q.length === 0) return 0;
  const target = tokenize(text);
  if (target.length === 0) return 0;
  const targetSet = new Set(target);
  let hits = 0;
  for (const token of q) {
    if (targetSet.has(token)) hits += 1;
  }
  return normalizeScore(hits / q.length);
}

export function computeMetadataScore(queryContext: RankingContext, memory: Record<string, unknown>): number {
  const metadata = asObject(memory.metadata);
  const rowType = asString(memory.type);
  let score = 0;
  let total = 0;
  score += matchField(queryContext.language, metadata.language);
  total += 1;
  score += matchField(queryContext.toolchain, metadata.toolchain);
  total += 1;
  score += matchField(queryContext.framework, metadata.framework);
  total += 1;
  score += matchField(queryContext.error_class, metadata.error_class);
  total += 1;
  if (queryContext.filters && typeof queryContext.filters.type === "string") {
    total += 1;
    score += matchField(queryContext.filters.type, rowType);
  }
  return normalizeScore(total > 0 ? score / total : 0);
}

export function computeQualityScore(memory: { confidence: number; retrieval_hits: number }): number {
  const confidence = normalizeScore(memory.confidence);
  const hitsBoost = normalizeScore(Math.min(memory.retrieval_hits, 20) / 20);
  return normalizeScore(confidence * 0.8 + hitsBoost * 0.2);
}

export function computeStalePenalty(memory: { created_at: string; metadata: Record<string, unknown>; retrieval_hits: number }): number {
  let penalty = 0;
  if (memory.metadata.stale === true || memory.metadata.invalidated_at) penalty += 0.2;
  const created = Date.parse(memory.created_at);
  if (Number.isFinite(created)) {
    const ageDays = (Date.now() - created) / (1000 * 60 * 60 * 24);
    if (ageDays > 180 && memory.retrieval_hits < 2) penalty += 0.08;
    else if (ageDays > 90 && memory.retrieval_hits < 1) penalty += 0.04;
  }
  return normalizeScore(penalty);
}

export function normalizeScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  if (score < 0) return 0;
  if (score > 1) return 1;
  return Number(score.toFixed(6));
}

export function buildRankingReasons(args: {
  semanticScore: number;
  metadataScore: number;
  signatureScore: number;
  memoryTypeScore: number;
  qualityScore: number;
  keywordScore: number;
  stalePenalty: number;
  context: RankingContext;
  row: Record<string, unknown>;
  metadata: Record<string, unknown>;
}): string[] {
  const reasons: string[] = ["same_project"];
  if (args.signatureScore >= 1) reasons.push("signature_linked_memory");
  if (matchField(args.context.error_class, args.metadata.error_class) > 0) reasons.push("same_error_class");
  if (matchField(args.context.toolchain, args.metadata.toolchain) > 0) reasons.push("same_toolchain");
  if (matchField(args.context.language, args.metadata.language) > 0) reasons.push("same_language");
  if (matchField(args.context.framework, args.metadata.framework) > 0) reasons.push("same_framework");
  if (args.memoryTypeScore >= 0.95) reasons.push("verified_fix");
  if (args.qualityScore >= 0.75) reasons.push("high_confidence");
  if (args.keywordScore >= 0.3) reasons.push("summary_keyword_match");
  if (args.semanticScore >= 0.5) reasons.push("semantic_match");
  if (args.stalePenalty > 0) reasons.push("stale_penalty_applied");
  return reasons;
}

function computeSignatureScore(context: RankingContext, row: Record<string, unknown>, metadata: Record<string, unknown>): number {
  if (context.linked_memory_id && asString(row.id) === context.linked_memory_id) return 1;
  const appliesTo = asObject(metadata.applies_to);
  if (context.requested_error_signature_id && asString(appliesTo.error_signature_id) === context.requested_error_signature_id) return 0.7;
  if (context.requested_error_signature_hash && asString(appliesTo.error_signature_hash) === context.requested_error_signature_hash) {
    return 0.5;
  }
  return 0;
}

function computeMemoryTypeScore(type: string, metadata: Record<string, unknown>): number {
  if (type === "incident") return metadata.verification_status === "user_preference_not_test_verified" ? 0.35 : 1;
  if (type === "decision") return 0.75;
  if (type === "fact") return 0.55;
  if (type === "rejected_fix" || type === "project_preference") return 0.1;
  return 0.4;
}

function matchField(expected: unknown, actual: unknown): number {
  const e = asString(expected).toLowerCase();
  if (!e) return 0;
  const a = asString(actual).toLowerCase();
  return e === a ? 1 : 0;
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, " ")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
