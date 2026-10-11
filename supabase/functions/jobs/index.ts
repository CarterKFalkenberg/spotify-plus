import { runtimeConfig } from "../_shared/config.ts";
import { ServiceDatabase } from "../_shared/database.ts";
import { PrivateBackups } from "../_shared/backups.ts";
import { createJobs } from "./handler.ts";
const config = runtimeConfig();
Deno.serve(
  createJobs({
    db: new ServiceDatabase(config.supabaseUrl, config.serviceKey),
    backups: new PrivateBackups(config.supabaseUrl, config.serviceKey),
    sha: config.sha,
    cronSecret: config.cronSecret,
  }),
);
