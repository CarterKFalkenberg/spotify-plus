import { secretMatches } from "../_shared/crypto.ts";
import { json, pathFor } from "../_shared/http.ts";
import { drainJobs, type JobContext } from "../_shared/jobs.ts";
export function createJobs(context: JobContext & { cronSecret: string }) {
  return async (req: Request): Promise<Response> => {
    if (
      !await secretMatches(req.headers.get("x-cron-secret"), context.cronSecret)
    ) {
      return json({ error: "unauthorized" }, 401);
    }
    try {
      if (pathFor(req, "jobs") === "/healthz" && req.method === "GET") {
        return json({
          ...await context.db.rpc<Record<string, unknown>>("app_health"),
          jobsSha: context.sha,
        });
      }
      if (pathFor(req, "jobs") !== "/" || req.method !== "POST") {
        return json({ error: "not_found" }, 404);
      }
      return json({ jobsSha: context.sha, ...await drainJobs(context) });
    } catch {
      return json({ error: "temporarily_unavailable" }, 503);
    }
  };
}
