import { mockResponse } from "./testing.ts";
import { PrivateBackups } from "./backups.ts";
import { equal, rejects } from "./testing.ts";
Deno.test("backup purge uses fixed private Storage bucket API then verifies emptiness", async () => {
  const calls: string[] = [];
  const backups = new PrivateBackups(
    "https://synthetic.example",
    "synthetic-service",
    (input, init) => {
      calls.push(`${init?.method} ${new URL(String(input)).pathname}`);
      return mockResponse(JSON.stringify(calls.length === 1 ? {} : []));
    },
  );
  equal(await backups.purge(), true);
  equal(calls, [
    "POST /storage/v1/bucket/annotation-backups/empty",
    "POST /storage/v1/object/list/annotation-backups",
  ]);
});
Deno.test("backup purge never treats remaining objects or provider errors as success", async () => {
  const backups = new PrivateBackups(
    "https://synthetic.example",
    "synthetic-service",
    () => mockResponse('[{"name":"synthetic-backup"}]'),
  );
  equal(await backups.purge(), false);
  await rejects(
    () =>
      new PrivateBackups(
        "https://synthetic.example",
        "synthetic-service",
        () => mockResponse("private storage error", { status: 500 }),
      ).purge(),
    (e) => e instanceof Error && e.message === "backup_storage_unavailable",
  );
});
