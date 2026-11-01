import {
  parseDiagnostic,
  type DiagnosticEvent,
  type DiagnosticFacts,
  type DiagnosticReason,
} from "../../supabase/functions/_shared/diagnostics-contract";

// One bounded, memory-only sender per document: no queue, storage, retry or error logging.
let documentId: string | undefined;
let sent = 0;
let pending = 0;
let healthy = 0;
const seen = new Set<string>();
export function playbackDiagnostics() {
  let playback: string | undefined;
  return (
    event: DiagnosticEvent,
    reason: DiagnosticReason = "none",
    facts: DiagnosticFacts = {},
    relatedRequest: string | null = null,
  ) => {
    try {
      const failure = [
        "navigation_unresolved",
        "pause_unresolved",
        "holder_retired",
        "pause_failed",
        "start_failed",
        "sdk_failed",
      ].includes(event);
      // Preserve room for failures after a long healthy tagging session.
      if (
        sent >= 80 ||
        (!failure && healthy >= 50) ||
        pending >= (failure ? 4 : 2)
      )
        return;
      const build = document
        .querySelector('meta[name="app-build"]')
        ?.getAttribute("content");
      documentId ??= crypto.randomUUID();
      playback ??= crypto.randomUUID();
      const key = `${playback}:${facts.operation ?? 0}:${event}:${reason}`;
      if (seen.has(key)) return;
      const body = parseDiagnostic({
        event,
        reason,
        facts,
        relatedRequest,
        build,
        document: documentId,
        playback,
      });
      seen.add(key);
      sent++;
      if (!failure) healthy++;
      pending++;
      void Promise.resolve()
        .then(() =>
          fetch("/api/diagnostics", {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(1500),
            keepalive: true,
          }),
        )
        .catch(() => {})
        .finally(() => {
          pending--;
        });
    } catch {
      /* Diagnostics never affect playback, including synchronous fetch failure. */
    }
  };
}
