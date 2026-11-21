import type { TrackDTO } from "./contracts.ts";

export type ReviewMembership =
  | "unknown"
  | "checking"
  | "present"
  | "absent"
  | "unavailable";
export interface ReviewDestinationDTO {
  id: string;
  name: string;
  artworkUrl: string | null;
  spotifyUrl: string;
  configured: boolean;
  available: boolean;
  membership: ReviewMembership;
  errorCode: string | null;
}
export type ReviewOperationStatus =
  | "queued"
  | "adding"
  | "unliking"
  | "completed"
  | "undoing"
  | "undone"
  | "needs_attention";
export interface ReviewOperationDTO {
  id: string;
  trackKey: string;
  kind: "done" | "discard";
  status: ReviewOperationStatus;
  errorCode: string | null;
  completedDestinations: number;
  totalDestinations: number;
  reversalIncomplete: boolean;
}
export interface ReviewDraftDTO {
  trackKey: string;
  destinationIds: string[];
  revision: string;
}
export interface ReviewDTO {
  sessionId: string;
  /** Changes only for user intents/completions, never for GET polling. */
  revision: string;
  remaining: number;
  skipped: number;
  current: TrackDTO | null;
  destinations: ReviewDestinationDTO[];
  draft: ReviewDraftDTO | null;
  operation: ReviewOperationDTO | null;
  undo: ReviewOperationDTO | null;
  syncStatus: "pending" | "ready" | "unavailable";
  discoveryStatus: "pending" | "ready" | "unavailable";
}
export interface ReviewDestinationsDTO {
  revision: string;
  items: ReviewDestinationDTO[];
  discoveryStatus: "pending" | "ready" | "unavailable";
}
export type ReviewCommand =
  | "destinations"
  | "draft"
  | "session"
  | "skip"
  | "done"
  | "discard"
  | "undo"
  | "retry";
export interface ReviewInput {
  revision: string;
  destinationIds?: string[];
  trackKey?: string;
  requestId?: string;
  operationId?: string;
  confirmation?: true;
}
