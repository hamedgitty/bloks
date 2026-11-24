// An event stream followed for as long as it is wanted, reopened when it
// fails. Kept apart from the hooks that use it so it can be tested with a
// stand-in for the browser's EventSource and a clock of the tests' own.

/** How soon the stream is opened again after it fails, doubling each time
 * up to the longest wait, and back to the first once it opens. */
export const RETRY_FIRST_MS = 1_500;
export const RETRY_MAX_MS = 15_000;

/** What followStream needs of an event stream: the browser's EventSource,
 * or a stand-in in the tests. */
export interface StreamLike {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

/**
 * Follows an event stream for as long as it is wanted, and returns what
 * stops it. The stream reconnects itself only when an open connection
 * drops; an answer that is not a stream at all (a proxy's 502, a relay that
 * has lost the machine for a moment, a server still starting) closes it for
 * good, which left the terminal panel empty under "Trying again" with
 * nothing trying (GitHub 552). So the retry loop is ours, as the app's own
 * event stream's is: close it, wait a little longer each time, open a new
 * one, and start the waits over once one opens.
 */
export function followStream(
  url: string,
  on: { opened: () => void; lost: () => void; message: (data: string) => void },
  open: (url: string) => StreamLike = (u) => new EventSource(u),
  later: (run: () => void, ms: number) => () => void = (run, ms) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
): () => void {
  let stopped = false;
  let current: StreamLike | null = null;
  let cancel: (() => void) | null = null;
  let wait = RETRY_FIRST_MS;
  const retry = () => {
    cancel?.();
    cancel = later(connect, wait);
    wait = Math.min(wait * 2, RETRY_MAX_MS);
  };
  const connect = () => {
    cancel = null;
    if (stopped) return;
    let stream: StreamLike;
    try {
      stream = open(url);
    } catch {
      // a stream that cannot even be made is a failure like any other
      on.lost();
      retry();
      return;
    }
    current = stream;
    stream.onopen = () => {
      if (stopped || current !== stream) return;
      wait = RETRY_FIRST_MS;
      on.opened();
    };
    stream.onmessage = (event) => {
      if (!stopped && current === stream) on.message(event.data);
    };
    stream.onerror = () => {
      if (stopped || current !== stream) return;
      on.lost();
      stream.close();
      current = null;
      retry();
    };
  };
  connect();
  return () => {
    stopped = true;
    cancel?.();
    current?.close();
    current = null;
  };
}
