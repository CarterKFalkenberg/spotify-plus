import {
  AnnotationBackupCodec,
  annotationBackupJob,
} from "../_shared/annotation-backups.ts";
import { runtimeConfig } from "../_shared/config.ts";
import { SecretBox } from "../_shared/crypto.ts";
import { ServiceDatabase } from "../_shared/database.ts";
import { PrivateBackups } from "../_shared/backups.ts";
import { createLibraryRunner, librarySpotify } from "../_shared/library.ts";
import { drainJobs } from "../_shared/jobs.ts";
import { playlistJobs } from "../_shared/playlist-runtime.ts";
import { createApi } from "./handler.ts";
declare const EdgeRuntime: { waitUntil(task: Promise<unknown>): void };
const config = runtimeConfig();
const db = new ServiceDatabase(config.supabaseUrl, config.serviceKey);
const box = new SecretBox(config.tokenEncryptionKey);
const backups = new PrivateBackups(config.supabaseUrl, config.serviceKey);
const jobs = {
  db,
  sha: config.sha,
  backups,
  annotationBackup: annotationBackupJob(
    db,
    backups,
    new AnnotationBackupCodec(new SecretBox(config.backupEncryptionKey)),
  ),
  library: createLibraryRunner({
    db,
    annotationBox: new SecretBox(config.annotationKey),
    spotify: librarySpotify({ db, tokenBox: box, clientId: config.clientId }),
  }),
  playlist: playlistJobs(db, box, config.clientId),
};
Deno.serve(
  createApi({
    config,
    db,
    box,
    startJobs: () => {
      // One invocation, at most 20 claimed jobs / 80 seconds. Leases and cron
      // remain authoritative if this opportunistic background task is stopped.
      EdgeRuntime.waitUntil(drainJobs(jobs).catch(() => undefined));
    },
  }),
);
