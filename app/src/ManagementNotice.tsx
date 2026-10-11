/** Keep errors in the active modal and leave the user's rename draft intact. */
export function ManagementNotice({
  error,
  busy,
  onRefresh,
}: {
  error: string;
  busy: boolean;
  onRefresh: () => void;
}) {
  if (!error) return null;
  return (
    <p role="alert" className="notice">
      {error} Your draft is kept. Retry the preview, or{" "}
      <button className="compact" disabled={busy} onClick={onRefresh}>
        Refresh tag data
      </button>
      .
    </p>
  );
}
