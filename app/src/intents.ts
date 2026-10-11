export const createIntentKey = "tagger-pending-create";
export const playlistIntentKey = "tagger-pending-playlist-actions";
/** A confirmed disconnect cancels the old owner's durable work. Reconnect does not. */
export function forgetPlaylistIntents() {
  try {
    sessionStorage.removeItem(createIntentKey);
    sessionStorage.removeItem(playlistIntentKey);
  } catch {
    // The server remains the authority for disconnect even if storage is unavailable.
  }
}
