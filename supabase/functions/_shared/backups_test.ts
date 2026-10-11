import { mockResponse } from "./testing.ts";
import { PrivateBackups } from "./backups.ts";
import { assert, equal, rejects } from "./testing.ts";
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
Deno.test("snapshot buckets are created only on an explicit once-only grant and uploads never recreate them", async () => {
  const path = "1-00000000-0000-4000-8000-000000000001.bin";
  const calls: string[] = [];
  let exists = true;
  const backups = new PrivateBackups(
    "https://synthetic.example",
    "synthetic-service",
    (url, init) => {
      const route = new URL(String(url)).pathname;
      calls.push(`${init?.method ?? "GET"} ${route}`);
      if (
        route.endsWith("/bucket") && init?.method === "POST"
      ) return mockResponse("{}");
      if (route.includes("/bucket/")) {
        return exists
          ? mockResponse(
            JSON.stringify({
              public: false,
              file_size_limit: 5242880,
              allowed_mime_types: ["application/octet-stream"],
            }),
          )
          : mockResponse("{}", { status: 404 });
      }
      return mockResponse("{}", { status: 404 });
    },
  );
  equal(await backups.ensure(path, false), true);
  assert(!calls.some((call) => call === "POST /storage/v1/bucket"));
  calls.length = 0;
  equal(await backups.ensure(path, true), true);
  equal(calls.filter((call) => call === "POST /storage/v1/bucket").length, 1);
  calls.length = 0;
  exists = false;
  equal(await backups.ensure(path, false), false);
  await rejects(() => backups.upload(path, "late"));
  assert(!calls.some((call) => call === "POST /storage/v1/bucket"));
});
Deno.test("retirement requires actual bucket disappearance and does not treat provider errors as absence", async () => {
  const path = "1-00000000-0000-4000-8000-000000000001.bin";
  let deleted = false;
  const backups = new PrivateBackups(
    "https://synthetic.example",
    "synthetic-service",
    (_url, init) => {
      if (init?.method === "DELETE") {
        deleted = true;
        return mockResponse("{}");
      }
      if (init?.method === "POST") return mockResponse("{}");
      return mockResponse("{}", deleted ? { status: 404 } : {});
    },
  );
  equal(await backups.retire(path), true);
  await rejects(() =>
    new PrivateBackups(
      "https://synthetic.example",
      "synthetic-service",
      () => mockResponse("{}", { status: 403 }),
    ).retire(path)
  );
  const stillPresent = new PrivateBackups(
    "https://synthetic.example",
    "synthetic-service",
    () => mockResponse("{}"),
  );
  equal(await stillPresent.retire(path), false);
});
