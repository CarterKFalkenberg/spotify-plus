// Provider payloads stay inside this module. Only fixed statuses reach React.
export interface PlaybackState {
  paused: boolean;
  position: number;
  duration: number;
  track_window: { current_track: { uri: string } };
}
export interface WebPlayer {
  addListener(event: string, listener: (value: any) => void): boolean;
  connect(): Promise<boolean>;
  disconnect(): void;
  activateElement(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  getCurrentState(): Promise<PlaybackState | null>;
}
export interface SpotifySDK {
  Player: new (options: {
    name: string;
    getOAuthToken: (callback: (token: string) => void) => void;
    volume: number;
  }) => WebPlayer;
}
declare global {
  interface Window {
    Spotify?: SpotifySDK;
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}
let loading: Promise<SpotifySDK> | undefined;
export function loadSDK(): Promise<SpotifySDK> {
  if (window.Spotify) return Promise.resolve(window.Spotify);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const timeout = setTimeout(fail, 15000);
    function fail() {
      clearTimeout(timeout);
      script.remove();
      loading = undefined;
      reject(new Error("sdk_unavailable"));
    }
    window.onSpotifyWebPlaybackSDKReady = () => {
      clearTimeout(timeout);
      if (window.Spotify) resolve(window.Spotify);
      else fail();
    };
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.onerror = fail;
    document.head.append(script);
  });
  return loading;
}
export type ListenStatus =
  | "idle"
  | "loading"
  | "ready"
  | "starting"
  | "snippet"
  | "pausing"
  | "paused"
  | "more"
  | "ended"
  | "error";
export interface ListenView {
  status: ListenStatus;
  message: string;
  enable: boolean;
}
interface Transport {
  token(signal: AbortSignal): Promise<string>;
  start(
    trackKey: string,
    deviceId: string,
    signal: AbortSignal,
  ): Promise<{ uri: string; positionMs: number; durationMs: number }>;
}
// One controller owns one SDK device and one queue song. Destroying it invalidates
// every promise/listener before disconnecting, including a late accepted start.
export class QueuePlayer {
  private player: WebPlayer | undefined;
  private dead = false;
  private abort = new AbortController();
  private device: string | undefined;
  private uri: string | undefined;
  private status: ListenStatus = "idle";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private connectionDeadline: ReturnType<typeof setTimeout> | undefined;
  private polling: ReturnType<typeof setInterval> | undefined;
  private remaining = 20000;
  private audibleSince: number | undefined;
  private continuous = false;
  private missingSince: number | undefined;
  private accepted = false;
  private operation = 0;
  private notificationRevision = 0;
  private pollingBusy: { operation: number; revision: number } | undefined;
  constructor(
    private readonly trackKey: string,
    private readonly transport: Transport,
    private readonly changed: (view: ListenView) => void,
    private readonly now: () => number = Date.now,
  ) {}
  private emit(status: ListenStatus, message = "", enable = false) {
    if (this.dead) return;
    this.status = status;
    this.changed({ status, message, enable });
  }
  private clearAudioTimer() {
    clearTimeout(this.timer);
    if (this.audibleSince !== undefined)
      this.remaining = Math.max(
        0,
        this.remaining - (this.now() - this.audibleSince),
      );
    this.audibleSince = undefined;
  }
  private stopDevice() {
    const player = this.player;
    if (!player) return;
    // pause is scoped to this local SDK device; no remote pause endpoint exists.
    try {
      void player.pause().catch(() => {});
    } catch {
      /* SDK failure must not expose a provider exception. */
    }
    try {
      player.disconnect();
    } catch {
      /* The controller is already invalidated. */
    }
  }
  destroy() {
    if (this.dead) return;
    this.dead = true;
    this.operation++;
    this.abort.abort();
    this.clearAudioTimer();
    clearTimeout(this.deadline);
    clearTimeout(this.connectionDeadline);
    clearInterval(this.polling);
    this.stopDevice();
  }
  private fail(message: string, enable = false) {
    if (this.dead || this.status === "error") return;
    this.emit("error", message, enable);
    this.clearAudioTimer();
    clearTimeout(this.deadline);
    clearTimeout(this.connectionDeadline);
    clearInterval(this.polling);
    this.accepted = false;
    this.operation++;
    this.abort.abort();
    this.stopDevice();
  }
  private failure(error: unknown) {
    const code =
      error && typeof error === "object" && "code" in error ? error.code : "";
    let marker: unknown;
    try {
      if (error instanceof Error)
        marker = Object.getOwnPropertyDescriptor(error, "message")?.value;
    } catch {
      /* Unknown errors never supply display text. */
    }
    const setupMessage =
      marker === "device_timeout"
        ? "Spotify did not make this browser player ready in time. Try again or open Spotify."
        : marker === "connect_timeout"
          ? "The connection to Spotify timed out. Try again or open Spotify."
          : marker === "connect_failed"
            ? "Spotify could not connect this browser player. Try again or open Spotify."
            : marker === "token_timeout"
              ? "Spotify authorization took too long to load. Try again."
              : marker === "device_invalid"
                ? "Spotify could not identify this browser player. Try again or open Spotify."
                : "Playback could not be confirmed. Try again or open Spotify.";
    this.fail(
      code === "playback_required"
        ? "Enable playback to listen in this page."
        : code === "playback_cooldown"
          ? "Spotify is busy. Wait a moment, then try again."
          : code === "reconnect" || code === "unauthorized"
            ? "Reconnect Spotify to listen here."
            : code === "track_unavailable"
              ? "This song is unavailable for playback."
              : setupMessage,
      code === "playback_required",
    );
  }
  private state(state: PlaybackState | null) {
    if (this.dead || !this.accepted || this.status === "error") return;
    if (!state) {
      if (["snippet", "more", "pausing"].includes(this.status)) {
        this.missingSince ??= this.now();
        if (this.now() - this.missingSince >= 2000)
          this.fail("The player disconnected. Try again.");
      }
      return;
    }
    this.missingSince = undefined;
    if (
      typeof state.paused !== "boolean" ||
      !Number.isSafeInteger(state.position) ||
      state.position < 0 ||
      !Number.isSafeInteger(state.duration) ||
      state.duration <= 0 ||
      state.duration > 86400000
    ) {
      this.fail("The player is unavailable. Try again or open Spotify.");
      return;
    }
    if (state.track_window?.current_track?.uri !== this.uri) {
      this.fail("Playback stopped because the song changed.");
      return;
    }
    if (state.paused) {
      this.clearAudioTimer();
      if (
        this.status === "snippet" ||
        this.status === "more" ||
        this.status === "pausing"
      ) {
        clearTimeout(this.deadline);
        this.emit(state.position === 0 ? "ended" : "paused");
      }
      return;
    }
    if (!["starting", "snippet", "more"].includes(this.status)) {
      // Late unsolicited playback after a manual/automatic pause is never resumed.
      void this.pause();
      return;
    }
    clearTimeout(this.deadline);
    this.emit(this.continuous ? "more" : "snippet");
    if (!this.continuous && this.audibleSince === undefined) {
      this.audibleSince = this.now();
      this.timer = setTimeout(() => {
        void this.pause();
      }, this.remaining);
    }
  }
  private async readCurrentState(operation: number) {
    const revision = this.notificationRevision;
    try {
      const state = await this.player?.getCurrentState();
      if (
        !this.dead &&
        operation === this.operation &&
        revision === this.notificationRevision
      )
        this.state(state ?? null);
    } catch (error) {
      if (
        !this.dead &&
        operation === this.operation &&
        revision === this.notificationRevision
      )
        throw error;
    }
  }
  private watch() {
    if (this.polling) return;
    this.polling = setInterval(() => {
      if (this.dead) return;
      const ticket = {
        operation: this.operation,
        revision: this.notificationRevision,
      };
      if (
        this.pollingBusy?.operation === ticket.operation &&
        this.pollingBusy.revision === ticket.revision
      )
        return;
      this.pollingBusy = ticket;
      const current = () =>
        !this.dead &&
        this.accepted &&
        this.status !== "error" &&
        ticket.operation === this.operation &&
        ticket.revision === this.notificationRevision;
      const timeout = setTimeout(() => {
        if (current()) this.fail("The player disconnected. Try again.");
      }, 2000);
      const player = this.player;
      void Promise.resolve()
        .then(() => player?.getCurrentState())
        .then((state) => {
          if (current()) this.state(state ?? null);
        })
        .catch(() => {
          if (current()) this.fail("The player disconnected. Try again.");
        })
        .finally(() => {
          clearTimeout(timeout);
          if (this.pollingBusy === ticket) this.pollingBusy = undefined;
        });
    }, 500);
  }
  async play() {
    if (
      this.dead ||
      ["loading", "starting", "snippet", "more", "pausing", "error"].includes(
        this.status,
      )
    )
      return;
    const operation = ++this.operation;
    const ended = this.status === "ended";
    let activated: Promise<void> | undefined;
    let initialProof: Promise<void> | undefined;
    try {
      if (!this.player) {
        this.emit("loading");
        // A warmed SDK can activate synchronously inside this click. On cold
        // first use, verify the grant before loading third-party code, then ask
        // for a fresh explicit Play gesture when the player is ready.
        const warm = window.Spotify;
        let initialToken: string | undefined;
        let sdk: SpotifySDK;
        if (warm) sdk = warm;
        else {
          initialToken = await this.transport.token(this.abort.signal);
          if (this.dead) return;
          sdk = await loadSDK();
          if (this.dead) return;
        }
        let grantTimer: ReturnType<typeof setTimeout> | undefined;
        let firstGrant = warm
          ? Promise.race([
              this.transport.token(this.abort.signal),
              new Promise<string>((_, reject) => {
                grantTimer = setTimeout(
                  () => reject(new Error("token_timeout")),
                  12000,
                );
              }),
            ]).finally(() => clearTimeout(grantTimer))
          : undefined;
        const verifiedGrant = firstGrant?.then(() => {});
        initialProof = verifiedGrant;
        let proofPending = !!verifiedGrant;
        let pendingSDKFailure: string | undefined;
        const sdkFailure = (message: string) => {
          if (proofPending) {
            pendingSDKFailure ??= message;
            return;
          }
          this.fail(message);
        };
        // Scope/auth recovery takes precedence over SDK failures during initial
        // setup, even when connect rejects before its token callback runs.
        void verifiedGrant?.then(
          () => {
            proofPending = false;
            if (pendingSDKFailure) this.fail(pendingSDKFailure);
          },
          (error: unknown) => {
            proofPending = false;
            this.failure(error);
          },
        );
        const player = new sdk.Player({
          name: "Song Tagger",
          volume: 0.7,
          getOAuthToken: (callback) => {
            if (this.dead || this.status === "error") return;
            if (initialToken) {
              const token = initialToken;
              initialToken = undefined;
              callback(token);
              return;
            }
            const grant = firstGrant ?? this.transport.token(this.abort.signal);
            firstGrant = undefined;
            void grant
              .then((token) => {
                if (!this.dead && this.status !== "error") callback(token);
              })
              .catch((e) => this.failure(e));
          },
        });
        this.player = player;
        const ready = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("device_timeout")),
            12000,
          );
          this.deadline = timeout;
          player.addListener("ready", (value: { device_id: string }) => {
            if (this.dead || this.status === "error") {
              player.disconnect();
              return;
            }
            if (
              !value ||
              typeof value.device_id !== "string" ||
              !/^[A-Za-z0-9_-]{20,128}$/.test(value.device_id)
            ) {
              clearTimeout(timeout);
              reject(new Error("device_invalid"));
              return;
            }
            this.device = value.device_id;
            clearTimeout(timeout);
            resolve();
          });
          player.addListener("not_ready", () => {
            clearTimeout(timeout);
            reject(new Error("device_disconnected"));
            sdkFailure("The player disconnected. Try again.");
          });
        });
        player.addListener(
          "player_state_changed",
          (state: PlaybackState | null) => {
            this.notificationRevision++;
            this.state(state);
          },
        );
        for (const event of [
          "initialization_error",
          "authentication_error",
          "account_error",
          "playback_error",
          "autoplay_failed",
        ])
          player.addListener(event, (payload: unknown) => {
            let permissionsRejected = false;
            if (
              event === "authentication_error" &&
              payload !== null &&
              typeof payload === "object" &&
              !Array.isArray(payload)
            ) {
              try {
                const message = Object.getOwnPropertyDescriptor(
                  payload,
                  "message",
                );
                permissionsRejected =
                  !!message &&
                  "value" in message &&
                  message.value === "Invalid token scopes.";
              } catch {
                /* Untrusted SDK payloads cannot supply display text. */
              }
            }
            sdkFailure(
              event === "initialization_error"
                ? "Protected audio could not initialize in this browser. Try another supported browser or open Spotify."
                : event === "authentication_error"
                  ? permissionsRejected
                    ? "Spotify rejected the permissions for webpage playback. You can keep tagging or open Spotify."
                    : "Spotify could not authenticate the player. Reconnect Spotify or try again."
                  : event === "playback_error"
                    ? "Spotify could not play this song. Try again or open Spotify."
                    : event === "account_error"
                      ? "Spotify Premium is required to listen here."
                      : event === "autoplay_failed"
                        ? "Your browser blocked audio. Try Play again."
                        : "The player is unavailable. Try again or open Spotify.",
            );
          });
        if (warm) {
          activated = player.activateElement();
          void activated.catch(() =>
            sdkFailure("Your browser blocked audio. Try Play again."),
          );
        }
        // Catch ready immediately, even when connect rejects before the SDK event.
        await Promise.all([
          ready,
          verifiedGrant,
          Promise.race([
            player.connect(),
            new Promise<boolean>((_, reject) => {
              this.connectionDeadline = setTimeout(
                () => reject(new Error("connect_timeout")),
                12000,
              );
            }),
          ])
            .then((connected) => {
              if (!connected) throw new Error("connect_failed");
            })
            .finally(() => clearTimeout(this.connectionDeadline)),
        ]);
        if (this.dead || operation !== this.operation) return;
        if (!warm) {
          this.emit("ready", "Player ready. Press Play to allow audio.");
          return;
        }
      }
      // Called synchronously from the explicit click, before the first await.
      const activation = activated ?? this.player.activateElement();
      this.emit("starting");
      this.deadline = setTimeout(
        () => this.fail("Playback did not start. Try again or open Spotify."),
        12000,
      );
      await activation;
      if (this.dead || operation !== this.operation) return;
      if (this.accepted && !ended) {
        this.continuous = true;
        await this.player.resume();
      } else {
        const result = await this.transport.start(
          this.trackKey,
          this.device!,
          this.abort.signal,
        );
        if (this.dead || operation !== this.operation) return;
        this.uri = result.uri;
        this.accepted = true;
        this.continuous = false;
        this.remaining = 20000;
      }
      if (this.dead || operation !== this.operation) return;
      this.watch();
      await this.readCurrentState(operation);
    } catch (e) {
      // A synchronous constructor/connect failure must also wait for bounded
      // initial authorization proof rather than hiding an actionable consent result.
      if (initialProof) {
        try {
          await initialProof;
        } catch (grantError) {
          e = grantError;
        }
      }
      if (!this.dead && operation === this.operation) this.failure(e);
    }
  }
  async pause() {
    if (this.dead || !this.player || this.status === "pausing") return;
    const operation = ++this.operation;
    this.clearAudioTimer();
    clearTimeout(this.deadline);
    this.emit("pausing");
    this.deadline = setTimeout(
      () =>
        this.fail("Pause could not be confirmed. The player was disconnected."),
      2000,
    );
    try {
      await this.player.pause();
      if (this.dead || operation !== this.operation) return;
      await this.readCurrentState(operation);
    } catch {
      if (!this.dead && operation === this.operation)
        this.fail("Pause could not be confirmed. The player was disconnected.");
    }
  }
}
