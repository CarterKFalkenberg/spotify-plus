import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
