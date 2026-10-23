import { ApiError } from "./api";

// Provider payloads stay inside this module. Only fixed statuses reach React.
export interface PlaybackState {
  paused: boolean;
  position: number;
  duration: number;
  track_window: { current_track: { uri: string } };
}
export interface WebPlayer {
  addListener(event: string, listener: (value: any) => void): boolean;
  removeListener(event: string, listener?: (value: any) => void): boolean;
  connect(): Promise<boolean>;
  disconnect(): void | Promise<void>;
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
// The SDK shares one iframe across Player constructors. Reinitializing it replaces
// its client while retaining its original streamer, so reuse one Player/document.
// A lease keeps each queue controller's callbacks and credentials exclusive.
interface PlayerOptions {
  name: string;
  getOAuthToken: (callback: (token: string) => void) => void;
  volume: number;
}
interface SDKHolder {
  player: WebPlayer;
  owner?: WebPlayer | undefined;
  token?: PlayerOptions["getOAuthToken"] | undefined;
  disconnected: Promise<void>;
  unsafe?: boolean;
}
const players = new WeakMap<Window, SDKHolder>();
function ownPlayer(sdk: SpotifySDK, options: PlayerOptions): WebPlayer {
  let holder = players.get(window);
  if (!holder) {
    const created: SDKHolder = {
      player: undefined as unknown as WebPlayer,
      disconnected: Promise.resolve(),
    };
    created.player = new sdk.Player({
      ...options,
      getOAuthToken: (callback) => {
        const owner = created.owner;
        created.token?.((token) => {
          if (created.owner === owner) callback(token);
        });
      },
    });
    players.set(window, created);
    holder = created;
  }
  if (holder.unsafe) throw new Error("playback_retired");
  holder.owner?.disconnect();
  const shared = holder;
  const listeners: Array<[string, (value: any) => void]> = [];
  let connecting = false;
  const current = () => shared.owner === lease;
  const lease: WebPlayer = {
    addListener(event, listener) {
      if (!current()) return false;
      const guarded = (value: any) => {
        if (!current()) return;
        // Disconnect events from the shared iframe can arrive after the next
        // owner has attached listeners but before its connect is dispatched.
        if (
          !connecting &&
          ["ready", "not_ready", "player_state_changed"].includes(event)
        )
          return;
        listener(value);
      };
      listeners.push([event, guarded]);
      return shared.player.addListener(event, guarded);
    },
    removeListener(event) {
      if (!current()) return false;
      for (const [name, listener] of listeners)
        if (name === event) shared.player.removeListener(name, listener);
      return true;
    },
    async connect() {
      await shared.disconnected;
      if (!current()) return false;
      connecting = true;
      return shared.player.connect();
    },
    disconnect() {
      if (!current()) return;
      shared.owner = undefined;
      shared.token = undefined;
      for (const [event, listener] of listeners) {
        try {
          shared.player.removeListener(event, listener);
        } catch {
          /* Ownership guards still fence callbacks; stopping must proceed. */
        }
      }
      listeners.length = 0;
      // Dispatch both promptly, but drain both before another lease connects.
      // A delayed old pause must never arrive after a new song has started.
      let paused: Promise<void>;
      try {
        paused = Promise.resolve(shared.player.pause());
      } catch {
        paused = Promise.reject(new Error("connect_failed"));
      }
      // Public API documents void; current SDK returns its dispatch promise.
      // The next controller's existing deadline bounds this entire barrier.
      let disconnected: Promise<void>;
      try {
        disconnected = Promise.resolve(shared.player.disconnect());
      } catch {
        disconnected = Promise.reject(new Error("connect_failed"));
      }
      const previous = shared.disconnected;
      shared.disconnected = Promise.all([previous, paused, disconnected]).then(
        () => {},
        () => {
          shared.unsafe = true;
          throw new Error("connect_failed");
        },
      );
      // A rejected teardown must prevent reconnect, but release itself has no
      // awaiting caller. Keep the rejection handled until the next connect.
      void shared.disconnected.catch(() => {});
      return shared.disconnected;
    },
    activateElement: () =>
      current() ? shared.player.activateElement() : Promise.resolve(),
    pause: () => (current() ? shared.player.pause() : Promise.resolve()),
    resume: () => (current() ? shared.player.resume() : Promise.resolve()),
    getCurrentState: () =>
      current() ? shared.player.getCurrentState() : Promise.resolve(null),
  };
  shared.owner = lease;
  shared.token = options.getOAuthToken;
  return lease;
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
// One active queue session owns the connection; song operations have a separate
// generation. Only a confirmed quiet handoff can reuse its warmed device.
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
  private awaitingProof = false;
  private expectedPosition = 0;
  private startedAt = 0;
  private operation = 0;
  private notificationRevision = 0;
  private startPending = false;
  private commandPending = 0;
  private handoff: Promise<void> | undefined;
  private pauseConfirmation: { cancel(): void } | undefined;
  private preparation: Promise<void> | undefined;
  private pollingBusy: { operation: number; revision: number } | undefined;
  constructor(
    private trackKey: string,
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
    try {
      player.disconnect();
    } catch {
      /* The controller is already invalidated. */
    }
  }
  private retire() {
    const holder = players.get(window);
    if (holder) holder.unsafe = true;
  }
  private invalidateWrites() {
    // Aborting fetch only cancels our wait: the server/Spotify may still finish.
    // An HTTP acknowledgement without fresh SDK playing proof is unresolved too.
    // Never reconnect this document's shared device after either outcome.
    if (this.startPending || this.commandPending || this.awaitingProof)
      this.retire();
  }
  prepare(): Promise<void> {
    if (!this.preparation) this.preparation = this.play(true);
    return this.preparation;
  }
  async setTrack(trackKey: string): Promise<void> {
    if (this.dead || this.trackKey === trackKey) return;
    this.trackKey = trackKey;
    if (
      this.startPending ||
      this.awaitingProof ||
      (this.commandPending && !this.handoff)
    ) {
      this.retire();
      this.fail(
        "Playback could not be stopped safely. Check Spotify before reloading this page.",
      );
      return;
    }
    // Several rapid arrows share the same quiet barrier. The final track key wins;
    // none of these transitions is permission to start a song.
    if (this.handoff) return this.handoff;
    if (this.status === "loading" && !this.preparation) {
      this.fail("Playback was cancelled because the song changed. Try again.");
      return;
    }
    if (!this.accepted) {
      if (this.status === "starting") {
        this.operation++;
        clearTimeout(this.deadline);
        this.emit("ready");
      }
      return;
    }
    const operation = ++this.operation;
    this.clearAudioTimer();
    clearTimeout(this.deadline);
    clearInterval(this.polling);
    this.polling = undefined;
    this.accepted = false;
    this.awaitingProof = false;
    this.uri = undefined;
    this.continuous = false;
    this.remaining = 20000;
    this.emit("pausing");
    const quiet = this.confirmPause(operation, () => this.emit("ready"));
    this.handoff = quiet;
    await quiet;
    if (this.handoff === quiet) this.handoff = undefined;
  }
  private confirmPause(
    operation: number,
    confirmed: (state: PlaybackState) => void,
  ): Promise<void> {
    const player = this.player!;
    this.commandPending++;
    return new Promise((resolve) => {
      let closed = false;
      let reading = false;
      let inFlight = 0;
      let dispatchVersion = 0;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      const retries: Array<ReturnType<typeof setTimeout>> = [];
      let latest: { paused: boolean; revision: number } | undefined;
      const current = () =>
        !closed &&
        !this.dead &&
        operation === this.operation &&
        this.player === player;
      const cancelRetries = () => retries.forEach(clearTimeout);
      const control = {
        cancel: () => {
          if (closed) return;
          closed = true;
          clearTimeout(this.deadline);
          clearTimeout(pollTimer);
          cancelRetries();
          this.commandPending--;
          if (this.pauseConfirmation === control)
            this.pauseConfirmation = undefined;
          resolve();
        },
      };
      this.pauseConfirmation = control;
      const failure = () => {
        if (!current()) return;
        this.retire();
        control.cancel();
        this.fail("Pause could not be confirmed. The player was disconnected.");
      };
      const inspect = async () => {
        if (!current() || reading) return;
        clearTimeout(pollTimer);
        reading = true;
        const revision = this.notificationRevision;
        const dispatch = dispatchVersion;
        try {
          const state = await player.getCurrentState();
          if (!current()) return;
          if (
            revision !== this.notificationRevision ||
            dispatch !== dispatchVersion
          )
            return;
          if (
            state &&
            (typeof state.paused !== "boolean" ||
              !Number.isSafeInteger(state.position) ||
              state.position < 0 ||
              !Number.isSafeInteger(state.duration) ||
              state.duration <= 0 ||
              state.duration > 86400000 ||
              typeof state.track_window?.current_track?.uri !== "string" ||
              !/^spotify:track:[A-Za-z0-9]{22}$/.test(
                state.track_window.current_track.uri,
              ))
          ) {
            failure();
            return;
          }
          if (
            state &&
            this.accepted &&
            state.track_window.current_track.uri !== this.uri
          ) {
            failure();
            return;
          }
          latest = { paused: state?.paused === true, revision };
          if (state?.paused) {
            // A fresh quiet sample cancels reassertion immediately. It releases
            // Play only after every dispatched SDK promise has settled and this
            // read was requested after the final dispatch.
            cancelRetries();
            if (!inFlight) {
              control.cancel();
              confirmed(state);
            }
          }
        } catch {
          failure();
        } finally {
          reading = false;
          if (current()) pollTimer = setTimeout(() => void inspect(), 50);
        }
      };
      const dispatch = () => {
        if (!current()) return;
        dispatchVersion++;
        inFlight++;
        try {
          // SDK acknowledgement can mean only that a message was dispatched.
          // Reassert desired pause at most twice; never replay a start/resume.
          void Promise.resolve(player.pause()).then(
            () => {
              inFlight--;
              if (current()) void inspect();
            },
            () => {
              inFlight--;
              failure();
            },
          );
        } catch {
          inFlight--;
          failure();
        }
      };
      this.deadline = setTimeout(failure, 2000);
      for (const delay of [250, 500])
        retries.push(
          setTimeout(() => {
            if (
              current() &&
              latest &&
              !latest.paused &&
              latest.revision === this.notificationRevision
            )
              dispatch();
          }, delay),
        );
      dispatch();
      void inspect();
    });
  }
  destroy() {
    if (this.dead) return;
    this.invalidateWrites();
    this.pauseConfirmation?.cancel();
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
    this.invalidateWrites();
    this.pauseConfirmation?.cancel();
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
      marker === "playback_retired"
        ? "Playback could not be stopped safely. Check Spotify before reloading this page."
        : marker === "device_timeout"
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
              : code === "playback_target_unavailable"
                ? "Spotify could not find this song or browser player. Try again or open Spotify."
                : code === "playback_unconfirmed"
                  ? "Spotify did not confirm whether playback started. Check Spotify before trying again."
                  : code === "playback_service_error"
                    ? "Spotify reported a playback service error. Check Spotify before trying again."
                    : code === "playback_control_unavailable"
                      ? "The app could not prepare playback safely. Try again later or open Spotify."
                      : setupMessage,
      code === "playback_required",
    );
  }
  private state(state: PlaybackState | null, fresh = false) {
    if (this.dead || this.status === "error") return;
    if (this.pauseConfirmation) return;
    if (!this.accepted) {
      if (state?.paused === false && this.status === "ready") {
        this.retire();
        this.fail(
          "Unexpected playback stopped. Check Spotify before reloading this page.",
        );
      }
      return;
    }
    if (this.awaitingProof && !fresh) return;
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
      // A settled start can precede the SDK loading its new item. The previous
      // paused item is not confirmation, but is safe to await within the same
      // startup deadline. A different playing item must still stop immediately.
      if (
        this.awaitingProof &&
        state.paused &&
        typeof state.track_window?.current_track?.uri === "string" &&
        /^spotify:track:[A-Za-z0-9]{22}$/.test(
          state.track_window.current_track.uri,
        )
      )
        return;
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
    if (this.awaitingProof) {
      // A new start needs a post-ack snapshot near its requested seek point.
      // Raw notifications have no generation and can describe an earlier A in A→B→A.
      if (
        state.position < this.expectedPosition - 1500 ||
        state.position >
          this.expectedPosition + (this.now() - this.startedAt) + 2000
      ) {
        this.fail(
          "Playback could not be confirmed. Try again or open Spotify.",
        );
        return;
      }
      this.awaitingProof = false;
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
        this.state(state ?? null, true);
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
          if (current()) this.state(state ?? null, true);
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
  private async startTrack(
    trackKey: string,
    deviceId: string,
    signal: AbortSignal,
  ) {
    this.startPending = true;
    try {
      return await this.transport.start(trackKey, deviceId, signal);
    } catch (error) {
      // This is the only definitive remote refusal the client retries. All other
      // failures could hide a dispatched write, so their device is retired.
      if (!(
        error instanceof ApiError &&
        error.status === 404 &&
        error.code === "playback_target_unavailable"
      ))
        this.retire();
      throw error;
    } finally {
      this.startPending = false;
    }
  }
  async play(prepareOnly = false) {
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
        const warm = !prepareOnly && window.Spotify;
        let initialToken: string | undefined;
        let sdk: SpotifySDK;
        if (warm) sdk = warm;
        else {
          let tokenTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            initialToken = await Promise.race([
              this.transport.token(this.abort.signal),
              new Promise<string>((_, reject) => {
                tokenTimer = setTimeout(
                  () => reject(new Error("token_timeout")),
                  12000,
                );
              }),
            ]);
          } finally {
            clearTimeout(tokenTimer);
          }
          if (this.dead || operation !== this.operation) return;
          sdk = await loadSDK();
          if (this.dead || operation !== this.operation) return;
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
        const player = ownPlayer(sdk, {
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
            if (this.dead || this.status === "error") return;
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
            if (this.awaitingProof) {
              const operation = this.operation;
              void this.readCurrentState(operation).catch((error) => {
                if (!this.dead && operation === this.operation)
                  this.failure(error);
              });
            } else this.state(state);
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
        if (!warm || prepareOnly) {
          this.emit("ready", "Player ready. Press Play to allow audio.");
          return;
        }
      }
      if (prepareOnly) return;
      // Called synchronously from the explicit click, before the first await.
      const activation = activated ?? this.player.activateElement();
      this.emit("starting");
      const startupUntil = this.now() + 12000;
      this.deadline = setTimeout(
        () => this.fail("Playback did not start. Try again or open Spotify."),
        12000,
      );
      await activation;
      if (this.dead || operation !== this.operation) return;
      if (this.accepted && !ended) {
        this.continuous = true;
        this.commandPending++;
        try {
          await this.player.resume();
        } catch (error) {
          this.retire();
          throw error;
        } finally {
          this.commandPending--;
        }
      } else {
        const device = this.device!;
        this.startedAt = this.now();
        let result;
        try {
          result = await this.startTrack(
            this.trackKey,
            device,
            this.abort.signal,
          );
        } catch (error) {
          // Only a definitive, classified 404 can be retried. A lost response
          // or any other refusal never proves that a playback write was rejected.
          if (
            !(error instanceof ApiError) ||
            error.status !== 404 ||
            error.code !== "playback_target_unavailable"
          )
            throw error;
          const current = () =>
            !this.dead &&
            !this.abort.signal.aborted &&
            operation === this.operation &&
            this.device === device &&
            this.status === "starting" &&
            this.now() < startupUntil;
          if (!current()) return;
          const retry = await new Promise<boolean>((resolve) => {
            const signal = this.abort.signal;
            const finish = (ready: boolean) => {
              clearTimeout(timer);
              signal.removeEventListener("abort", cancel);
              resolve(ready);
            };
            const cancel = () => finish(false);
            const timer = setTimeout(() => finish(current()), 1000);
            signal.addEventListener("abort", cancel, { once: true });
            if (signal.aborted) cancel();
          });
          if (!retry || !current()) return;
          result = await this.startTrack(
            this.trackKey,
            device,
            this.abort.signal,
          );
        }
        if (this.dead || operation !== this.operation) return;
        this.uri = result.uri;
        this.expectedPosition = result.positionMs;
        this.awaitingProof = true;
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
    if (
      !this.dead &&
      (this.startPending ||
        this.awaitingProof ||
        (this.commandPending > 0 && !this.pauseConfirmation))
    ) {
      this.retire();
      this.fail(
        "Playback could not be stopped safely. Check Spotify before reloading this page.",
      );
      return;
    }
    if (this.dead || !this.player || this.status === "pausing") return;
    const operation = ++this.operation;
    this.clearAudioTimer();
    clearTimeout(this.deadline);
    this.emit("pausing");
    await this.confirmPause(operation, (state) => {
      this.emit(state.position === 0 ? "ended" : "paused");
    });
  }
}
