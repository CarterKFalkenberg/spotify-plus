import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { resolve, basename } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
export function requireCheck(condition, code) {
  if (!condition) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
}
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const name = basename(path)
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-z0-9]/gi, "_")
      .toLowerCase();
    requireCheck(
      false,
      `${error.code === "ENOENT" ? "missing" : "invalid"}_${name}`,
    );
  }
}
export function privateJson(path, value) {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}
export function targetFingerprint(config) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        config.supabaseProjectRef,
        config.cloudflareAccountId,
        config.cloudflareWorkerName,
        config.appUrl,
      ]),
    )
    .digest("hex");
}
export function validateTargets(config) {
  requireCheck(
    config.budgetMonthlyUsd === 0 &&
      config.hosting?.supabasePlan === "free" &&
      config.hosting?.cloudflarePlan === "free",
    "free_hosting_configuration_required",
  );
  requireCheck(
    config.authorization?.deployToConfiguredFreeHosting === true,
    "deployment_authorization_required",
  );
  requireCheck(
    /^[a-z0-9]{20}$/.test(config.supabaseProjectRef),
    "invalid_supabase_target",
  );
  requireCheck(
    /^[a-f0-9]{32}$/.test(config.cloudflareAccountId) &&
      /^[a-z0-9][a-z0-9-]{0,62}$/.test(config.cloudflareWorkerName),
    "invalid_cloudflare_target",
  );
  const url = new URL(config.appUrl);
  requireCheck(
    url.origin === config.appUrl &&
      url.protocol === "https:" &&
      url.hostname.endsWith(".workers.dev") &&
      !url.username &&
      !url.password,
    "invalid_app_target",
  );
  return config;
}
export function currentHead(root) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  requireCheck(/^[a-f0-9]{40}$/.test(head), "invalid_git_head");
  requireCheck(
    execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).trim() === "",
    "clean_worktree_required",
  );
  return head;
}
export function validateDashboardEvidence(
  value,
  config,
  head,
  now = Date.now(),
) {
  const time = Date.parse(value?.observedAt);
  requireCheck(
    value?.source === "signed-in-provider-dashboards" &&
      value.buildSha === head &&
      value.targetFingerprint === targetFingerprint(config) &&
      Number.isFinite(time) &&
      time <= now &&
      now - time <= 15 * 60_000,
    "fresh_dashboard_plan_evidence_required",
  );
  requireCheck(
    value.supabase?.plan === "free" &&
      value.cloudflare?.plan === "free" &&
      value.monthlyCostUsd === 0 &&
      value.paidAddons === false,
    "actual_free_plans_required",
  );
  const quotas = value.quotas;
  requireCheck(
    quotas &&
      [
        "databaseBytes",
        "databaseLimitBytes",
        "egressBytes",
        "egressLimitBytes",
        "storageBytes",
        "storageLimitBytes",
        "workerRequestsToday",
        "workerDailyRequestLimit",
      ].every((k) => Number.isFinite(quotas[k]) && quotas[k] >= 0),
    "actual_quota_evidence_required",
  );
  requireCheck(
    quotas.databaseBytes < quotas.databaseLimitBytes &&
      quotas.egressBytes < quotas.egressLimitBytes &&
      quotas.storageBytes < quotas.storageLimitBytes &&
      quotas.workerRequestsToday < quotas.workerDailyRequestLimit &&
      value.cloudflare.cpuLimitMs === 10,
    "free_quota_capacity_required",
  );
  return value;
}
export async function privateFetch(url, init = {}) {
  try {
    return await fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    requireCheck(false, "provider_request_failed");
  }
}
export async function verifyProject(config, local) {
  const token = readFileSync(
    resolve(local, "supabase-access-token"),
    "utf8",
  ).trim();
  const response = await privateFetch(
    `https://api.supabase.com/v1/projects/${config.supabaseProjectRef}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  requireCheck(response.ok, "configured_project_access_failed");
  let project;
  try {
    project = await response.json();
  } catch {
    requireCheck(false, "project_schema_invalid");
  }
  requireCheck(
    project.id === config.supabaseProjectRef &&
      project.status === "ACTIVE_HEALTHY",
    "configured_project_not_healthy",
  );
  return { configuredProjectMatches: true, projectHealthy: true };
}
