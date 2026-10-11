import { SecretBox } from "../_shared/crypto.ts";
import { createLibraryRunner, librarySpotify } from "../_shared/library.ts";
import { runtimeConfig } from "../_shared/config.ts";
import { ServiceDatabase } from "../_shared/database.ts";
import { PrivateBackups } from "../_shared/backups.ts";
import { playlistJobs } from "../_shared/playlist-runtime.ts";
import { createJobs } from "./handler.ts";
const config = runtimeConfig();
const db = new ServiceDatabase(config.supabaseUrl, config.serviceKey);
Deno.serve(
  createJobs({
    db,
    playlist: playlistJobs(
      db,
      new SecretBox(config.tokenEncryptionKey),
      config.clientId,
    ),
    library: createLibraryRunner({
      db,
      annotationBox: new SecretBox(config.annotationKey),
      spotify: librarySpotify({
        db,
        tokenBox: new SecretBox(config.tokenEncryptionKey),
        clientId: config.clientId,
      }),
    }),
    backups: new PrivateBackups(config.supabaseUrl, config.serviceKey),
    sha: config.sha,
    cronSecret: config.cronSecret,
  }),
);
