const encoder = new TextEncoder();
const decoder = new TextDecoder();
function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
export function opaqueToken(): string {
  return base64(crypto.getRandomValues(new Uint8Array(32))).replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ).replaceAll("=", "");
}
export async function sha256(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
export async function secretMatches(actual: string | null, expected: string): Promise<boolean> {
  if (actual === null || actual.length > 512 || expected.length < 32) return false;
  const [a, b] = await Promise.all([sha256(actual), sha256(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
export class SecretBox {
  private readonly key: Promise<CryptoKey>;
  constructor(encodedKey: string) {
    const bytes = unbase64(encodedKey);
    if (bytes.length !== 32) throw new Error("invalid_encryption_configuration");
    this.key = crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  async encrypt(value: unknown, context: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
      await this.key,
      encoder.encode(JSON.stringify(value)),
    );
    return `v1.${base64(iv)}.${base64(new Uint8Array(ciphertext))}`;
  }
  async decrypt<T>(value: string, context: string): Promise<T> {
    try {
      const [version, iv, data, ...extra] = value.split(".");
      if (version !== "v1" || extra.length) throw new Error();
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: unbase64(iv), additionalData: encoder.encode(context) },
        await this.key,
        unbase64(data),
      );
      return JSON.parse(decoder.decode(plaintext));
    } catch {
      throw new Error("invalid_encrypted_record");
    }
  }
}
export async function ownerFingerprint(accountId: string, bindingKey: string): Promise<string> {
  const bytes = unbase64(bindingKey);
  if (bytes.length !== 32) throw new Error("invalid_binding_configuration");
  const key = await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`spotify-plus:owner:v1:${accountId}`),
  );
  return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, "0")).join("");
}
