import type { Database } from "./database.ts";
import {
  ContractError,
  parseCreatePlaylist,
  parseId,
  parsePageRequest,
  parsePlaylistAction,
  type PlaylistListResponse,
  type PlaylistMutationResponse,
} from "./contracts.ts";
import { json, readJson } from "./http.ts";

// Called only after the shared proxy, owner session, and mutation-origin checks.
// Every RPC returns an explicit SQL DTO, never provider rows or credentials.
export async function playlistApi(
  request: Request,
  path: string,
  _sessionHash: string,
  epoch: number,
  db: Database,
): Promise<Response | null> {
  if (path === "/api/playlists" && request.method === "GET") {
    const params = new URL(request.url).searchParams;
    for (const key of params.keys()) {
      if (
        !["cursor", "limit"].includes(key) || params.getAll(key).length !== 1
      ) throw new ContractError("page");
    }
    const rawLimit = params.get("limit");
    if (rawLimit !== null && !/^[1-9][0-9]{0,2}$/.test(rawLimit)) {
      throw new ContractError("limit");
    }
    const page = parsePageRequest({
      cursor: params.get("cursor"),
      limit: rawLimit === null ? 50 : Number(rawLimit),
    });
    return json(
      await db.rpc<PlaylistListResponse>("app_playlist_list", {
        p_epoch: epoch,
        p_cursor: page.cursor,
        p_limit: page.limit,
      }),
    );
  }
  if (path === "/api/playlists" && request.method === "POST") {
    const input = parseCreatePlaylist(await readJson(request));
    return json(
      await db.rpc<PlaylistMutationResponse>("app_playlist_create", {
        p_epoch: epoch,
        p_request: input,
      }),
      202,
    );
  }
  const action = /^\/api\/playlists\/([^/]+)\/actions$/.exec(path);
  if (action && request.method === "POST") {
    const id = parseId(action[1]);
    const input = parsePlaylistAction(await readJson(request));
    return json(
      await db.rpc<PlaylistMutationResponse>("app_playlist_action", {
        p_epoch: epoch,
        p_id: id,
        p_request: input,
      }),
      202,
    );
  }
  return null;
}
