import { describe, expect, it } from "vitest";
import {
  completeRuntimeKeys,
  deploymentFiles,
} from "../../scripts/prepare-deployment.mjs";
import {
  targetFingerprint,
  validateDashboardEvidence,
  validateTargets,
} from "../../scripts/live/config.mjs";
import { validateOperatorEvidence } from "../../scripts/verify-stage.mjs";
const config = {
  appUrl: "https://spotify-plus.synthetic.workers.dev",
  supabaseProjectRef: "abcdefghijklmnopqrst",
  cloudflareAccountId: "a".repeat(32),
  cloudflareWorkerName: "spotify-plus",
  spotifyClientId: "synthetic-client",
  spotifyExpectedUserId: "synthetic-owner",
  budgetMonthlyUsd: 0,
  hosting: { supabasePlan: "free", cloudflarePlan: "free" },
  authorization: { deployToConfiguredFreeHosting: true },
};
const head = "b".repeat(40),
  now = Date.parse("2026-10-11T12:00:00Z");
const dashboard = () => ({
  source: "signed-in-provider-dashboards",
  buildSha: head,
  targetFingerprint: targetFingerprint(config),
  observedAt: new Date(now).toISOString(),
  supabase: { plan: "free" },
  cloudflare: { plan: "free", cpuLimitMs: 10 },
  monthlyCostUsd: 0,
  paidAddons: false,
  quotas: {
    databaseBytes: 26e6,
    databaseLimitBytes: 500e6,
    egressBytes: 0,
    egressLimitBytes: 5e9,
    storageBytes: 0,
    storageLimitBytes: 1e9,
    workerRequestsToday: 0,
    workerDailyRequestLimit: 100000,
  },
});
describe("deployment proof boundaries", () => {
  it("never substitutes configured plans for recent target-specific dashboard observations", () => {
    expect(validateTargets(config)).toBe(config);
    expect(() => validateDashboardEvidence(config, config, head, now)).toThrow(
      "fresh_dashboard",
    );
    expect(() =>
      validateDashboardEvidence(dashboard(), config, head, now),
    ).not.toThrow();
    for (const changed of [
      { buildSha: "c".repeat(40) },
      { targetFingerprint: "other" },
      { observedAt: new Date(now - 16 * 60000).toISOString() },
      { observedAt: new Date(now + 1000).toISOString() },
      { source: "configuration-file" },
    ])
      expect(() =>
        validateDashboardEvidence(
          { ...dashboard(), ...changed },
          config,
          head,
          now,
        ),
      ).toThrow();
  });
  it("refuses paid plans, exhausted quotas, arbitrary origins and unapproved targets", () => {
    expect(() =>
      validateDashboardEvidence(
        { ...dashboard(), monthlyCostUsd: 1 },
        config,
        head,
        now,
      ),
    ).toThrow("actual_free");
    const full = dashboard();
    full.quotas.databaseBytes = full.quotas.databaseLimitBytes;
    expect(() => validateDashboardEvidence(full, config, head, now)).toThrow(
      "quota",
    );
    for (const changed of [
      { budgetMonthlyUsd: 1 },
      { appUrl: "https://evil.test" },
      { appUrl: config.appUrl + "/path" },
      { authorization: { deployToConfiguredFreeHosting: false } },
    ])
      expect(() => validateTargets({ ...config, ...changed })).toThrow();
  });
  it("preserves existing keys and creates distinct service secrets without widening worker access", () => {
    const original = {
      tokenEncryptionKey: Buffer.alloc(32, 1).toString("base64"),
      sessionSecret: "preserved-old-key",
    };
    const keys = completeRuntimeKeys(original);
    expect(keys.tokenEncryptionKey).toBe(original.tokenEncryptionKey);
    expect(keys.sessionSecret).toBe(original.sessionSecret);
    expect(original).not.toHaveProperty("proxySecret");
    expect(
      new Set([keys.proxySecret, keys.cronSecret, keys.bootstrapSecret]).size,
    ).toBe(3);
    expect(completeRuntimeKeys(keys)).toEqual(keys);
    expect(() =>
      completeRuntimeKeys({ ...keys, ownerBindingKey: "broken" }),
    ).toThrow("invalid_runtime_key");
    const files = deploymentFiles(config, keys, head, "/synthetic/repo");
    expect(files.workerSecrets).toEqual({ PROXY_SECRET: keys.proxySecret });
    expect(Object.keys(files.worker.vars).sort()).toEqual([
      "APP_ORIGIN",
      "FRONTEND_SHA",
      "SUPABASE_ORIGIN",
    ]);
    expect(Object.keys(files.runtime)).not.toContain("SUPABASE_ACCESS_TOKEN");
    expect(Object.keys(files.runtime)).not.toContain("SPOTIFY_REFRESH_TOKEN");
    expect(files.worker.observability.enabled).toBe(false);
  });
  it("requires fresh actual CPU samples and explicit browser inventory, not elapsed time", () => {
    const evidence = {
      buildSha: head,
      targetFingerprint: targetFingerprint(config),
      closedBrowsers: {
        source: "operator-browser-inventory",
        observedAt: new Date(now).toISOString(),
        appTabs: 0,
      },
      cpu: {
        source: "cloudflare-workers-request-traces",
        observedAt: new Date(now).toISOString(),
        sampleCount: 20,
        failedRequests: 0,
        maxCpuMs: 4,
      },
    };
    expect(() =>
      validateOperatorEvidence(evidence, config, head, now),
    ).not.toThrow();
    expect(() =>
      validateOperatorEvidence(
        { ...evidence, cpu: { ...evidence.cpu, maxCpuMs: 11 } },
        config,
        head,
        now,
      ),
    ).toThrow();
    expect(() =>
      validateOperatorEvidence(
        {
          ...evidence,
          cpu: { ...evidence.cpu, source: "unit-test-wall-time" },
        },
        config,
        head,
        now,
      ),
    ).toThrow();
    expect(() =>
      validateOperatorEvidence(
        {
          ...evidence,
          closedBrowsers: { ...evidence.closedBrowsers, appTabs: 1 },
        },
        config,
        head,
        now,
      ),
    ).toThrow();
  });
});
