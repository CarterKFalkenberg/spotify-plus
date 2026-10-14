// Reads stop when hidden. A long-running or blocked job must not hold the fast
// progress cadence forever; durable workers continue independently of this loop.
export const idlePollMs = 60_000;
export const progressPollMs = 5_000;
export const settledProgressPollMs = 15_000;
export const fastProgressWindowMs = 60_000;

export function pollWhileVisible<T>({
  load,
  receive,
  working,
  onError,
  page = document,
  focus = window,
}: {
  load: (signal: AbortSignal) => Promise<T>;
  receive: (value: T) => void;
  working: (value: T) => boolean;
  onError: (error: unknown) => void;
  page?: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  >;
  focus?: Pick<Window, "addEventListener" | "removeEventListener">;
}) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  let startedAt = -Infinity;
  let workingSince: number | null = null;
  const visible = () => page.visibilityState !== "hidden";
  function pause() {
    clearTimeout(timer);
    request?.abort();
    request = undefined;
  }
  async function read() {
    if (stopped || !visible() || request) return;
    clearTimeout(timer);
    const current = new AbortController();
    request = current;
    startedAt = Date.now();
    let delay = settledProgressPollMs;
    try {
      const value = await load(
        AbortSignal.any([current.signal, AbortSignal.timeout(20_000)]),
      );
      if (stopped || current.signal.aborted) return;
      receive(value);
      if (working(value)) {
        workingSince ??= Date.now();
        delay =
          Date.now() - workingSince < fastProgressWindowMs
            ? progressPollMs
            : settledProgressPollMs;
      } else {
        workingSince = null;
        delay = idlePollMs;
      }
    } catch (error) {
      if (stopped || current.signal.aborted) return;
      onError(error);
    } finally {
      if (request === current) {
        request = undefined;
        if (!stopped && visible()) timer = setTimeout(() => void read(), delay);
      }
    }
  }
  function visibility() {
    if (page.visibilityState === "hidden") pause();
    else void read();
  }
  function refocus() {
    // Browsers commonly send visibilitychange and focus together.
    if (Date.now() - startedAt >= 1000) void read();
  }
  page.addEventListener("visibilitychange", visibility);
  focus.addEventListener("focus", refocus);
  void read();
  return () => {
    stopped = true;
    pause();
    page.removeEventListener("visibilitychange", visibility);
    focus.removeEventListener("focus", refocus);
  };
}
