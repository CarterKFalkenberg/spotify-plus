import {
  ContractError,
  parseAcknowledge,
  parseCreateTag,
  parseId,
  parseLibraryFacets,
  parseLibrarySearch,
  parseLibrarySync,
  parseQueryPreview,
  parseTagAction,
  parseTagLookup,
  parseTagManage,
  parseTagSearch,
  parseTagSelection,
  parseTagVocabulary,
  parseUndoTagAction,
} from "../_shared/contracts.ts";
import type { Database } from "../_shared/database.ts";
import { json, readJson } from "../_shared/http.ts";

// Called only after the shared proxy/session/origin checks in handler.ts.
export async function libraryApi(
  req: Request,
  path: string,
  sessionHash: string,
  epoch: number,
  db: Database,
): Promise<Response | null> {
  const url = new URL(req.url);
  if (path === "/api/library/status" && req.method === "GET") {
    if (url.searchParams.size) throw new ContractError("parameters");
    return json(await db.rpc("app_library_status", { p_epoch: epoch }));
  }
  if (path === "/api/tags" && req.method === "GET") {
    if (
      [...url.searchParams.keys()].some((key) =>
        !["search", "limit"].includes(key) ||
        url.searchParams.getAll(key).length !== 1
      )
    ) throw new ContractError("parameters");
    const limit = url.searchParams.get("limit");
    if (limit !== null && !/^[1-9][0-9]{0,2}$/.test(limit)) {
      throw new ContractError("limit");
    }
    const request = parseTagSearch({
      search: url.searchParams.get("search") ?? "",
      limit: limit === null ? 20 : Number(limit),
    });
    return json(
      await db.rpc("app_tags_search", {
        p_epoch: epoch,
        p_search: request.search,
        p_limit: request.limit,
      }),
    );
  }
  if (req.method !== "POST") return null;
  if (
    path === "/api/tags/vocabulary" || path === "/api/tags/selection" ||
    path === "/api/tags/manage-preview" || path === "/api/tags/manage"
  ) {
    const raw = await readJson(req);
    const managing = path === "/api/tags/manage";
    const request = path === "/api/tags/vocabulary"
      ? parseTagVocabulary(raw)
      : path === "/api/tags/selection"
      ? parseTagSelection(raw)
      : parseTagManage(raw, managing);
    const rpc = path === "/api/tags/vocabulary"
      ? "app_tags_vocabulary"
      : path === "/api/tags/selection"
      ? "app_tags_selection"
      : managing
      ? "app_tags_manage"
      : "app_tags_manage_preview";
    return json(
      await db.rpc(rpc, {
        p_epoch: epoch,
        p_request: request,
        ...(managing ? { p_session_hash: sessionHash } : {}),
      }),
    );
  }
  if (path === "/api/library/facets") {
    const request = parseLibraryFacets(await readJson(req));
    return json(
      await db.rpc("app_library_facets", {
        p_epoch: epoch,
        p_request: request,
      }),
    );
  }
  if (path === "/api/library/sync") {
    const request = parseLibrarySync(await readJson(req));
    return json(
      await db.rpc("app_library_sync", {
        p_epoch: epoch,
        p_reason: request.reason,
      }),
    );
  }
  if (path === "/api/library/search") {
    const request = parseLibrarySearch(await readJson(req));
    return json(
      await db.rpc("app_library_search", {
        p_epoch: epoch,
        p_request: request,
      }),
    );
  }
  if (path === "/api/library/acknowledge") {
    const request = parseAcknowledge(await readJson(req));
    return json(
      await db.rpc("app_library_acknowledge", {
        p_epoch: epoch,
        p_track_keys: request.trackKeys,
      }),
    );
  }
  if (path === "/api/tags") {
    const request = parseCreateTag(await readJson(req));
    return json(
      await db.rpc("app_tag_create", { p_epoch: epoch, p_name: request.name }),
    );
  }
  if (path === "/api/tags/lookup") {
    const request = parseTagLookup(await readJson(req));
    return json(
      await db.rpc("app_tags_lookup", {
        p_epoch: epoch,
        p_tag_ids: request.tagIds,
      }),
    );
  }
  if (path === "/api/tag-actions") {
    const request = parseTagAction(await readJson(req));
    return json(
      await db.rpc("app_tag_action", {
        p_epoch: epoch,
        p_session_hash: sessionHash,
        p_request: request,
      }),
    );
  }
  const undo = /^\/api\/tag-actions\/([^/]+)\/undo$/.exec(path);
  if (undo) {
    const id = parseId(undo[1]);
    parseUndoTagAction(await readJson(req));
    return json(
      await db.rpc("app_tag_undo", {
        p_epoch: epoch,
        p_session_hash: sessionHash,
        p_action_id: id,
      }),
    );
  }
  if (path === "/api/query/preview") {
    const request = parseQueryPreview(await readJson(req));
    return json(
      await db.rpc("app_query_preview", { p_epoch: epoch, p_request: request }),
    );
  }
  return null;
}
