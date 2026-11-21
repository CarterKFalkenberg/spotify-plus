// Final bounded operator attribution cases. Completion is not runtime acceptance.
import {
  reviewProofFailure,
  type ReviewProofInput,
  runReviewProof,
} from "./review-proof.ts";

const limitations = {
  originalProofPassed: false,
  readVersionConsistencyVerified: false,
  historicalSnapshotGuarantee: false,
} as const;

export async function runReviewAttributionProof(input: ReviewProofInput) {
  return {
    ...await runReviewProof(input, "ack_attribution"),
    ...limitations,
  };
}

if (import.meta.main) {
  try {
    const input = JSON.parse(
      await new Response(Deno.stdin.readable).text(),
    ) as ReviewProofInput;
    console.log(JSON.stringify({
      passed: true,
      ...await runReviewAttributionProof(input),
    }));
  } catch (error) {
    console.log(
      JSON.stringify({ ...reviewProofFailure(error), ...limitations }),
    );
    Deno.exitCode = 1;
  }
}
