import type { Database } from "./database.ts";
export function assert(
  value: unknown,
  message = "assertion failed",
): asserts value {
  if (!value) throw new Error(message);
}
export function equal(actual: unknown, expected: unknown): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), "values differ");
}
export async function rejects(
  action: () => Promise<unknown>,
  predicate: (error: unknown) => boolean = () => true,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    assert(predicate(error), "unexpected error class");
    return;
  }
  throw new Error("expected rejection");
}
export function database(
  handler: (
    name: string,
    args: Record<string, unknown>,
  ) => unknown | Promise<unknown>,
): Database {
  return {
    rpc: async <T>(name: string, args: Record<string, unknown> = {}) =>
      await handler(name, args) as T,
  };
}
export const TEST_KEY = btoa("k".repeat(32));

export function mockResponse(
  body?: BodyInit | null,
  init?: ResponseInit,
): Promise<Response> {
  return Promise.resolve(new Response(body, init));
}
