import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pollWhileVisible } from "../../app/src/polling";

class PageEvents extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  show(visible: boolean) {
    this.visibilityState = visible ? "visible" : "hidden";
    this.dispatchEvent(new Event("visibilitychange"));
  }
}
const stops: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
});
function loop(
  load = vi.fn(async (_signal: AbortSignal) => false),
  page = new PageEvents(),
) {
  const focus = new EventTarget(),
    receive = vi.fn(),
    onError = vi.fn();
  const stop = pollWhileVisible({
    load,
    receive,
    onError,
    working: (value) => value,
    page,
    focus,
  });
  stops.push(stop);
  return { load, receive, onError, page, focus, stop };
}
it("two idle visible views use 962 reads in an eight-hour day, leaving room for cron and actions on Free", async () => {
  const status = loop(),
    playlists = loop();
  await vi.advanceTimersByTimeAsync(8 * 60 * 60_000);
  expect(status.load).toHaveBeenCalledTimes(481);
  expect(playlists.load).toHaveBeenCalledTimes(481);
  expect(481 * 2 * 31 + 60 * 24 * 31).toBeLessThan(500_000);
});
it("reads progress every five seconds for one minute, then slows long-running work and returns to idle", async () => {
  let working = true;
  const { load } = loop(vi.fn(async () => working));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(load).toHaveBeenCalledTimes(13);
  await vi.advanceTimersByTimeAsync(14_999);
  expect(load).toHaveBeenCalledTimes(13);
  working = false;
  await vi.advanceTimersByTimeAsync(1);
  expect(load).toHaveBeenCalledTimes(14);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(load).toHaveBeenCalledTimes(14);
  await vi.advanceTimersByTimeAsync(1);
  expect(load).toHaveBeenCalledTimes(15);
});
it("hidden documents issue no reads and visibility plus focus refreshes once immediately", async () => {
  const page = new PageEvents();
  page.show(false);
  const { load, focus } = loop(undefined, page);
  await vi.advanceTimersByTimeAsync(8 * 60 * 60_000);
  expect(load).not.toHaveBeenCalled();
  page.show(true);
  focus.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  expect(load).toHaveBeenCalledTimes(1);
  page.show(false);
  await vi.advanceTimersByTimeAsync(8 * 60 * 60_000);
  expect(load).toHaveBeenCalledTimes(1);
  page.show(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(load).toHaveBeenCalledTimes(2);
});
it("pausing aborts and discards an in-flight stale read even if transport ignores abort", async () => {
  let resolve!: (value: boolean) => void;
  const { load, page, receive, stop } = loop(
    vi.fn(
      (_signal: AbortSignal) =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    ),
  );
  const old = resolve;
  page.show(false);
  expect(load.mock.calls[0]![0].aborted).toBe(true);
  page.show(true);
  old(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(receive).not.toHaveBeenCalled();
  resolve(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(receive).toHaveBeenCalledExactlyOnceWith(false);
  stop();
  page.show(false);
  page.show(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(load).toHaveBeenCalledTimes(2);
});
it("retries failed reads at a bounded cadence and focus recovers without concurrent requests", async () => {
  const load = vi
    .fn(async (_signal: AbortSignal) => false)
    .mockRejectedValueOnce(new Error("offline"));
  const { focus, onError } = loop(load);
  await vi.advanceTimersByTimeAsync(14_999);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(load).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1000);
  focus.dispatchEvent(new Event("focus"));
  focus.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  expect(load).toHaveBeenCalledTimes(3);
});
