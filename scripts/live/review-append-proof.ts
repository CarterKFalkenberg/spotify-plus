// Separate operator observation: one append to an empty disposable fixture.
import {
  reviewProofFailure,
  type ReviewProofInput,
  runReviewProof,
} from "./review-proof.ts";

export function runReviewAppendProof(input: ReviewProofInput) {
  return runReviewProof(input, "append_ack");
}

if (import.meta.main) {
  try {
    const input = JSON.parse(
      await new Response(Deno.stdin.readable).text(),
    ) as ReviewProofInput;
    console.log(JSON.stringify({
      passed: true,
      ...await runReviewAppendProof(input),
    }));
  } catch (error) {
    console.log(JSON.stringify(reviewProofFailure(error)));
    Deno.exitCode = 1;
  }
}
