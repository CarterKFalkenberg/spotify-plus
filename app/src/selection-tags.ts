import type {
  LibraryRevision,
  Selection,
  TagDTO,
} from "../../supabase/functions/_shared/contracts";
import { api, ApiError } from "./api";
import { sameRevision, tagSelection, vocabulary } from "./fast-api";
/** Inspect exactly the displayed choices under the selection's captured revision. */
export async function inspectTagOptions(
  options: readonly TagDTO[],
  selection: Selection,
  revision: LibraryRevision,
  signal: AbortSignal,
) {
  if (options.length === 0) return null;
  const expectedRevision =
    selection.kind === "filter" ? selection.expectedRevision : revision;
  const result = await api(
    "/tags/selection",
    tagSelection,
    { selection, tagIds: options.map((t) => t.id), expectedRevision },
    signal,
  );
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (
    !sameRevision(result.revision, expectedRevision) ||
    result.tags.length !== options.length ||
    result.tags.some((t, i) => t.tag.id !== options[i]?.id)
  )
    throw new ApiError("invalid_response");
  return result;
}
export async function loadBulkTags(
  search: string,
  cursor: string | null,
  selection: Selection,
  revision: LibraryRevision,
  signal: AbortSignal,
) {
  const page = await api(
    "/tags/vocabulary",
    vocabulary,
    { search, sort: "mostUsed", cursor, limit: 50 },
    signal,
  );
  const inspection = await inspectTagOptions(
    page.tags,
    selection,
    revision,
    signal,
  );
  return inspection
    ? { ...inspection, nextCursor: page.nextCursor }
    : {
        revision:
          selection.kind === "filter" ? selection.expectedRevision : revision,
        selectedCount: null,
        tags: [],
        nextCursor: page.nextCursor,
      };
}
