import { runtimeConfig } from "../_shared/config.ts";
import { SecretBox } from "../_shared/crypto.ts";
import { ServiceDatabase } from "../_shared/database.ts";
import { createApi } from "./handler.ts";
const config = runtimeConfig();
Deno.serve(
  createApi({
    config,
    db: new ServiceDatabase(config.supabaseUrl, config.serviceKey),
    box: new SecretBox(config.tokenEncryptionKey),
  }),
);
