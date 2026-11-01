// Closed vocabulary only. Never pass provider objects or exception messages here.
export const DIAGNOSTIC_EVENTS = [
  "navigation_unresolved",
  "pause_unresolved",
  "holder_retired",
  "pause_confirmed",
  "pause_failed",
  "start_dispatched",
  "start_acknowledged",
  "playing_confirmed",
  "start_failed",
  "sdk_failed",
  "controller_destroyed",
  "playback_api_failed",
  "token_api_failed",
  "api_failed",
  "job_failed",
] as const;
export const DIAGNOSTIC_REASONS = [
  "playback_target_unavailable",
  "playback_unconfirmed",
  "playback_service_error",
  "playback_control_unavailable",
  "reconnect",
  "unauthorized",
  "track_unavailable",
  "playback_cooldown",
  "database",
  "guard",
  "none",
  "deadline",
  "invalid_state",
  "different_item",
  "state_rejected",
  "pause_rejected",
  "retired",
  "unavailable",
  "authentication",
  "forbidden",
  "rate_limit",
  "cooldown",
  "quota",
  "network",
  "response",
  "http",
  "not_found",
  "playback_required",
  "control_unavailable",
  "initialization_error",
  "authentication_error",
  "account_error",
  "playback_error",
  "autoplay_failed",
  "device_timeout",
  "connect_timeout",
  "connect_failed",
  "token_timeout",
  "device_invalid",
  "device_disconnected",
  "sdk_unavailable",
] as const;
export type DiagnosticEvent = typeof DIAGNOSTIC_EVENTS[number];
export type DiagnosticReason = typeof DIAGNOSTIC_REASONS[number];
export interface DiagnosticFacts {
  startPending?: boolean;
  awaitingProof?: boolean;
  accepted?: boolean;
  stateSeen?: boolean;
  paused?: boolean;
  reading?: boolean;
  commandPending?: number;
  dispatches?: number;
  inFlight?: number;
  staleReads?: number;
  nullReads?: number;
  elapsedMs?: number;
  operation?: number;
  apiStatus?: number;
  upstreamStatus?: number;
  outgoingStatus?: number;
}
export interface BrowserDiagnostic {
  event: DiagnosticEvent;
  reason: DiagnosticReason;
  build: string;
  document: string;
  playback: string;
  facts: DiagnosticFacts;
  relatedRequest: string | null;
}
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const booleans = [
  "startPending",
  "awaitingProof",
  "accepted",
  "stateSeen",
  "paused",
  "reading",
];
const statuses = ["apiStatus", "upstreamStatus", "outgoingStatus"];
const counts = [
  "operation",
  "commandPending",
  "dispatches",
  "inFlight",
  "staleReads",
  "nullReads",
  "elapsedMs",
];
export function diagnosticReason(value: unknown): DiagnosticReason {
  return typeof value === "string" &&
      (DIAGNOSTIC_REASONS as readonly string[]).includes(value)
    ? value as DiagnosticReason
    : "unavailable";
}
export function parseDiagnostic(value: unknown): BrowserDiagnostic {
  const invalid = () => {
    throw new Error("invalid_input");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid();
  }
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).sort().join() !==
      "build,document,event,facts,playback,reason,relatedRequest" ||
    typeof body.event !== "string" ||
    !(DIAGNOSTIC_EVENTS as readonly string[]).includes(body.event) ||
    [
      "api_failed",
      "playback_api_failed",
      "token_api_failed",
      "job_failed",
    ].includes(body.event) ||
    typeof body.reason !== "string" ||
    !(DIAGNOSTIC_REASONS as readonly string[]).includes(body.reason) ||
    typeof body.build !== "string" || !/^[a-f0-9]{40}$/.test(body.build) ||
    typeof body.document !== "string" || !UUID.test(body.document) ||
    typeof body.playback !== "string" || !UUID.test(body.playback) ||
    !(body.relatedRequest === null ||
      (typeof body.relatedRequest === "string" &&
        UUID.test(body.relatedRequest))) ||
    !body.facts || typeof body.facts !== "object" || Array.isArray(body.facts)
  ) return invalid();
  for (const [key, fact] of Object.entries(body.facts)) {
    if (
      booleans.includes(key)
        ? typeof fact !== "boolean"
        : (!counts.includes(key) && !statuses.includes(key)) ||
          !Number.isSafeInteger(fact) ||
          (fact as number) < 0 ||
          (fact as number) > (statuses.includes(key) ? 599 : 86400000)
    ) return invalid();
  }
  return body as unknown as BrowserDiagnostic;
}
