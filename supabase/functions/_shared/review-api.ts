import { ContractError } from "./contracts.ts";
import type { Database } from "./database.ts";
import { json, readJson } from "./http.ts";
import type { ReviewCommand, ReviewInput } from "./review-contracts.ts";

// Called after proxy, session and mutation origin checks.
export async function reviewApi(
  req: Request,
  path: string,
  epoch: number,
  db: Database,
): Promise<Response | null> {
  if (!path.startsWith("/api/review")) return null;
  if (new URL(req.url).search) throw new ContractError("parameters");
  if (
    req.method === "GET" &&
    ["/api/review", "/api/review/destinations"].includes(path)
  ) {
    return json(
      await db.rpc("app_review_get", {
        p_epoch: epoch,
        p_destinations: path.endsWith("/destinations"),
      }),
    );
  }
  const command = path.slice("/api/review/".length) as ReviewCommand;
  if (
    req.method !== "POST" ||
    ![
      "destinations",
      "draft",
      "session",
      "skip",
      "done",
      "discard",
      "undo",
      "retry",
      "cancel",
    ].includes(command)
  ) return null;
  const input = reviewInput(command, await readJson(req, 16384));
  return json(
    await db.rpc("app_review_command", {
      p_epoch: epoch,
      p_command: command,
      p_input: input,
    }),
    ["done", "discard", "undo", "retry"].includes(command) ? 202 : 200,
  );
}

export function reviewInput(
  command: ReviewCommand,
  value: unknown,
): ReviewInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractError("review");
  }
  const v = value as Record<string, unknown>;
  const fields = [
    "revision",
    ...({
      destinations: ["destinationIds"],
      draft: ["trackKey", "destinationIds"],
      session: [],
      skip: ["trackKey"],
      done: ["trackKey", "requestId"],
      discard: ["trackKey", "requestId", "confirmation"],
      undo: ["operationId", "requestId"],
      retry: ["operationId"],
      cancel: ["operationId"],
    }[command]),
  ];
  if (
    Object.keys(v).some((k) => !fields.includes(k)) ||
    fields.some((k) => !Object.hasOwn(v, k)) ||
    typeof v.revision !== "string" || !/^\d{1,18}$/.test(v.revision)
  ) throw new ContractError("review");
  if (
    fields.includes("trackKey") &&
    (typeof v.trackKey !== "string" || !/^[0-9a-f]{64}$/.test(v.trackKey))
  ) throw new ContractError("review");
  for (const key of ["operationId", "requestId"]) {
    if (
      fields.includes(key) &&
      (typeof v[key] !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          v[key],
        ))
    ) throw new ContractError("review");
  }
  if (
    fields.includes("destinationIds") &&
    (!Array.isArray(v.destinationIds) || v.destinationIds.length > 100 ||
      v.destinationIds.some((id) =>
        typeof id !== "string" || !/^[A-Za-z0-9]{22}$/.test(id)
      ) || new Set(v.destinationIds).size !== v.destinationIds.length)
  ) throw new ContractError("review");
  if (command === "discard" && v.confirmation !== true) {
    throw new ContractError("review");
  }
  return structuredClone(v) as unknown as ReviewInput;
}
