import { strictEqual } from "node:assert/strict";
import { spotifyPlaylistOwnedBy } from "./spotify.ts";
Deno.test("playlist ownership keeps immutable account and profile identity namespaces separate", () => {
  const identity = { accountId: "immutable-account", id: "profile-id" };
  strictEqual(
    spotifyPlaylistOwnedBy({
      ownerAccountId: null,
      ownerProfileId: "profile-id",
    }, identity),
    true,
  );
  strictEqual(
    spotifyPlaylistOwnedBy({
      ownerAccountId: "immutable-account",
      ownerProfileId: "another-profile",
    }, identity),
    true,
  );
  strictEqual(
    spotifyPlaylistOwnedBy({
      ownerAccountId: "different-account",
      ownerProfileId: "profile-id",
    }, identity),
    false,
  );
  strictEqual(
    spotifyPlaylistOwnedBy(
      { ownerAccountId: "", ownerProfileId: "profile-id" },
      identity,
    ),
    false,
  );
  strictEqual(
    spotifyPlaylistOwnedBy({
      ownerAccountId: null,
      ownerProfileId: "immutable-account",
    }, identity),
    false,
  );
  strictEqual(spotifyPlaylistOwnedBy({}, identity), false);
});
