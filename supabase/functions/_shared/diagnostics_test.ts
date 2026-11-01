import { reportDiagnostic } from "./diagnostics.ts";
import { database, equal } from "./testing.ts";
Deno.test("server diagnostics classify errors without serializing arbitrary fields and fail open", async () => {
  const records: Record<string, unknown>[] = [];
  const db = database((_name, args) => {
    records.push(args);
    throw new Error("private credential and payload");
  });
  equal(
    await reportDiagnostic(
      db,
      "a".repeat(40),
      "api",
      "api_failed",
      {
        message: "private",
        kind: "private",
      },
      crypto.randomUUID(),
      {},
      1,
    ),
    false,
  );
  equal(records.length, 1);
  equal(records[0].p_reason, "unavailable");
  equal(records[0].p_facts, {});
  equal(JSON.stringify(records).includes("private"), false);
});
