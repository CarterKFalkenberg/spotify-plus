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
  state(paused = false, position = 60000, track = uri) {
    this.current = {
      paused,
      position,
      duration: 180000,
      track_window: { current_track: { uri: track } },
    };
    this.listeners.get("player_state_changed")?.(this.current);
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
    player.state();
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
    player.state();
    await vi.advanceTimersByTimeAsync(30000);
    expect(views).toHaveLength(count);
    expect(player.disconnect).toHaveBeenCalledTimes(1);
    expect(player.resume).not.toHaveBeenCalled();
  });
  it("a different track stops the dedicated device and never starts the next song", async () => {
    await prepare();
    await controller.play();
    player.state();
    player.state(false, 0, `spotify:track:${"b".repeat(22)}`);
    expect(views.at(-1)?.status).toBe("error");
    expect(player.disconnect).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("manual pause suppresses late playback states and keeps Play more unbounded", async () => {
    await prepare();
    await controller.play();
    player.state();
    await controller.pause();
    player.state();
    expect(views.at(-1)?.status).toBe("pausing");
    await vi.advanceTimersByTimeAsync(0);
    expect(views.at(-1)?.status).toBe("paused");
    expect(player.pause).toHaveBeenCalledTimes(2);
    await controller.play();
    player.state();
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
  player.state();
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
  player.state();
  await controller.pause();
  await controller.play();
  player.state();
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
  player.state();
  await controller.pause();
  await controller.play();
  player.state();
  player.getCurrentState.mockImplementation(() => new Promise(() => {}));
  await vi.advanceTimersByTimeAsync(3000);
  expect(views.at(-1)?.status).toBe("error");
  expect(player.disconnect).toHaveBeenCalledTimes(1);
});

it("a paused poll resolving after Play more cannot undo the newer resume", async () => {
  await prepare();
  await controller.play();
  player.state();
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
    player.state();
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
    player.state(); // A notification supersedes the snapshot that the poll requested.
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
  player.state();
  await controller.pause();
  player.pause.mockRejectedValue(new Error("synthetic pause failure"));
  player.state();
  expect(views.at(-1)?.status).toBe("pausing");
  await vi.advanceTimersByTimeAsync(0);
  expect(views.at(-1)?.status).toBe("error");
  expect(player.disconnect).toHaveBeenCalledTimes(1);
});
it("repeated unsolicited playing cannot extend a permanently pending pause deadline", async () => {
  await prepare();
  await controller.play();
  player.state();
  await controller.pause();
  player.pause.mockImplementation(() => new Promise(() => {}));
  player.state();
  expect(views.at(-1)?.status).toBe("pausing");
  await vi.advanceTimersByTimeAsync(1000);
  player.state();
  await vi.advanceTimersByTimeAsync(999);
  player.state();
  expect(player.pause).toHaveBeenCalledTimes(2);
  expect(player.disconnect).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(views.at(-1)?.status).toBe("error");
  expect(player.disconnect).toHaveBeenCalledTimes(1);
});

it("an obsolete poll cleanup cannot release a newer in-flight polling ticket", async () => {
  await prepare();
  await controller.play();
  player.state();
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
  player.state();
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
    player.state();
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
  player.state();
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
  player.state();
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
  player.state();
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
  await controller.pause();
  await vi.advanceTimersByTimeAsync(500);
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
      player.state();
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
    player.state();
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
    player.state();
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
