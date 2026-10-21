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
