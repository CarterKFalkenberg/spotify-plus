export type Session = {
  authenticated: boolean;
  connection: "disconnected" | "disconnecting" | "connected" | "reconnect";
  authorizationDeadline?: string;
  reconnectWarning?: null | "required" | "seven_days" | "thirty_days";
};
export async function readSession(signal: AbortSignal): Promise<Session> {
  const response = await fetch("/api/session", {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error("session_unavailable");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object")
    throw new Error("session_unavailable");
  const item = value as Record<string, unknown>;
  const authenticated = item.authenticated === true;
  if (
    typeof item.authenticated !== "boolean" ||
    !(
      authenticated
        ? ["connected", "reconnect"]
        : ["disconnected", "disconnecting"]
    ).includes(String(item.connection)) ||
    (authenticated &&
      (typeof item.authorizationDeadline !== "string" ||
        !Number.isFinite(Date.parse(item.authorizationDeadline)) ||
        ![null, "required", "seven_days", "thirty_days"].includes(
          item.reconnectWarning as string | null,
        )))
  )
    throw new Error("session_unavailable");
  return value as Session;
}
export async function disconnect(): Promise<void> {
  const response = await fetch("/api/disconnect", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmation: "DELETE ALL APP DATA" }),
  });
  if (response.status !== 202) throw new Error("disconnect_failed");
  const result = (await response.json()) as Record<string, unknown>;
  if (
    result.disconnected !== true ||
    result.purgeComplete !== false ||
    result.connection !== "disconnecting"
  )
    throw new Error("disconnect_failed");
}
