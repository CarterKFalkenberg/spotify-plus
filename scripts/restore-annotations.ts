// Explicit operator action only. Private runtime inputs arrive through stdin;
// never pass credentials in argv or echo snapshot annotation contents.
import {
  AnnotationBackupCodec,
  restoreAnnotations,
} from "../supabase/functions/_shared/annotation-backups.ts";
import { PrivateBackups } from "../supabase/functions/_shared/backups.ts";
import { SecretBox } from "../supabase/functions/_shared/crypto.ts";
import { ServiceDatabase } from "../supabase/functions/_shared/database.ts";
try {
  const input = await new Response(Deno.stdin.readable).json();
  if (
    input.confirmation !== "restore-annotations" ||
    typeof input.origin !== "string" ||
    new URL(input.origin).origin !== input.origin ||
    (!input.origin.startsWith("https://") &&
      input.origin !== "http://127.0.0.1:61021") ||
    typeof input.serviceKey !== "string" ||
    typeof input.backupEncryptionKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.owner) || !Number.isSafeInteger(input.epoch) ||
    input.epoch < 1 || typeof input.expectedRevision !== "string" ||
    (!/^\d{1,19}$/.test(input.expectedRevision) ||
      BigInt(input.expectedRevision) > 9223372036854775807n) ||
    typeof input.snapshotId !== "string" ||
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.snapshotId)
  ) throw new Error();
  const result = await restoreAnnotations(
    new ServiceDatabase(input.origin, input.serviceKey),
    new PrivateBackups(input.origin, input.serviceKey),
    new AnnotationBackupCodec(new SecretBox(input.backupEncryptionKey)),
    input,
  );
  console.log(JSON.stringify({ status: "restored", ...result }));
} catch {
  console.error(JSON.stringify({ status: "restore_failed" }));
  Deno.exit(1);
}
