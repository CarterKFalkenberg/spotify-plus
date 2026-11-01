import type { Database } from "./database.ts";
import {
  type DiagnosticEvent,
  type DiagnosticFacts,
  diagnosticReason,
} from "./diagnostics-contract.ts";
let pending = 0;
// No raw exception fields leave this classifier. Provider errors expose fixed kind enums.
export async function reportDiagnostic(
  db: Database,
  build: string,
  source: "api" | "jobs",
  event: DiagnosticEvent,
  reason: unknown,
  request: string = crypto.randomUUID(),
  facts: DiagnosticFacts = {},
  epoch?: number,
): Promise<unknown> {
  if (pending >= 2 || !Number.isSafeInteger(epoch)) return false;
  pending++;
  try {
    return await db.rpc("app_diagnostic_record", {
      p_source: source,
      p_epoch: epoch,
      p_event: event,
      p_reason: diagnosticReason(reason),
      p_build: build,
      p_request: request,
      p_document: null,
      p_playback: null,
      p_facts: facts,
    });
  } catch {
    return false;
  } finally {
    pending--;
  }
}
