export function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error("missing_runtime_configuration");
  return value;
}
export function runtimeConfig() {
  const origin = requiredEnv("APP_ORIGIN");
  if (new URL(origin).origin !== origin || !origin.startsWith("https://")) {
    throw new Error("invalid_origin_configuration");
  }
  const sha = requiredEnv("DEPLOY_SHA");
  if (!/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error("invalid_revision_configuration");
  }
  const proxySecret = requiredEnv("PROXY_SECRET"),
    cronSecret = requiredEnv("CRON_SECRET"),
    bootstrapSecret = requiredEnv("BOOTSTRAP_SECRET");
  if (
    [proxySecret, cronSecret, bootstrapSecret].some((s) => s.length < 32) ||
    new Set([proxySecret, cronSecret, bootstrapSecret]).size !== 3
  ) throw new Error("invalid_service_auth_configuration");
  return {
    origin,
    sha,
    proxySecret,
    cronSecret,
    bootstrapSecret,
    clientId: requiredEnv("SPOTIFY_CLIENT_ID"),
    expectedUserId: requiredEnv("SPOTIFY_EXPECTED_USER_ID"),
    ownerBindingKey: requiredEnv("OWNER_BINDING_KEY"),
    tokenEncryptionKey: requiredEnv("TOKEN_ENCRYPTION_KEY"),
    annotationKey: requiredEnv("ANNOTATION_KEY"),
    backupEncryptionKey: requiredEnv("BACKUP_ENCRYPTION_KEY"),
    supabaseUrl: requiredEnv("SUPABASE_URL"),
    serviceKey: requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
  };
}
