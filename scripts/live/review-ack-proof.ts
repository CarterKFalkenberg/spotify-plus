// Separate operator-only ACK-targeted removal observation; no runtime gate changes.
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

export async function runReviewAckProof(input: ReviewProofInput) {
  return {
    ...await runReviewProof(input, "ack_targeted_removal"),
    ...limitations,
  };
}

if (import.meta.main) {
  try {
    const input = JSON.parse(
      await new Response(Deno.stdin.readable).text(),
    ) as ReviewProofInput;
    console.log(
      JSON.stringify({ passed: true, ...await runReviewAckProof(input) }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({ ...reviewProofFailure(error), ...limitations }),
    );
    Deno.exitCode = 1;
  }
}
