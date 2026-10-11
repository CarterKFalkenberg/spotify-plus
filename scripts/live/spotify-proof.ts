// Live operator probe: stdin contains private configuration, stdout is counts/booleans only.
// Real metadata remains inside this process. Never console.log exceptions or raw responses.
import {
  SpotifyClient,
  SpotifyError,
  type SpotifyPage,
  type SpotifyPlaylist,
  type SpotifyPlaylistItem,
  type SpotifySavedTrack,
} from "../../supabase/functions/_shared/spotify.ts";
import { ServiceDatabase } from "../../supabase/functions/_shared/database.ts";
import {
  ownerFingerprint,
  SecretBox,
} from "../../supabase/functions/_shared/crypto.ts";
import {
  databasePacing,
  OwnerTokens,
} from "../../supabase/functions/_shared/tokens.ts";
import { pacedRequests } from "./paced-request.ts";
interface Input {
  origin: string;
  serviceKey: string;
  clientId: string;
  encryptionKey: string;
  bindingKey: string;
  ownerFingerprint: string;
  epoch: number;
  registryPath: string;
  authorized: boolean;
}
interface Registry {
  operation: string;
  epoch: number;
  ownerFingerprint: string;
  playlistId: string | null;
  status: "creating" | "created" | "removed";
}
const decoder = new TextDecoder();
function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
export async function writeRegistry(path: string, registry: Registry) {
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(registry), { mode: 0o600 });
  await Deno.rename(tmp, path);
}
async function run(input: Input) {
  check(input.authorized === true, "test_playlist_authorization_required");
  const db = new ServiceDatabase(input.origin, input.serviceKey);
  check(
    await db.rpc("app_epoch_active", { p_epoch: input.epoch }),
    "connected_owner_required",
  );
  let registry: Registry | null = null;
  try {
    registry = JSON.parse(await Deno.readTextFile(input.registryPath));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw new Error("invalid_disposable_registry");
    }
  }
  const tokens = new OwnerTokens(
    db,
    new SecretBox(input.encryptionKey),
    input.epoch,
    input.clientId,
  );
  let dispatched = 0;
  const client = new SpotifyClient({
    fetch: (...args) => {
      dispatched++;
      return fetch(...args);
    },
    tokens,
    pacing: databasePacing(db, input.epoch),
    isManagedPlaylist: async (id) => {
      const current: Registry = JSON.parse(
        await Deno.readTextFile(input.registryPath),
      );
      return current.playlistId === id && current.epoch === input.epoch &&
        current.ownerFingerprint === input.ownerFingerprint &&
        current.status === "created" &&
        await db.rpc<boolean>("app_epoch_active", { p_epoch: input.epoch });
    },
  });
  const request = pacedRequests(client, () => dispatched);
  const identity = await request({ method: "GET", path: "/me" }) as {
    accountId: string;
    id: string;
  };
  check(
    await ownerFingerprint(identity.accountId, input.bindingKey) ===
      input.ownerFingerprint,
    "immutable_owner_mismatch",
  );
  async function playlists() {
    const all: SpotifyPlaylist[] = [];
    let offset = 0;
    do {
      const page = await request({
        method: "GET",
        path: "/me/playlists",
        query: { limit: 50, offset },
      }) as SpotifyPage<SpotifyPlaylist>;
      all.push(...page.items);
      if (page.nextOffset === null) return all;
      check(
        page.nextOffset > offset && page.nextOffset <= 100_000,
        "playlist_paging_unbounded",
      );
      offset = page.nextOffset;
    } while (true);
  }
  async function removeTracked() {
    check(registry?.playlistId, "tracked_playlist_required");
    const uri = `spotify:playlist:${registry.playlistId}`;
    await request({
      method: "DELETE",
      path: "/me/library",
      query: { uris: uri },
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      const contains = await request({
        method: "GET",
        path: "/me/library/contains",
        query: { uris: uri },
      }) as boolean[];
      const absent = !(await playlists()).some((item) =>
        item.id === registry!.playlistId
      );
      if (contains[0] === false && absent) {
        registry.status = "removed";
        await writeRegistry(input.registryPath, registry);
        return;
      }
      if (attempt < 2) await new Promise((done) => setTimeout(done, 2000));
    }
    throw new Error("cleanup_unsupported_or_unconfirmed");
  }
  if (registry && registry.status !== "removed") {
    check(
      registry.epoch === input.epoch &&
        registry.ownerFingerprint === input.ownerFingerprint,
      "unresolved_disposable_owner_changed",
    );
    if (!registry.playlistId) {
      const matches = (await playlists()).filter((item) =>
        item.description?.includes(`[Tagger API test ${registry!.operation}]`)
      );
      check(
        matches.length === 1 && matches[0]!.ownerId === identity.id &&
          matches[0]!.public === false,
        "ambiguous_creation_requires_reconciliation",
      );
      registry.playlistId = matches[0]!.id;
      registry.status = "created";
      await writeRegistry(input.registryPath, registry);
    }
    await removeTracked();
    throw new Error("previous_disposable_cleaned_rerun_proof");
  }
  const uris: string[] = [];
  let offset = 0, total = 0, pages = 0, observed = 0;
  do {
    const page = await request({
      method: "GET",
      path: "/me/tracks",
      query: { limit: 50, offset },
    }) as SpotifyPage<SpotifySavedTrack>;
    pages++;
    observed += page.items.length;
    total = page.total;
    for (const item of page.items) {
      if (
        item.track?.uri && item.track.isPlayable && !item.track.isLocal &&
        !uris.includes(item.track.uri)
      ) uris.push(item.track.uri);
    }
    if (uris.length > 100 || page.nextOffset === null) break;
    check(
      page.nextOffset > offset && page.nextOffset <= 100_000,
      "saved_paging_unbounded",
    );
    offset = page.nextOffset;
  } while (true);
  const target = uris.slice(0, 101);
  check(target.length > 0, "no_playable_tracks_for_live_playlist_proof");
  registry = {
    operation: crypto.randomUUID(),
    epoch: input.epoch,
    ownerFingerprint: input.ownerFingerprint,
    playlistId: null,
    status: "creating",
  };
  await writeRegistry(input.registryPath, registry);
  let cleanupAttempted = false;
  try {
    const created = await request({
      method: "POST",
      path: "/me/playlists",
      body: {
        name: `Tagger API test ${registry.operation}`,
        public: false,
        collaborative: false,
        description:
          `[Tagger API test ${registry.operation}] Disposable contract verification; removed after proof.`,
      },
    }) as SpotifyPlaylist;
    check(
      created.public === false && created.ownerId === identity.id,
      "private_owned_creation_required",
    );
    registry.playlistId = created.id;
    registry.status = "created";
    await writeRegistry(input.registryPath, registry);
    const path = `/playlists/${created.id}/items`;
    for (let start = 0; start < target.length; start += 100) {
      await request({
        method: "POST",
        path,
        body: { uris: target.slice(start, start + 100) },
      });
    }
    const ordered = async (expected: string[]) => {
      const actual: (string | null)[] = [];
      let position = 0;
      do {
        const page = await request({
          method: "GET",
          path,
          query: { limit: 50, offset: position },
        }) as SpotifyPage<SpotifyPlaylistItem>;
        actual.push(...page.items.map((item) => item.uri));
        if (page.nextOffset === null) break;
        check(
          page.nextOffset > position && page.nextOffset <= expected.length,
          "unexpected_playlist_size",
        );
        position = page.nextOffset;
      } while (true);
      check(
        actual.length === expected.length &&
          actual.every((uri, index) => uri === expected[index]),
        "ordered_membership_mismatch",
      );
    };
    await ordered(target);
    const reversed = [...target].reverse();
    await request({
      method: "PUT",
      path,
      body: { uris: reversed.slice(0, 100) },
    });
    for (let start = 100; start < reversed.length; start += 100) {
      await request({
        method: "POST",
        path,
        body: { uris: reversed.slice(start, start + 100) },
      });
    }
    await ordered(reversed);
    cleanupAttempted = true;
    await removeTracked();
    return {
      ownerBound: true,
      savedSchema: true,
      savedTotal: total,
      savedPages: pages,
      savedObserved: observed,
      playlistItems: target.length,
      multiChunk: target.length > 100,
      fewerAvailable: uris.length <= 100,
      privatePlaylist: true,
      orderedAdd: true,
      orderedReplace: true,
      removedByContains: true,
      removedByCurrentUserPlaylists: true,
    };
  } finally {
    if (
      registry?.playlistId && registry.status === "created" && !cleanupAttempted
    ) await removeTracked();
  }
}
if (import.meta.main) {
  try {
    const chunks: Uint8Array[] = [];
    for await (const chunk of Deno.stdin.readable) chunks.push(chunk);
    const input = JSON.parse(
      chunks.map((chunk) => decoder.decode(chunk)).join(""),
    ) as Input;
    console.log(JSON.stringify({ passed: true, ...await run(input) }));
  } catch (error) {
    const allowed = [
      "test_playlist_authorization_required",
      "connected_owner_required",
      "invalid_disposable_registry",
      "immutable_owner_mismatch",
      "playlist_paging_unbounded",
      "tracked_playlist_required",
      "cleanup_unsupported_or_unconfirmed",
      "unresolved_disposable_owner_changed",
      "ambiguous_creation_requires_reconciliation",
      "previous_disposable_cleaned_rerun_proof",
      "saved_paging_unbounded",
      "no_playable_tracks_for_live_playlist_proof",
      "private_owned_creation_required",
      "unexpected_playlist_size",
      "ordered_membership_mismatch",
    ];
    const blocker = error instanceof SpotifyError
      ? `spotify_${error.kind}`
      : error instanceof Error && allowed.includes(error.message)
      ? error.message
      : "live_spotify_proof_failed";
    console.log(JSON.stringify({ passed: false, blocker }));
    Deno.exitCode = 1;
  }
}
