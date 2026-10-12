import { assert, equal, rejects } from "./testing.ts";
import {
  expiryDate,
  localDate,
  playlistDescription,
  PlaylistError,
  renderQuery,
  verifiedPrefix,
} from "./playlist-domain.ts";
import { parseQuery } from "./contracts.ts";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
Deno.test("playlist calendar retention clamps month ends and uses New York through both DST transitions", () => {
  equal(expiryDate(Date.parse("2026-01-31T23:30:00Z"), "month"), "2026-02-28");
  equal(expiryDate(Date.parse("2028-01-31T23:30:00Z"), "month"), "2028-02-29");
  equal(
    expiryDate(Date.parse("2026-11-30T23:30:00Z"), "threeMonths"),
    "2027-02-28",
  );
  equal(expiryDate(Date.parse("2026-03-07T23:30:00Z"), "week"), "2026-03-14");
  equal(expiryDate(Date.parse("2026-10-31T23:30:00Z"), "week"), "2026-11-07");
  equal(localDate(Date.parse("2026-03-09T03:30:00Z")), "2026-03-08");
  equal(localDate(Date.parse("2026-11-02T04:30:00Z")), "2026-11-01");
  equal(expiryDate(Date.now(), "pinned"), null);
});
Deno.test("bounded disclosure retains marker, nested AST and exact user description text", () => {
  const query = parseQuery({
    version: 1,
    root: {
      op: "not",
      child: {
        op: "or",
        children: [{ op: "tag", tagId: id }, { op: "tag", tagId: id }],
      },
    },
  });
  const text = renderQuery(query, { [id]: "é 😍".repeat(80) });
  const original = JSON.stringify(query);
  const first = playlistDescription(id, text, "2026-12-01", "My notes  ");
  assert(
    [...first].length <= 300 && first.includes("…") &&
      first.startsWith("My notes   "),
  );
  assert(
    first.includes("2026-12-01") && first.includes("overwrites manual edits"),
  );
  const changed = playlistDescription(id, text, null, first + "  End notes");
  assert(changed.startsWith("My notes   ") && changed.endsWith("  End notes"));
  assert(changed.includes("Pinned; never expires"));
  equal(JSON.stringify(query), original);
});
Deno.test("no room for disclosure preserves user text by failing, never truncating it", async () => {
  await rejects(
    () =>
      Promise.resolve(
        playlistDescription(id, "a", null, "User note ".repeat(100)),
      ),
    (e) => e instanceof PlaylistError && e.kind === "description_capacity",
  );
});
Deno.test("ordered prefixes retain unavailable positions and reject append duplicates", () => {
  assert(verifiedPrefix(["a", "b", "c"], ["a", "b"]));
  assert(!verifiedPrefix(["a", "b", "c"], ["a", null, "c"]));
  assert(!verifiedPrefix(["a", "b"], ["a", "b", "b"]));
  assert(!verifiedPrefix(["a", "b"], ["b", "a"]));
});
Deno.test("tag framing text cannot inject a managed terminator across repeated lifecycle updates", () => {
  const query = parseQuery({ version: 1, root: { op: "tag", tagId: id } });
  const label = `[/Tagger] [Tagger:${id}] [] \\ é 😍`;
  const before = JSON.stringify(query);
  let description = "Owner text  ";
  const queryText = renderQuery(query, { [id]: label });
  for (const expires of ["2026-02-28", "2026-03-31", null, "2026-05-31"]) {
    description = playlistDescription(id, queryText, expires, description);
    assert(description.startsWith("Owner text   "));
    equal(description.split("[/Tagger]").length, 2);
    equal(description.split(`[Tagger:${id}]`).length, 2);
    if (expires) assert(description.includes(expires));
    assert([...description].length <= 300);
  }
  assert(
    !description.includes("2026-02-28") && !description.includes("2026-03-31"),
  );
  equal(JSON.stringify(query), before);
});
Deno.test("absent managed block uses one space while preserving exact outside notes across regeneration", () => {
  const marker = `[Tagger:${id}]`;
  for (
    const notes of ["Outside notes", "Outside notes  ", "Owner\ntext\t &amp;"]
  ) {
    const first = playlistDescription(id, "Synthetic query", null, notes);
    equal(first.slice(0, first.indexOf(marker)), notes + " ");
    const second = playlistDescription(
      id,
      "Changed query",
      "2026-12-01",
      first,
    );
    equal(second.slice(0, second.indexOf(marker)), notes + " ");
    equal(second.split(marker).length, 2);
    equal(second.split("[/Tagger]").length, 2);
    assert([...second].length <= 300);
  }
});
