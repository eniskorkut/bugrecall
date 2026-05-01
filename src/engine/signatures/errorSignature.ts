import { createHash } from "node:crypto";
import type { NormalizedErrorOutput } from "../normalization/types.js";
import type { ProjectIdentityRow, ProjectProfileRow } from "../../db/sqlite/store.js";

export type ErrorSignatureFields = {
  signature_hash: string;
  language: string | null;
  toolchain: string | null;
  error_class: string | null;
  normalized_message: string;
  top_frame_symbol: string | null;
  file_hint: string | null;
  command_kind: string | null;
  signature_input: string;
};

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function normalizeSignatureText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[A-Za-z]:[\\/][^\s)]+/g, "<abs-path>")
    .replace(/\/(?:users|home|var|private|tmp|opt|usr)\/[^\s)]+/gi, "<abs-path>")
    .replace(/\bline\s+\d+\b/g, "line <n>")
    .replace(/:\d+:\d+\b/g, ":<n>:<n>")
    .replace(/:\d+\b/g, ":<n>")
    .replace(/\s+/g, " ")
    .trim();
}

function toWorkspaceFileHint(project: ProjectIdentityRow, file: string | null | undefined): string | null {
  if (!file) return null;
  const normalized = file.replace(/\\/g, "/").trim();
  if (!normalized) return null;
  const workspacePrefix = project.workspace_relative_path === "." ? "" : `${project.workspace_relative_path}/`;
  const looksAbsolute = normalized.startsWith("/") || /^[A-Za-z]:[\\/]/.test(normalized);
  if (looksAbsolute) return null;
  if (workspacePrefix && normalized.startsWith(workspacePrefix)) {
    return normalized.slice(workspacePrefix.length);
  }
  return normalized.replace(/:\d+(?::\d+)?$/, "");
}

function extractTopFrameSymbol(normalized: NormalizedErrorOutput): string | null {
  const raw = String(normalized.metadata.top_frame_symbol ?? normalized.metadata.symbol ?? "").trim();
  if (raw) return normalizeSignatureText(raw);
  const fromMessage = normalized.normalized_error.match(/(?:in|at)\s+([A-Za-z_][A-Za-z0-9_.$-]*)/);
  if (fromMessage?.[1]) return normalizeSignatureText(fromMessage[1]);
  return null;
}

export function buildErrorSignatureInput(params: {
  project: ProjectIdentityRow;
  profile: ProjectProfileRow;
  normalized: NormalizedErrorOutput;
  commandKind?: string;
}): ErrorSignatureFields {
  const language = params.normalized.detected_language === "unknown" ? null : params.normalized.detected_language;
  const toolchain = params.normalized.detected_toolchain === "unknown" ? null : params.normalized.detected_toolchain;
  const errorClass = params.normalized.error_class === "unknown_error" ? null : params.normalized.error_class;
  const normalizedMessage = normalizeSignatureText(params.normalized.normalized_error);
  const fileHint = toWorkspaceFileHint(params.project, params.normalized.detected_files?.[0]);
  const topFrameSymbol = extractTopFrameSymbol(params.normalized);
  const commandKind = params.commandKind ?? null;
  const signatureParts = [
    params.project.project_id,
    params.project.workspace_relative_path,
    language ?? "unknown",
    toolchain ?? "unknown",
    errorClass ?? "unknown",
    normalizedMessage,
    topFrameSymbol ?? "",
    fileHint ?? "",
    commandKind ?? "",
  ];
  const signatureInput = signatureParts.join("|");
  return {
    signature_hash: sha256(signatureInput),
    language,
    toolchain,
    error_class: errorClass,
    normalized_message: normalizedMessage,
    top_frame_symbol: topFrameSymbol,
    file_hint: fileHint,
    command_kind: commandKind,
    signature_input: signatureInput,
  };
}

export function extractSignatureFields(
  normalizedError: NormalizedErrorOutput,
  projectIdentity: ProjectIdentityRow,
  profile: ProjectProfileRow,
  options?: { commandKind?: string },
): ErrorSignatureFields {
  return buildErrorSignatureInput({
    normalized: normalizedError,
    project: projectIdentity,
    profile,
    commandKind: options?.commandKind,
  });
}

export function computeErrorSignatureHash(input: string): string {
  return sha256(normalizeSignatureText(input));
}
