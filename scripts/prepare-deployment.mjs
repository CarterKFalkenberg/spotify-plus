// This command only prepares private inputs. The orchestrator runs external changes.
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import {
  currentHead,
  privateJson,
  readJson,
  requireCheck,
  validateDashboardEvidence,
  validateTargets,
  verifyProject,
} from "./live/config.mjs";
export function completeRuntimeKeys(keys) {
  const next = { ...keys };
  for (const name of [
    "tokenEncryptionKey",
    "annotationKey",
    "ownerBindingKey",
    "backupEncryptionKey",
  ]) {
    if (next[name] === undefined)
      next[name] = randomBytes(32).toString("base64");
    requireCheck(
      typeof next[name] === "string" &&
        Buffer.from(next[name], "base64").length === 32 &&
        Buffer.from(next[name], "base64").toString("base64") === next[name],
      "invalid_runtime_key",
    );
  }
  for (const name of ["proxySecret", "cronSecret", "bootstrapSecret"]) {
    if (next[name] === undefined)
      next[name] = randomBytes(48).toString("base64url");
    requireCheck(
      typeof next[name] === "string" && /^[A-Za-z0-9_-]{32,}$/.test(next[name]),
      "invalid_service_secret",
    );
  }
  requireCheck(
    new Set([next.proxySecret, next.cronSecret, next.bootstrapSecret]).size ===
      3,
    "distinct_service_secrets_required",
  );
  return next;
}
export function deploymentFiles(config, keys, sha, root) {
  const runtime = {
    APP_ORIGIN: config.appUrl,
    DEPLOY_SHA: sha,
    SPOTIFY_CLIENT_ID: config.spotifyClientId,
    SPOTIFY_EXPECTED_USER_ID: config.spotifyExpectedUserId,
    OWNER_BINDING_KEY: keys.ownerBindingKey,
    TOKEN_ENCRYPTION_KEY: keys.tokenEncryptionKey,
    PROXY_SECRET: keys.proxySecret,
    CRON_SECRET: keys.cronSecret,
    BOOTSTRAP_SECRET: keys.bootstrapSecret,
  };
  requireCheck(
    Object.values(runtime).every(
      (value) => typeof value === "string" && /^[^\r\n"'\\]+$/.test(value),
    ),
    "invalid_runtime_configuration",
  );
  return {
    runtime,
    workerSecrets: { PROXY_SECRET: keys.proxySecret },
    worker: {
      name: config.cloudflareWorkerName,
      account_id: config.cloudflareAccountId,
      main: resolve(root, "proxy/worker.ts"),
      compatibility_date: "2026-10-11",
      workers_dev: true,
      assets: {
        directory: resolve(root, "dist"),
        binding: "ASSETS",
        not_found_handling: "single-page-application",
        run_worker_first: [
          "/api/*",
          "/auth/*",
          "/healthz",
          "/internal/*",
          "/functions/*",
        ],
      },
      vars: {
        APP_ORIGIN: config.appUrl,
        SUPABASE_ORIGIN: `https://${config.supabaseProjectRef}.supabase.co`,
        FRONTEND_SHA: sha,
      },
      observability: { enabled: false },
    },
  };
}
export async function prepare(root) {
  const local = resolve(root, ".local");
  const config = validateTargets(readJson(resolve(local, "config.json")));
  const sha = currentHead(root);
  validateDashboardEvidence(
    readJson(resolve(local, "deployment-dashboard-evidence.json")),
    config,
    sha,
  );
  await verifyProject(config, local);
  const keyFile = resolve(local, "runtime-keys.json");
  const keys = completeRuntimeKeys(readJson(keyFile));
  privateJson(keyFile, keys);
  const directory = resolve(local, "deploy", sha);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const files = deploymentFiles(config, keys, sha, root);
  privateJson(resolve(directory, "wrangler.json"), files.worker);
  privateJson(resolve(directory, "worker-secrets.json"), files.workerSecrets);
  const envPath = resolve(directory, "supabase.env");
  writeFileSync(
    envPath,
    Object.entries(files.runtime)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  chmodSync(envPath, 0o600);
  // Generated outside Git; no credential is a shell argument. Vault SQL is an operator
  // input for a private request body, never an argument or raw command-output transcript.
  privateJson(resolve(directory, "vault-input.json"), {
    projectUrl: `https://${config.supabaseProjectRef}.supabase.co`,
    cronSecret: keys.cronSecret,
  });
  requireCheck(
    existsSync(resolve(root, "dist/index.html")) &&
      readFileSync(resolve(root, "dist/index.html"), "utf8").includes(
        `content="${sha}"`,
      ),
    "build_same_head_before_deploy",
  );
  return { prepared: true, buildSha: sha, externalChangesMade: false };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  prepare(resolve(dirname(fileURLToPath(import.meta.url)), ".."))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(
        JSON.stringify({
          prepared: false,
          blocker: error.code ?? "deployment_preparation_failed",
        }),
      );
      process.exitCode = 1;
    });
}
