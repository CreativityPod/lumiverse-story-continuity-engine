import { normalizePartialUpdate } from "./partial.js";

// Response excerpts are private inspection data, never prompt state or public
// snapshots. Keep both persisted records and frontend payloads bounded.
export function normalizeTrackerDiagnostics(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.attempts)) return null;
  const text = (entry, max = 180) => typeof entry === "string" ? entry.slice(0, max) : "";
  const count = entry => Number.isFinite(entry) && entry >= 0 ? Math.round(entry) : 0;
  return {
    contract: count(value.contract), provider: text(value.provider), model: text(value.model), connectionId: text(value.connectionId),
    outputMode: text(value.outputMode), sourceMessageId: text(value.sourceMessageId), outcome: text(value.outcome),
    unresolved: normalizePartialUpdate(value.unresolved), startedAt: count(value.startedAt), elapsedMs: count(value.elapsedMs), notes: (Array.isArray(value.notes) ? value.notes : []).slice(0, 5).map(note => text(note, 300)),
    attempts: value.attempts.filter(attempt => attempt && typeof attempt === "object").slice(0, 2).map(attempt => ({
      attempt: count(attempt.attempt), category: text(attempt.category), finishReason: text(attempt.finishReason),
      contentChars: count(attempt.contentChars), toolCalls: count(attempt.toolCalls), elapsedMs: count(attempt.elapsedMs),
      usage: { promptTokens: count(attempt.usage?.promptTokens), completionTokens: count(attempt.usage?.completionTokens) },
      issues: (Array.isArray(attempt.issues) ? attempt.issues : []).filter(issue => issue && typeof issue === "object").slice(0, 64).map(issue => ({
        path: text(issue.path), recordId: text(issue.recordId), code: text(issue.code), message: text(issue.message, 1000),
      })),
      excerpt: text(attempt.excerpt, 3000),
    })),
  };
}
