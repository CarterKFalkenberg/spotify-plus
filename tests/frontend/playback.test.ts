import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../app/src/api";
import {
  QueuePlayer,
  type ListenView,
  type PlaybackState,
  type WebPlayer,
  type SpotifySDK,
} from "../../app/src/playback";
const uri = `spotify:track:${"a".repeat(22)}`;
const device = "synthetic-device-1234567890";
class Player implements WebPlayer {
  listeners = new Map<string, (value: any) => void>();
  current: PlaybackState | null = null;
  pause = vi.fn(async () => {
    if (this.current) this.current = { ...this.current, paused: true };
  });
  resume = vi.fn(async () => {
    if (this.current) this.current = { ...this.current, paused: false };
  });
  disconnect = vi.fn();
  activateElement = vi.fn(async () => {});
  getCurrentState = vi.fn(async () => this.current);
  connect = vi.fn(async () => {
    this.listeners.get("ready")?.({ device_id: device });
    return true;
  });
  addListener(event: string, callback: (value: any) => void) {
    this.listeners.set(event, callback);
    return true;
  }
  removeListener(event: string, callback?: (value: any) => void) {
    if (!callback || this.listeners.get(event) === callback)
      this.listeners.delete(event);
    return true;
  }
  async state(paused = false, position = 60000, track = uri) {
    this.current = {
      paused,
      position,
      duration: 180000,
      track_window: { current_track: { uri: track } },
    };
    this.listeners.get("player_state_changed")?.(this.current);
    await Promise.resolve();
  }
}
let player: Player;
let views: ListenView[];
let controller: QueuePlayer;
let start: ReturnType<
  typeof vi.fn<
    (
      key: string,
      device: string,
      signal: AbortSignal,
    ) => Promise<{ uri: string; positionMs: number; durationMs: number }>
  >
>;
let token: ReturnType<typeof vi.fn<(signal: AbortSignal) => Promise<string>>>;
beforeEach(() => {
  vi.useFakeTimers();
  views = [];
  player = new Player();
  const sdk = {
    Player: class {
      constructor() {
        return player;
      }
    },
  };
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {
    createElement: () => ({ remove() {} }),
    head: {
      append() {
        window.Spotify = sdk as unknown as SpotifySDK;
        window.onSpotifyWebPlaybackSDKReady?.();
        delete window.Spotify;
      },
    },
  });
  start = vi.fn(async () => ({ uri, positionMs: 60000, durationMs: 180000 }));
  token = vi.fn(async () => "synthetic-access");
  controller = new QueuePlayer("a".repeat(64), { token, start }, (view) =>
    views.push(view),
  );
});
afterEach(() => {
  controller.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function prepare() {
  await controller.play();
  expect(views.at(-1)?.status).toBe("ready");
}
describe("queue listening", () => {
  it("prepares only on demand, starts this SDK device, and times 20 seconds from confirmed playback", async () => {
    expect(token).not.toHaveBeenCalled();
    await prepare();
    await controller.play();
    expect(start).toHaveBeenCalledWith(
      "a".repeat(64),
      device,
      expect.any(AbortSignal),
    );
    expect(views.at(-1)?.status).toBe("starting");
    await vi.advanceTimersByTimeAsync(8000);
    expect(player.pause).not.toHaveBeenCalled();
    await player.state();
    await vi.advanceTimersByTimeAsync(19999);
    expect(player.pause).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(views.at(-1)?.status).toBe("paused");
    await controller.play();
    expect(player.resume).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(40000);
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(views.at(-1)?.status).toBe("more");
    await controller.pause();
    expect(player.pause).toHaveBeenCalledTimes(2);
  });
  it("a server acknowledgement without matching SDK playback reaches a bounded failure", async () => {
    await prepare();
    await controller.play();
    await vi.advanceTimersByTimeAsync(12000);
    expect(views.at(-1)?.status).toBe("error");
    expect(player.disconnect).toHaveBeenCalledTimes(1);
  });
  it("teardown cancels a late token without constructing or connecting a player", async () => {
    let resolve!: (token: string) => void;
    token.mockImplementation(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    );
    const pending = controller.play();
    controller.destroy();
    resolve("synthetic-access");
    await pending;
    expect(player.connect).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  it("teardown disconnects before a late start response and ignores all its callbacks", async () => {
    await prepare();
    let resolve!: (value: {
      uri: string;
      positionMs: number;
      durationMs: number;
    }) => void;
    start.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = controller.play();
    await Promise.resolve();
    controller.destroy();
    const count = views.length;
    resolve({ uri, positionMs: 60000, durationMs: 180000 });
    await pending;
    await player.state();
    await vi.advanceTimersByTimeAsync(30000);
    expect(views).toHaveLength(count);
    expect(player.disconnect).toHaveBeenCalledTimes(1);
    expect(player.resume).not.toHaveBeenCalled();
  });
  it("a different track stops the dedicated device and never starts the next song", async () => {
    await prepare();
    await controller.play();
    await player.state();
    await player.state(false, 0, `spotify:track:${"b".repeat(22)}`);
    expect(views.at(-1)?.status).toBe("error");
    expect(player.disconnect).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("manual pause suppresses late playback states and keeps Play more unbounded", async () => {
    await prepare();
    await controller.play();
    await player.state();
    await controller.pause();
    void player.state();
    expect(views.at(-1)?.status).toBe("pausing");
    await vi.advanceTimersByTimeAsync(0);
    expect(views.at(-1)?.status).toBe("paused");
    expect(player.pause).toHaveBeenCalledTimes(2);
    await controller.play();
    await player.state();
    await vi.advanceTimersByTimeAsync(25000);
    expect(player.pause).toHaveBeenCalledTimes(2);
  });
  it("provider errors never relay provider messages", async () => {
    await prepare();
    player.listeners.get("account_error")?.({
      message: "synthetic-sensitive-provider-payload",
    });
    expect(views.at(-1)?.message).toBe(
      "Spotify Premium is required to listen here.",
    );
    expect(JSON.stringify(views)).not.toContain("sensitive");
  });
  it("legacy grants offer enable without loading or connecting the SDK", async () => {
    token.mockRejectedValue({ code: "playback_required" });
    await controller.play();
    expect(views.at(-1)?.enable).toBe(true);
    expect(player.connect).not.toHaveBeenCalled();
  });
});

it("unresolved pause remains waiting until confirmed or disconnects after its deadline", async () => {
  await prepare();
  await controller.play();
  await player.state();
  player.pause.mockImplementation(() => new Promise(() => {}));
  void controller.pause();
  expect(views.at(-1)?.status).toBe("pausing");
  await controller.play();
  expect(player.resume).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000);
  expect(views.at(-1)?.status).toBe("error");
  expect(player.disconnect).toHaveBeenCalledTimes(1);
});
it("lost SDK state during continuous playback disconnects within a bound", async () => {
  await prepare();
  await controller.play();
  await player.state();
  await controller.pause();
  await controller.play();
  await player.state();
  expect(views.at(-1)?.status).toBe("more");
  player.current = null;
  await vi.advanceTimersByTimeAsync(3000);
  expect(views.at(-1)?.status).toBe("error");
  expect(player.disconnect).toHaveBeenCalledTimes(1);
});
it("a warmed SDK activates during the click and starts on that same click", async () => {
  window.Spotify = {
    Player: class {
      constructor() {
        return player;
      }
    },
  } as unknown as SpotifySDK;
  const pending = controller.play();
  expect(player.activateElement).toHaveBeenCalledTimes(1);
  await pending;
  expect(start).toHaveBeenCalledTimes(1);
  expect(views.at(-1)?.status).toBe("starting");
});
it("an unresolved SDK state read during Play more disconnects within its deadline", async () => {
  await prepare();
  await controller.play();
  await player.state();
  await controller.pause();
  await controller.play();
  await player.state();
  player.getCurrentState.mockImplementation(() => new Promise(() => {}));
  await vi.advanceTimersByTimeAsync(3000);
  expect(views.at(-1)?.status).toBe("error");
  expect(player.disconnect).toHaveBeenCalledTimes(1);
});

it("a paused poll resolving after Play more cannot undo the newer resume", async () => {
  await prepare();
  await controller.play();
  await player.state();
  await controller.pause();
  const paused = structuredClone(player.current!);
  let resolve!: (state: PlaybackState) => void;
  player.getCurrentState.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await vi.advanceTimersByTimeAsync(500);
  await controller.play();
  expect(views.at(-1)?.status).toBe("more");
  resolve(paused);
  await vi.advanceTimersByTimeAsync(3000);
  expect(views.at(-1)?.status).toBe("more");
  expect(player.pause).toHaveBeenCalledTimes(1);
  expect(player.disconnect).not.toHaveBeenCalled();
});
it.each(["paused", "rejected", "pending"] as const)(
  "a poll invalidated by a newer SDK notification ignores its %s outcome",
  async (outcome) => {
    await prepare();
    await controller.play();
    await player.state();
    await controller.pause();
    await controller.play();
    let resolve!: (state: PlaybackState) => void;
    let reject!: (error: Error) => void;
    player.getCurrentState.mockImplementationOnce(
      () =>
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
    );
    await vi.advanceTimersByTimeAsync(500);
    await player.state(); // A notification supersedes the snapshot that the poll requested.
    if (outcome === "paused") resolve({ ...player.current!, paused: true });
    if (outcome === "rejected") reject(new Error("synthetic stale read"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(views.at(-1)?.status).toBe("more");
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(player.disconnect).not.toHaveBeenCalled();
    // A pending obsolete read must not keep the replacement polling slot busy.
    expect(player.getCurrentState.mock.calls.length).toBeGreaterThan(5);
  },
);
it("rejected suppression of unsolicited playing disconnects instead of claiming paused", async () => {
  await prepare();
  await controller.play();
  await player.state();
  await controller.pause();
  player.pause.mockRejectedValue(new Error("synthetic pause failure"));
  void player.state();
  expect(views.at(-1)?.status).toBe("pausing");
  await vi.advanceTimersByTimeAsync(0);
  expect(views.at(-1)?.status).toBe("error");
  expect(player.disconnect).toHaveBeenCalledTimes(1);
});
it("repeated unsolicited playing cannot extend a permanently pending pause deadline", async () => {
  await prepare();
  await controller.play();
  await player.state();
  await controller.pause();
  player.pause.mockImplementation(() => new Promise(() => {}));
  await player.state();
  expect(views.at(-1)?.status).toBe("pausing");
  await vi.advanceTimersByTimeAsync(1000);
  await player.state();
  await vi.advanceTimersByTimeAsync(999);
  await player.state();
  expect(player.pause).toHaveBeenCalledTimes(4);
  expect(player.disconnect).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(views.at(-1)?.status).toBe("error");
  expect(player.disconnect).toHaveBeenCalledTimes(1);
});

it("an obsolete poll cleanup cannot release a newer in-flight polling ticket", async () => {
  await prepare();
  await controller.play();
  await player.state();
  await controller.pause();
  await controller.play();
  const initialReads = player.getCurrentState.mock.calls.length;
  let oldResolve!: (state: PlaybackState) => void;
  let currentResolve!: (state: PlaybackState) => void;
  player.getCurrentState
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          oldResolve = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          currentResolve = resolve;
        }),
    );
  await vi.advanceTimersByTimeAsync(500);
  await player.state();
  await vi.advanceTimersByTimeAsync(500);
  expect(player.getCurrentState).toHaveBeenCalledTimes(initialReads + 2);
  oldResolve({ ...player.current!, paused: true });
  await vi.advanceTimersByTimeAsync(500);
  expect(player.getCurrentState).toHaveBeenCalledTimes(initialReads + 2);
  expect(views.at(-1)?.status).toBe("more");
  currentResolve(player.current!);
  await vi.advanceTimersByTimeAsync(500);
  expect(player.getCurrentState).toHaveBeenCalledTimes(initialReads + 3);
  expect(player.pause).toHaveBeenCalledTimes(1);
  expect(player.disconnect).not.toHaveBeenCalled();
});

it.each(
  ["initialization_error", "authentication_error", "not_ready"].flatMap(
    (event) =>
      ["before", "after"].flatMap((timing) =>
        [false, true].map((rejectConnect) => ({
          event,
          timing,
          rejectConnect,
        })),
      ),
  ),
)(
  "legacy consent recovery outranks $event $timing token rejection (connect reject=$rejectConnect)",
  async ({ event, timing, rejectConnect }) => {
    window.Spotify = {
      Player: class {
        constructor() {
          return player;
        }
      },
    } as unknown as SpotifySDK;
    let reject!: (error: { code: string }) => void;
    token.mockImplementation(
      () =>
        new Promise((_, no) => {
          reject = no;
        }),
    );
    if (rejectConnect)
      player.connect.mockRejectedValue(
        new Error("synthetic connection failure"),
      );
    const pending = controller.play();
    expect(player.activateElement).toHaveBeenCalledTimes(1);
    if (timing === "before")
      player.listeners.get(event)?.({
        message: "synthetic private diagnostic",
      });
    reject({ code: "playback_required" });
    await pending;
    if (timing === "after")
      player.listeners.get(event)?.({
        message: "synthetic private diagnostic",
      });
    for (const late of [
      "initialization_error",
      "authentication_error",
      "not_ready",
      "playback_error",
    ])
      player.listeners.get(late)?.({ message: "synthetic private diagnostic" });
    await player.state();
    await vi.advanceTimersByTimeAsync(15000);
    expect(views.at(-1)).toEqual({
      status: "error",
      message: "Enable playback to listen in this page.",
      enable: true,
    });
    expect(JSON.stringify(views)).not.toContain("private diagnostic");
    expect(start).not.toHaveBeenCalled();
    expect(player.resume).not.toHaveBeenCalled();
    expect(token).toHaveBeenCalledTimes(1);
  },
);
it.each([
  [
    "initialization_error",
    "Protected audio could not initialize in this browser. Try another supported browser or open Spotify.",
  ],
  [
    "authentication_error",
    "Spotify could not authenticate the player. Reconnect Spotify or try again.",
  ],
  [
    "playback_error",
    "Spotify could not play this song. Try again or open Spotify.",
  ],
])(
  "verified grant reports a fixed distinct %s message",
  async (event, message) => {
    await prepare();
    player.listeners.get(event!)?.({ message: "synthetic private diagnostic" });
    expect(views.at(-1)?.message).toBe(message);
    expect(JSON.stringify(views)).not.toContain("private diagnostic");
  },
);
it("pending initial authorization is bounded even if SDK setup already failed", async () => {
  window.Spotify = {
    Player: class {
      constructor() {
        return player;
      }
    },
  } as unknown as SpotifySDK;
  token.mockImplementation(() => new Promise(() => {}));
  const pending = controller.play();
  player.listeners.get("initialization_error")?.({
    message: "synthetic diagnostic",
  });
  expect(views.at(-1)?.status).toBe("loading");
  await vi.advanceTimersByTimeAsync(12000);
  await pending;
  expect(views.at(-1)?.status).toBe("error");
  expect(start).not.toHaveBeenCalled();
  expect(player.disconnect).toHaveBeenCalledTimes(1);
});
it("teardown still suppresses deferred grant rejection after an early SDK failure", async () => {
  window.Spotify = {
    Player: class {
      constructor() {
        return player;
      }
    },
  } as unknown as SpotifySDK;
  let reject!: (error: { code: string }) => void;
  token.mockImplementation(
    () =>
      new Promise((_, no) => {
        reject = no;
      }),
  );
  const pending = controller.play();
  player.listeners.get("authentication_error")?.({
    message: "synthetic diagnostic",
  });
  controller.destroy();
  const count = views.length;
  reject({ code: "playback_required" });
  await pending;
  expect(views).toHaveLength(count);
  expect(start).not.toHaveBeenCalled();
});
it("scope recovery survives synchronous SDK errors while disconnecting the failed player", async () => {
  window.Spotify = {
    Player: class {
      constructor() {
        return player;
      }
    },
  } as unknown as SpotifySDK;
  token.mockRejectedValue({ code: "playback_required" });
  player.disconnect.mockImplementation(() => {
    player.listeners.get("not_ready")?.({});
    player.listeners.get("initialization_error")?.({
      message: "synthetic diagnostic",
    });
  });
  await controller.play();
  expect(views.at(-1)?.enable).toBe(true);
  expect(player.disconnect).toHaveBeenCalledTimes(1);
  expect(start).not.toHaveBeenCalled();
});
it("SDK ready cannot leave a pending connect promise unbounded", async () => {
  window.Spotify = {
    Player: class {
      constructor() {
        return player;
      }
    },
  } as unknown as SpotifySDK;
  player.connect.mockImplementation(() => {
    player.listeners.get("ready")?.({ device_id: device });
    return new Promise(() => {});
  });
  const pending = controller.play();
  await vi.advanceTimersByTimeAsync(12000);
  await pending;
  expect(views.at(-1)?.status).toBe("error");
  expect(start).not.toHaveBeenCalled();
  expect(player.disconnect).toHaveBeenCalledTimes(1);
});

it("only the exact SDK scope rejection selects fixed permissions copy", async () => {
  await prepare();
  player.listeners.get("authentication_error")?.({
    message: "Invalid token scopes.",
    extra: "synthetic private detail",
  });
  expect(views.at(-1)?.message).toBe(
    "Spotify rejected the permissions for webpage playback. You can keep tagging or open Spotify.",
  );
  expect(JSON.stringify(views)).not.toContain("Invalid token scopes.");
  expect(JSON.stringify(views)).not.toContain("private detail");
});
it.each([
  null,
  "Invalid token scopes.",
  { message: "Invalid token scopes. synthetic secret" },
  { message: "invalid token scopes." },
  Object.create({ message: "Invalid token scopes." }),
  Object.defineProperty({}, "message", {
    get() {
      throw new Error("synthetic hostile getter");
    },
  }),
  new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error("synthetic hostile proxy");
      },
    },
  ),
])(
  "unknown/hostile SDK auth payload keeps fixed generic copy %#",
  async (payload) => {
    await prepare();
    expect(() =>
      player.listeners.get("authentication_error")?.(payload),
    ).not.toThrow();
    expect(views.at(-1)?.message).toBe(
      "Spotify could not authenticate the player. Reconnect Spotify or try again.",
    );
    expect(JSON.stringify(views)).not.toContain("synthetic");
  },
);
it.each(["before", "after"])(
  "exact SDK scope rejection %s grant failure cannot hide Enable playback",
  async (timing) => {
    window.Spotify = {
      Player: class {
        constructor() {
          return player;
        }
      },
    } as unknown as SpotifySDK;
    let reject!: (error: { code: string }) => void;
    token.mockImplementation(
      () =>
        new Promise((_, no) => {
          reject = no;
        }),
    );
    const pending = controller.play();
    if (timing === "before")
      player.listeners.get("authentication_error")?.({
        message: "Invalid token scopes.",
      });
    reject({ code: "playback_required" });
    await pending;
    if (timing === "after")
      player.listeners.get("authentication_error")?.({
        message: "Invalid token scopes.",
      });
    expect(views.at(-1)).toEqual({
      status: "error",
      message: "Enable playback to listen in this page.",
      enable: true,
    });
    expect(start).not.toHaveBeenCalled();
  },
);
it.each([
  [
    "device_timeout",
    "Spotify did not make this browser player ready in time. Try again or open Spotify.",
  ],
  [
    "connect_timeout",
    "The connection to Spotify timed out. Try again or open Spotify.",
  ],
  [
    "connect_failed",
    "Spotify could not connect this browser player. Try again or open Spotify.",
  ],
  ["token_timeout", "Spotify authorization took too long to load. Try again."],
  [
    "device_invalid",
    "Spotify could not identify this browser player. Try again or open Spotify.",
  ],
])(
  "local %s marker selects a distinct fixed setup explanation",
  async (marker, message) => {
    window.Spotify = {
      Player: class {
        constructor() {
          return player;
        }
      },
    } as unknown as SpotifySDK;
    if (marker === "device_timeout") player.connect.mockResolvedValue(true);
    if (marker === "connect_timeout")
      player.connect.mockImplementation(() => {
        player.listeners.get("ready")?.({ device_id: device });
        return new Promise(() => {});
      });
    if (marker === "connect_failed") player.connect.mockResolvedValue(false);
    if (marker === "token_timeout")
      token.mockImplementation(() => new Promise(() => {}));
    if (marker === "device_invalid")
      player.connect.mockImplementation(async () => {
        player.listeners.get("ready")?.({ device_id: "bad" });
        return true;
      });
    const pending = controller.play();
    await vi.advanceTimersByTimeAsync(12000);
    await pending;
    expect(views.at(-1)?.message).toBe(message);
    expect(start).not.toHaveBeenCalled();
  },
);
it.each([new Error("synthetic secret marker"), { message: "device_timeout" }])(
  "unknown errors and plain marker-shaped objects never become setup diagnostics %#",
  async (error) => {
    token.mockRejectedValue(error);
    await controller.play();
    expect(views.at(-1)?.message).toBe(
      "Playback could not be confirmed. Try again or open Spotify.",
    );
    expect(JSON.stringify(views)).not.toContain("synthetic secret");
  },
);

it.each([
  [
    "playback_target_unavailable",
    "Spotify could not find this song or browser player. Try again or open Spotify.",
  ],
  [
    "playback_unconfirmed",
    "Spotify did not confirm whether playback started. Check Spotify before trying again.",
  ],
  [
    "playback_service_error",
    "Spotify reported a playback service error. Check Spotify before trying again.",
  ],
  [
    "playback_control_unavailable",
    "The app could not prepare playback safely. Try again later or open Spotify.",
  ],
])(
  "start failure %s uses fixed copy, disconnects and never automatically retries",
  async (code, message) => {
    await prepare();
    start.mockRejectedValue({
      code,
      message: "synthetic-sensitive-provider-detail",
    });
    await controller.play();
    expect(views.at(-1)?.message).toBe(message);
    expect(JSON.stringify(views)).not.toContain("synthetic-sensitive");
    await vi.advanceTimersByTimeAsync(30000);
    expect(start).toHaveBeenCalledTimes(1);
    expect(player.disconnect).toHaveBeenCalledTimes(1);
    expect(player.resume).not.toHaveBeenCalled();
  },
);

it("a classified API 404 retries once after one second on the same owned song/device", async () => {
  await prepare();
  start.mockRejectedValueOnce(new ApiError("playback_target_unavailable", 404));
  const pending = controller.play();
  await vi.advanceTimersByTimeAsync(999);
  expect(start).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(start).toHaveBeenCalledTimes(2);
  expect(start.mock.calls[1]).toEqual(start.mock.calls[0]);
  await player.state();
  expect(views.at(-1)?.status).toBe("snippet");
});
it.each([
  new ApiError("playback_target_unavailable", 404),
  new ApiError("playback_unconfirmed", 503),
])(
  "a second rejected or ambiguous response ends the single 404 recovery attempt %#",
  async (second) => {
    await prepare();
    start
      .mockRejectedValueOnce(new ApiError("playback_target_unavailable", 404))
      .mockRejectedValueOnce(second);
    const pending = controller.play();
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(views.at(-1)?.status).toBe("error");
    await vi.advanceTimersByTimeAsync(30000);
    expect(start).toHaveBeenCalledTimes(2);
    expect(player.disconnect).toHaveBeenCalledTimes(1);
  },
);
it.each([
  new ApiError("playback_service_error", 503),
  new ApiError("playback_unconfirmed", 503),
  new ApiError("playback_required", 503),
  new ApiError("reconnect", 503),
  new ApiError("playback_cooldown", 503),
  new ApiError("playback_control_unavailable", 503),
  new ApiError("playback_target_unavailable", 503),
  new ApiError("unavailable", 404),
  { code: "playback_target_unavailable", status: 404 },
  new Error("synthetic unknown network failure"),
])(
  "only matching API status/code permit recovery; conflicting or unknown failure %# never replays",
  async (error) => {
    await prepare();
    start.mockRejectedValue(error);
    await controller.play();
    await vi.advanceTimersByTimeAsync(30000);
    expect(start).toHaveBeenCalledTimes(1);
    expect(views.at(-1)?.status).toBe("error");
  },
);
it("teardown during target backoff cancels the timer and ignores all late SDK callbacks", async () => {
  await prepare();
  start.mockRejectedValueOnce(new ApiError("playback_target_unavailable", 404));
  const pending = controller.play();
  await vi.advanceTimersByTimeAsync(500);
  controller.destroy();
  const count = views.length;
  await pending;
  await player.state();
  await vi.advanceTimersByTimeAsync(30000);
  expect(start).toHaveBeenCalledTimes(1);
  expect(views).toHaveLength(count);
  expect(player.resume).not.toHaveBeenCalled();
});
it("the original startup deadline cancels backoff before a second request", async () => {
  await prepare();
  let reject!: (error: ApiError) => void;
  start.mockImplementationOnce(
    () =>
      new Promise((_, no) => {
        reject = no;
      }),
  );
  const pending = controller.play();
  await vi.advanceTimersByTimeAsync(11500);
  reject(new ApiError("playback_target_unavailable", 404));
  await vi.advanceTimersByTimeAsync(1000);
  await pending;
  expect(start).toHaveBeenCalledTimes(1);
  expect(views.at(-1)?.message).toBe(
    "Playback did not start. Try again or open Spotify.",
  );
  expect(player.disconnect).toHaveBeenCalledTimes(1);
});
it("a replacement SDK device notification during backoff cannot redirect the retry", async () => {
  await prepare();
  start.mockRejectedValueOnce(new ApiError("playback_target_unavailable", 404));
  const pending = controller.play();
  await vi.advanceTimersByTimeAsync(500);
  player.listeners.get("ready")?.({
    device_id: "synthetic-replacement-device-12345",
  });
  await vi.advanceTimersByTimeAsync(500);
  await pending;
  expect(start).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(11000);
  expect(views.at(-1)?.status).toBe("error");
});
it("a late successful recovery response cannot update a destroyed queue player", async () => {
  await prepare();
  let resolve!: (value: {
    uri: string;
    positionMs: number;
    durationMs: number;
  }) => void;
  start
    .mockRejectedValueOnce(new ApiError("playback_target_unavailable", 404))
    .mockImplementationOnce(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    );
  const pending = controller.play();
  await vi.advanceTimersByTimeAsync(1000);
  expect(start).toHaveBeenCalledTimes(2);
  controller.destroy();
  const count = views.length;
  resolve({ uri, positionMs: 60000, durationMs: 180000 });
  await pending;
  await player.state();
  await vi.advanceTimersByTimeAsync(30000);
  expect(views).toHaveLength(count);
  expect(start).toHaveBeenCalledTimes(2);
  expect(player.resume).not.toHaveBeenCalled();
});
it("a changed command during backoff prevents a second start without needing an abort", async () => {
  await prepare();
  start.mockRejectedValueOnce(new ApiError("playback_target_unavailable", 404));
  const pending = controller.play();
  await vi.advanceTimersByTimeAsync(500);
  const pausing = controller.pause();
  await vi.advanceTimersByTimeAsync(2000);
  await pausing;
  await pending;
  expect(start).toHaveBeenCalledTimes(1);
});

describe("one page SDK player across queue songs", () => {
  let constructions: number;
  let sdkToken: (callback: (token: string) => void) => void;
  beforeEach(() => {
    constructions = 0;
    window.Spotify = {
      Player: class {
        constructor(options: {
          getOAuthToken: (callback: (token: string) => void) => void;
        }) {
          constructions++;
          sdkToken = options.getOAuthToken;
          return player;
        }
      },
    } as unknown as SpotifySDK;
    // Model the real SDK's shared iframe: another INIT produces a descriptor
    // that does not belong to the retained first streamer, so start rejects.
    start.mockImplementation(async () => {
      if (constructions !== 1)
        throw new ApiError("playback_target_unavailable", 404);
      return { uri, positionMs: 60000, durationMs: 180000 };
    });
  });
  function replace(key = "b".repeat(64)) {
    controller.destroy();
    controller = new QueuePlayer(key, { token, start }, (view) =>
      views.push(view),
    );
  }
  it("reconnects the same instance through Next/Previous and inactive queue reentry", async () => {
    for (const key of ["a", "b", "a", "a"]) {
      if (constructions) replace(key.repeat(64));
      await controller.play();
      await player.state();
      expect(views.at(-1)?.status).toBe("snippet");
      await controller.pause();
      expect(views.at(-1)?.status).toBe("paused");
    }
    expect(constructions).toBe(1);
    expect(player.connect).toHaveBeenCalledTimes(4);
    expect(start).toHaveBeenCalledTimes(4);
    expect(player.disconnect).toHaveBeenCalledTimes(3);
    expect(token).toHaveBeenCalledTimes(4);
  });
  it("detaches old listeners before pause/disconnect and ignores saved late callbacks", async () => {
    await controller.play();
    const ready = player.listeners.get("ready")!;
    const notReady = player.listeners.get("not_ready")!;
    const state = player.listeners.get("player_state_changed")!;
    player.pause.mockImplementationOnce(async () => {
      expect(player.listeners.size).toBe(0);
    });
    replace();
    await controller.play();
    await player.state();
    const disconnects = player.disconnect.mock.calls.length;
    ready({ device_id: "late-old-device-1234567890" });
    notReady({});
    state(null);
    expect(views.at(-1)?.status).toBe("snippet");
    expect(player.disconnect).toHaveBeenCalledTimes(disconnects);
    expect(start.mock.calls.at(-1)?.[1]).toBe(device);
  });
  it("routes token refresh to the current owner and fences a previous owner's late token", async () => {
    await controller.play();
    sdkToken(vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    let resolve!: (token: string) => void;
    token.mockImplementationOnce(() => new Promise((yes) => (resolve = yes)));
    const oldCallback = vi.fn();
    sdkToken(oldCallback);
    replace();
    await controller.play();
    resolve("synthetic-stale-access");
    await vi.advanceTimersByTimeAsync(0);
    expect(oldCallback).not.toHaveBeenCalled();
    const currentCallback = vi.fn();
    sdkToken(currentCallback);
    await vi.advanceTimersByTimeAsync(0);
    expect(currentCallback).toHaveBeenCalledWith("synthetic-access");
    controller.destroy();
    const count = token.mock.calls.length;
    sdkToken(vi.fn());
    expect(token).toHaveBeenCalledTimes(count);
  });
  it("activates in the new click but waits for the old disconnect dispatch before connecting", async () => {
    await controller.play();
    let release!: () => void;
    player.disconnect.mockImplementationOnce(
      () => new Promise<void>((yes) => (release = yes)),
    );
    replace();
    const playing = controller.play();
    expect(player.activateElement).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(player.connect).toHaveBeenCalledTimes(1);
    release();
    await playing;
    expect(player.connect).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(2);
  });
  it("ignores raw shared readiness/state events until the replacement dispatches connect", async () => {
    await controller.play();
    let release!: () => void;
    player.disconnect.mockImplementationOnce(
      () => new Promise<void>((yes) => (release = yes)),
    );
    replace();
    const playing = controller.play();
    await vi.advanceTimersByTimeAsync(0);
    // These are the NEW owner's actual raw listeners, not saved old callbacks.
    player.listeners.get("ready")?.({
      device_id: "synthetic-old-session-device-12345",
    });
    player.listeners.get("not_ready")?.({});
    player.state(false);
    expect(views.at(-1)?.status).toBe("loading");
    expect(player.connect).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    release();
    await playing;
    await player.state();
    expect(views.at(-1)?.status).toBe("snippet");
    expect(player.connect).toHaveBeenCalledTimes(2);
    expect(start.mock.calls.at(-1)?.[1]).toBe(device);
    expect(player.disconnect).toHaveBeenCalledTimes(1);
    // The same live not_ready event is actionable once this connect began.
    player.listeners.get("not_ready")?.({});
    expect(views.at(-1)?.status).toBe("error");
    expect(player.disconnect).toHaveBeenCalledTimes(2);
  });
  it("ignores a previous owner's late connection rejection after the replacement starts", async () => {
    let reject!: (error: Error) => void;
    player.connect.mockImplementationOnce(() => {
      player.listeners.get("ready")?.({ device_id: device });
      return new Promise((_, no) => (reject = no));
    });
    const oldPlay = controller.play();
    await vi.advanceTimersByTimeAsync(0);
    replace();
    await controller.play();
    await player.state();
    const disconnects = player.disconnect.mock.calls.length;
    reject(new Error("synthetic-late-connection"));
    await oldPlay;
    expect(views.at(-1)?.status).toBe("snippet");
    expect(player.disconnect).toHaveBeenCalledTimes(disconnects);
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("does not reconnect when the previous disconnect dispatch rejects", async () => {
    await controller.play();
    player.disconnect.mockImplementationOnce(() =>
      Promise.reject(new Error("synthetic-disconnect-failure")),
    );
    replace();
    await controller.play();
    expect(views.at(-1)?.status).toBe("error");
    expect(player.connect).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("bounds a stuck disconnect dispatch and never starts a canceled replacement", async () => {
    await controller.play();
    player.disconnect.mockImplementationOnce(() => new Promise(() => {}));
    replace();
    const playing = controller.play();
    await vi.advanceTimersByTimeAsync(12000);
    await playing;
    expect(views.at(-1)?.status).toBe("error");
    expect(player.connect).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe("warm active queue session", () => {
  it("prepares authorization and connection without activation or playback", async () => {
    await controller.prepare();
    expect(views.at(-1)?.status).toBe("ready");
    expect(token).toHaveBeenCalledTimes(1);
    expect(player.connect).toHaveBeenCalledTimes(1);
    expect(player.activateElement).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(player.resume).not.toHaveBeenCalled();
    const playing = controller.play();
    expect(player.activateElement).toHaveBeenCalledTimes(1);
    await playing;
    await player.state();
    expect(views.at(-1)?.status).toBe("snippet");
  });
  it("preparation with missing consent never constructs/connects or opens consent", async () => {
    token.mockRejectedValue(new ApiError("playback_required", 503));
    await controller.prepare();
    expect(views.at(-1)?.enable).toBe(true);
    expect(player.connect).not.toHaveBeenCalled();
    expect(player.activateElement).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  it("reuses one connection across settled A→B→A with explicit independent snippets", async () => {
    await controller.prepare();
    for (const key of ["a", "b", "a"]) {
      await controller.setTrack(key.repeat(64));
      const count = start.mock.calls.length;
      expect(views.at(-1)?.status).toBe("ready");
      expect(start).toHaveBeenCalledTimes(count);
      await controller.play();
      await player.state();
      await vi.advanceTimersByTimeAsync(1000);
      expect(start.mock.calls.at(-1)?.[0]).toBe(key.repeat(64));
      expect(views.at(-1)?.status).toBe("snippet");
    }
    expect(token).toHaveBeenCalledTimes(1);
    expect(player.connect).toHaveBeenCalledTimes(1);
    expect(player.disconnect).not.toHaveBeenCalled();
    expect(player.pause).toHaveBeenCalledTimes(2);
    expect(player.resume).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(19000);
    expect(views.at(-1)?.status).toBe("paused");
  });
  it("rapid arrows await one pause proof and do not allow Play before it settles", async () => {
    await controller.prepare();
    await controller.play();
    await player.state();
    let release!: () => void;
    player.pause.mockImplementationOnce(
      () => new Promise((yes) => (release = yes)),
    );
    const first = controller.setTrack("b".repeat(64));
    const last = controller.setTrack("a".repeat(64));
    await controller.play();
    expect(start).toHaveBeenCalledTimes(1);
    expect(player.pause).toHaveBeenCalledTimes(1);
    player.current = { ...player.current!, paused: true };
    release();
    await Promise.all([first, last]);
    await controller.play();
    await player.state();
    expect(start.mock.calls.at(-1)?.[0]).toBe("a".repeat(64));
    expect(views.at(-1)?.status).toBe("snippet");
  });
  it.each(["pending", "rejected", "unconfirmed"])(
    "a %s transition pause retires the shared connection",
    async (outcome) => {
      await controller.prepare();
      await controller.play();
      await player.state();
      if (outcome === "pending")
        player.pause.mockImplementationOnce(() => new Promise(() => {}));
      if (outcome === "rejected")
        player.pause.mockRejectedValueOnce(new Error("synthetic failure"));
      if (outcome === "unconfirmed")
        player.pause.mockImplementation(async () => {});
      void controller.setTrack("b".repeat(64));
      await vi.advanceTimersByTimeAsync(2000);
      expect(views.at(-1)?.status).toBe("error");
      controller.destroy();
      controller = new QueuePlayer("b".repeat(64), { token, start }, (view) =>
        views.push(view),
      );
      await controller.prepare();
      expect(views.at(-1)?.message).toContain("Check Spotify");
      expect(player.connect).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["navigation", "destroy", "deadline", "manual pause"])(
    "an unresolved start at %s permanently fences late writes and replacement sessions",
    async (action) => {
      await controller.prepare();
      let resolve!: (value: {
        uri: string;
        positionMs: number;
        durationMs: number;
      }) => void;
      start.mockImplementationOnce(() => new Promise((yes) => (resolve = yes)));
      const playing = controller.play();
      await vi.advanceTimersByTimeAsync(0);
      if (action === "navigation") await controller.setTrack("b".repeat(64));
      if (action === "destroy") controller.destroy();
      if (action === "deadline") await vi.advanceTimersByTimeAsync(12000);
      if (action === "manual pause") await controller.pause();
      controller.destroy();
      resolve({ uri, positionMs: 60000, durationMs: 180000 });
      await playing;
      controller = new QueuePlayer("b".repeat(64), { token, start }, (view) =>
        views.push(view),
      );
      await controller.prepare();
      await controller.play();
      await player.state();
      expect(views.at(-1)?.status).toBe("error");
      expect(views.at(-1)?.message).toContain("Check Spotify");
      expect(start).toHaveBeenCalledTimes(1);
      expect(player.connect).toHaveBeenCalledTimes(1);
    },
  );
  it("an ambiguous settled start stays retired after fetch has rejected", async () => {
    await controller.prepare();
    start.mockRejectedValueOnce(new ApiError("playback_unconfirmed", 503));
    await controller.play();
    controller.destroy();
    controller = new QueuePlayer("b".repeat(64), { token, start }, (view) =>
      views.push(view),
    );
    await controller.prepare();
    expect(views.at(-1)?.message).toContain("Check Spotify");
    expect(player.connect).toHaveBeenCalledTimes(1);
  });
  it("navigation during definitive 404 backoff cannot replay the old or new track", async () => {
    await controller.prepare();
    start.mockRejectedValueOnce(
      new ApiError("playback_target_unavailable", 404),
    );
    const playing = controller.play();
    await vi.advanceTimersByTimeAsync(500);
    await controller.setTrack("b".repeat(64));
    await vi.advanceTimersByTimeAsync(500);
    await playing;
    expect(start).toHaveBeenCalledTimes(1);
    expect(views.at(-1)?.status).toBe("ready");
    await controller.play();
    await player.state();
    expect(start.mock.calls.at(-1)?.[0]).toBe("b".repeat(64));
    expect(player.connect).toHaveBeenCalledTimes(1);
  });
  it("unsolicited playing while warm and idle disconnects without starting any song", async () => {
    await controller.prepare();
    await player.state();
    expect(views.at(-1)?.status).toBe("error");
    expect(player.disconnect).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });
  it("a stale poll from A cannot cross the quiet barrier and stop a new A snippet", async () => {
    await controller.prepare();
    await controller.play();
    await player.state();
    let resolve!: (state: PlaybackState) => void;
    player.getCurrentState.mockImplementationOnce(
      () => new Promise((yes) => (resolve = yes)),
    );
    await vi.advanceTimersByTimeAsync(500);
    await controller.setTrack("b".repeat(64));
    await controller.setTrack("a".repeat(64));
    await controller.play();
    await player.state();
    resolve({ ...player.current!, paused: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(views.at(-1)?.status).toBe("snippet");
    expect(player.disconnect).not.toHaveBeenCalled();
  });
});

it("teardown drains its old pause as well as disconnect before a replacement connects", async () => {
  await controller.prepare();
  await controller.play();
  await player.state();
  let release!: () => void;
  player.pause.mockImplementationOnce(
    () => new Promise((yes) => (release = yes)),
  );
  controller.destroy();
  controller = new QueuePlayer("b".repeat(64), { token, start }, (view) =>
    views.push(view),
  );
  const prepared = controller.prepare();
  await vi.advanceTimersByTimeAsync(0);
  expect(player.connect).toHaveBeenCalledTimes(1);
  release();
  await prepared;
  expect(player.connect).toHaveBeenCalledTimes(2);
  expect(start).toHaveBeenCalledTimes(1);
});
it("a song change during explicit cold setup cannot spend that gesture on the next song", async () => {
  let release!: (value: string) => void;
  token.mockImplementationOnce(() => new Promise((yes) => (release = yes)));
  const playing = controller.play();
  await controller.setTrack("b".repeat(64));
  release("synthetic-access");
  await playing;
  expect(start).not.toHaveBeenCalled();
  expect(views.at(-1)?.status).toBe("error");
});

it("repeated retry cannot erase a rejected teardown fence", async () => {
  await controller.prepare();
  player.pause.mockRejectedValueOnce(new Error("synthetic teardown refusal"));
  controller.destroy();
  for (let retry = 0; retry < 3; retry++) {
    controller = new QueuePlayer("b".repeat(64), { token, start }, (view) =>
      views.push(view),
    );
    await controller.prepare();
    controller.destroy();
  }
  expect(player.connect).toHaveBeenCalledTimes(1);
  expect(start).not.toHaveBeenCalled();
});

it("a stale raw A notification cannot confirm a new A without a fresh post-ack snapshot", async () => {
  await controller.prepare();
  await controller.play();
  await player.state();
  await controller.setTrack("b".repeat(64));
  await controller.setTrack("a".repeat(64));
  await controller.play();
  const stale = { ...player.current!, paused: false };
  // The event says old A is playing, but the authoritative SDK snapshot is paused.
  player.listeners.get("player_state_changed")?.(stale);
  await vi.advanceTimersByTimeAsync(0);
  expect(views.at(-1)?.status).toBe("starting");
  expect(player.pause).toHaveBeenCalledTimes(1);
  await player.state();
  expect(views.at(-1)?.status).toBe("snippet");
});
it("fresh start proof rejects a matching URI at an implausible seek position", async () => {
  await controller.prepare();
  await controller.play();
  await player.state(false, 100000);
  expect(views.at(-1)?.status).toBe("error");
  expect(player.disconnect).toHaveBeenCalledTimes(1);
});
it("a paused handoff snapshot superseded by a playing event cannot expose the next Play", async () => {
  await controller.prepare();
  await controller.play();
  await player.state();
  let release!: (state: PlaybackState) => void;
  player.getCurrentState.mockImplementationOnce(
    () => new Promise((yes) => (release = yes)),
  );
  player.pause.mockImplementation(async () => {});
  const changing = controller.setTrack("b".repeat(64));
  await vi.advanceTimersByTimeAsync(0);
  const paused = { ...player.current!, paused: true };
  await player.state();
  release(paused);
  await vi.advanceTimersByTimeAsync(1999);
  expect(views.at(-1)?.status).toBe("pausing");
  await vi.advanceTimersByTimeAsync(1);
  await changing;
  expect(views.at(-1)?.status).toBe("error");
  expect(player.disconnect).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledTimes(1);
});

it("a warm start waits through the previous paused URI until fresh matching playback", async () => {
  await controller.prepare();
  await controller.play();
  await player.state();
  await controller.setTrack("b".repeat(64));
  const nextURI = `spotify:track:${"b".repeat(22)}`;
  start.mockResolvedValueOnce({
    uri: nextURI,
    positionMs: 60000,
    durationMs: 180000,
  });
  await controller.play();
  expect(views.at(-1)?.status).toBe("starting");
  await vi.advanceTimersByTimeAsync(8000);
  expect(views.at(-1)?.status).toBe("starting");
  expect(player.disconnect).not.toHaveBeenCalled();
  await player.state(false, 60000, nextURI);
  expect(views.at(-1)?.status).toBe("snippet");
  await vi.advanceTimersByTimeAsync(19999);
  expect(player.pause).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(player.pause).toHaveBeenCalledTimes(2);
  expect(views.at(-1)?.status).toBe("paused");
});
it.each(["pending paused item", "old playing item"])(
  "warm next-song startup still bounds a %s",
  async (outcome) => {
    await controller.prepare();
    await controller.play();
    await player.state();
    await controller.setTrack("b".repeat(64));
    start.mockResolvedValueOnce({
      uri: `spotify:track:${"b".repeat(22)}`,
      positionMs: 60000,
      durationMs: 180000,
    });
    await controller.play();
    if (outcome === "old playing item") await player.state();
    else await vi.advanceTimersByTimeAsync(12000);
    expect(views.at(-1)?.status).toBe("error");
    expect(player.disconnect).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(2);
  },
);

it("a malformed paused item cannot use the warm-start previous-item exception", async () => {
  await controller.prepare();
  await controller.play();
  await player.state(true, 60000, "synthetic-invalid-uri");
  expect(views.at(-1)?.status).toBe("error");
  expect(player.disconnect).toHaveBeenCalledTimes(1);
});

it.each(["unpaused", "null"])(
  "a pause acknowledgement with initial %s state waits for bounded quiet proof",
  async (initial) => {
    await controller.prepare();
    await controller.play();
    await player.state();
    player.pause.mockImplementationOnce(async () => {});
    if (initial === "null") player.current = null;
    const changing = controller.setTrack("b".repeat(64));
    await vi.advanceTimersByTimeAsync(149);
    expect(views.at(-1)?.status).toBe("pausing");
    await controller.play();
    expect(start).toHaveBeenCalledTimes(1);
    expect(player.disconnect).not.toHaveBeenCalled();
    await player.state(true);
    await vi.advanceTimersByTimeAsync(1);
    await changing;
    expect(views.at(-1)?.status).toBe("ready");
    expect(player.connect).toHaveBeenCalledTimes(1);
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    await controller.play();
    await player.state();
    expect(views.at(-1)?.status).toBe("snippet");
    expect(start.mock.calls.at(-1)?.[0]).toBe("b".repeat(64));
  },
);
it.each(["unpaused", "null"])(
  "a permanently %s handoff state cannot extend the original quiet deadline",
  async (state) => {
    await controller.prepare();
    await controller.play();
    await player.state();
    player.pause.mockImplementation(async () => {});
    if (state === "null") player.current = null;
    const changing = controller.setTrack("b".repeat(64));
    await vi.advanceTimersByTimeAsync(1000);
    const finalChange = controller.setTrack("a".repeat(64));
    await vi.advanceTimersByTimeAsync(999);
    expect(views.at(-1)?.status).toBe("pausing");
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([changing, finalChange]);
    expect(views.at(-1)?.status).toBe("error");
    expect(player.disconnect).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  },
);
it("a malformed handoff snapshot fails immediately instead of claiming quiet", async () => {
  await controller.prepare();
  await controller.play();
  await player.state();
  player.getCurrentState.mockResolvedValueOnce({
    ...player.current!,
    paused: true,
    duration: 0,
  });
  await controller.setTrack("b".repeat(64));
  expect(views.at(-1)?.status).toBe("error");
  expect(player.disconnect).toHaveBeenCalledTimes(1);
});

it.each(["handoff", "manual", "automatic"])(
  "a dropped first pause recovers on bounded reassertion during %s",
  async (mode) => {
    await controller.prepare();
    await controller.play();
    await player.state();
    player.pause.mockImplementationOnce(async () => {});
    let pausing: Promise<void> | undefined;
    if (mode === "handoff") pausing = controller.setTrack("b".repeat(64));
    else if (mode === "manual") pausing = controller.pause();
    else await vi.advanceTimersByTimeAsync(20000);
    await vi.advanceTimersByTimeAsync(249);
    expect(views.at(-1)?.status).toBe("pausing");
    expect(player.pause).toHaveBeenCalledTimes(1);
    await controller.play();
    expect(start).toHaveBeenCalledTimes(1);
    expect(player.resume).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pausing;
    expect(views.at(-1)?.status).toBe(mode === "handoff" ? "ready" : "paused");
    expect(player.pause).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(player.pause).toHaveBeenCalledTimes(2);
    expect(player.disconnect).not.toHaveBeenCalled();
  },
);
it("quiet proof after the first dispatch cancels both reassertion timers", async () => {
  await controller.prepare();
  await controller.play();
  await player.state();
  await controller.pause();
  await vi.advanceTimersByTimeAsync(1000);
  expect(player.pause).toHaveBeenCalledTimes(1);
  expect(views.at(-1)?.status).toBe("paused");
});
it("three ignored pause dispatches retire at the original deadline without another retry", async () => {
  await controller.prepare();
  await controller.play();
  await player.state();
  player.pause.mockImplementation(async () => {});
  const pausing = controller.pause();
  await vi.advanceTimersByTimeAsync(500);
  expect(player.pause).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1499);
  expect(views.at(-1)?.status).toBe("pausing");
  expect(player.pause).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1);
  await pausing;
  expect(views.at(-1)?.status).toBe("error");
  expect(player.disconnect).toHaveBeenCalledTimes(1);
  // Teardown dispatches its own final pause; no retry survives that teardown.
  expect(player.pause).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(10000);
  expect(player.pause).toHaveBeenCalledTimes(4);
});
it("raw quiet state cannot release a handoff before every SDK command settles", async () => {
  await controller.prepare();
  await controller.play();
  await player.state();
  let settle!: () => void;
  player.pause
    .mockImplementationOnce(async () => {})
    .mockImplementationOnce(() => {
      player.current = { ...player.current!, paused: true };
      return new Promise<void>((resolve) => {
        settle = resolve;
      });
    });
  const changing = controller.setTrack("b".repeat(64));
  await vi.advanceTimersByTimeAsync(250);
  await player.state(true);
  const readsBeforeSettle = player.getCurrentState.mock.calls.length;
  await vi.advanceTimersByTimeAsync(750);
  expect(views.at(-1)?.status).toBe("pausing");
  expect(player.pause).toHaveBeenCalledTimes(2);
  await controller.play();
  expect(start).toHaveBeenCalledTimes(1);
  settle();
  await vi.advanceTimersByTimeAsync(0);
  await changing;
  expect(player.getCurrentState.mock.calls.length).toBeGreaterThan(
    readsBeforeSettle,
  );
  expect(views.at(-1)?.status).toBe("ready");
  await controller.play();
  await player.state();
  await vi.advanceTimersByTimeAsync(1000);
  expect(views.at(-1)?.status).toBe("snippet");
  expect(player.pause).toHaveBeenCalledTimes(2);
});
it("cancelling pause confirmation removes future reassertions and fences late settlement", async () => {
  await controller.prepare();
  await controller.play();
  await player.state();
  let settle!: () => void;
  player.pause.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
  );
  const pausing = controller.pause();
  await vi.advanceTimersByTimeAsync(100);
  controller.destroy();
  await pausing;
  const pauseCount = player.pause.mock.calls.length;
  settle();
  await vi.advanceTimersByTimeAsync(10000);
  expect(player.pause).toHaveBeenCalledTimes(pauseCount);
  expect(start).toHaveBeenCalledTimes(1);
  controller = new QueuePlayer("b".repeat(64), { token, start }, (view) =>
    views.push(view),
  );
  await controller.prepare();
  expect(views.at(-1)?.message).toContain("Check Spotify");
  expect(player.connect).toHaveBeenCalledTimes(1);
});

it("manual pause never grants Play more on a different SDK song", async () => {
  await controller.prepare();
  await controller.play();
  await player.state();
  player.current = {
    ...player.current!,
    track_window: { current_track: { uri: `spotify:track:${"b".repeat(22)}` } },
  };
  await controller.pause();
  expect(views.at(-1)?.status).toBe("error");
  await controller.play();
  expect(player.resume).not.toHaveBeenCalled();
  expect(player.disconnect).toHaveBeenCalledTimes(1);
});

it("Pause retires an unresolved resume even when a playing event arrived before its acknowledgement", async () => {
  await controller.prepare();
  await controller.play();
  await player.state();
  await controller.pause();
  let settle!: () => void;
  player.resume.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
  );
  const resuming = controller.play();
  await vi.advanceTimersByTimeAsync(0);
  await player.state();
  expect(views.at(-1)?.status).toBe("more");
  await controller.pause();
  expect(views.at(-1)?.status).toBe("error");
  expect(player.disconnect).toHaveBeenCalledTimes(1);
  settle();
  await resuming;
  await player.state();
  expect(views.at(-1)?.status).toBe("error");
  controller.destroy();
  controller = new QueuePlayer("b".repeat(64), { token, start }, (view) =>
    views.push(view),
  );
  await controller.prepare();
  expect(views.at(-1)?.message).toContain("Check Spotify");
  expect(player.connect).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledTimes(1);
});
