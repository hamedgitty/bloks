// One agent's shells, as the terminal panel sees them: the list of tabs,
// and every tab's output, on one event stream.
//
// One stream rather than one per tab, because a browser keeps six
// connections to a server and an event stream holds one for as long as
// it is open (server/index.ts says more). Frames name the shell they are
// for. A tab's screen may not be drawn yet when its first frames arrive,
// since the tab only appears once the list that names it has rendered, so
// frames for a screen nobody has registered wait here until one does.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { followStream } from "./followStream";

/** What the server says about one shell (server/terminal.ts). */
export interface TerminalInfo {
  id: string;
  botId: string;
  title: string;
  cwd: string;
  shell: string;
  pty: boolean;
  provider: string;
  cols: number;
  rows: number;
  startedAt: number;
  exitedAt?: number;
  exitCode?: number | null;
  /** A tab an agent started itself (`bloks terminal run`): it can read
   * this tab's output back, and only this kind. */
  agent?: { name: string; taskId: string; command: string };
  /** Addresses on this computer it printed, newest last. */
  urls?: string[];
}

/** Where a tab's output goes: its xterm. */
export interface TerminalScreen {
  write(bytes: Uint8Array): void;
  /** The shell was restarted, or the stream reconnected and is about to
   * replay: start from an empty screen rather than doubling what is there. */
  reset(): void;
}

interface Frame {
  list?: TerminalInfo[];
  id?: string;
  hello?: TerminalInfo;
  bye?: TerminalInfo;
  b64?: string;
  reset?: boolean;
  closed?: boolean;
}

/** What waits for a screen is bounded: a replay is at most the server's
 * scrollback, and anything beyond a few of those is not worth keeping. */
const HELD_BYTES = 1024 * 1024;

/** base64 off the wire to the bytes xterm decodes. */
export function decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function useTerminalStream(botId: string) {
  // null until the server has said, so "no tabs" and "not heard yet" are
  // never confused, which is what decides whether to open one
  const [list, setList] = useState<TerminalInfo[] | null>(null);
  const [lost, setLost] = useState(false);
  const screens = useRef(new Map<string, TerminalScreen>());
  const held = useRef(new Map<string, { frames: Frame[]; bytes: number }>());

  useEffect(() => {
    let live = true;
    screens.current.clear();
    held.current.clear();
    setList(null);
    setLost(false);
    // Which shells have said hello, on any connection and on this one. An
    // event stream reconnects by itself, and the server greets a returning
    // client with each shell's replay, which must land on an empty screen.
    const greeted = new Set<string>();
    let thisConnection = new Set<string>();

    const apply = (screen: TerminalScreen, frame: Frame) => {
      if (frame.reset) screen.reset();
      if (frame.b64) screen.write(decode(frame.b64));
    };
    const deliver = (frame: Frame) => {
      const id = frame.id!;
      const screen = screens.current.get(id);
      if (screen) return apply(screen, frame);
      const waiting = held.current.get(id) ?? { frames: [], bytes: 0 };
      waiting.frames.push(frame);
      waiting.bytes += frame.b64?.length ?? 0;
      while (waiting.bytes > HELD_BYTES && waiting.frames.length > 1) {
        waiting.bytes -= waiting.frames.shift()!.b64?.length ?? 0;
      }
      held.current.set(id, waiting);
    };

    const stop = followStream(`/api/bots/${botId}/terminals/stream`, {
      opened: () => {
        thisConnection = new Set();
        if (live) setLost(false);
      },
      lost: () => {
        if (live) setLost(true);
      },
      message: (data) => {
        if (!live) return;
        let frame: Frame;
        try {
          frame = JSON.parse(data);
        } catch {
          return;
        }
        if (frame.list) {
          setList(frame.list);
          return;
        }
        if (!frame.id) return;
        const info = frame.hello ?? frame.bye;
        if (info) setList((now) => now?.map((t) => (t.id === info.id ? info : t)) ?? now);
        if (frame.hello) {
          if (greeted.has(frame.id) && !thisConnection.has(frame.id)) deliver({ id: frame.id, reset: true });
          greeted.add(frame.id);
          thisConnection.add(frame.id);
          return;
        }
        if (frame.closed) {
          held.current.delete(frame.id);
          greeted.delete(frame.id);
          return;
        }
        deliver(frame);
      },
    });
    return () => {
      live = false;
      stop();
    };
  }, [botId]);

  /** Where one tab's output goes, from now until the returned stop. */
  const register = useCallback((id: string, screen: TerminalScreen) => {
    screens.current.set(id, screen);
    const waiting = held.current.get(id);
    held.current.delete(id);
    for (const frame of waiting?.frames ?? []) {
      if (frame.reset) screen.reset();
      if (frame.b64) screen.write(decode(frame.b64));
    }
    return () => {
      if (screens.current.get(id) === screen) screens.current.delete(id);
    };
  }, []);

  return { list, lost, register };
}

// What the panel asks of the server, by tab.
const base = (botId: string) => `/api/bots/${botId}/terminals`;
const send = (path: string, method: string, body?: unknown) =>
  api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const terminalApi = {
  /** The agent's first shell, opening one if there is none. Asked of the
   * older route on purpose: it opens one only when there is none, so two
   * windows opening the panel at once still make one tab, not two. */
  ensure: (botId: string, cols: number, rows: number): Promise<{ terminal: TerminalInfo }> =>
    send(`/api/bots/${botId}/terminal`, "POST", { cols, rows }),
  create: (botId: string, cols: number, rows: number): Promise<{ terminal: TerminalInfo }> =>
    send(base(botId), "POST", { cols, rows }),
  rename: (botId: string, id: string, title: string): Promise<{ terminal: TerminalInfo }> =>
    send(`${base(botId)}/${id}`, "PATCH", { title }),
  close: (botId: string, id: string) => send(`${base(botId)}/${id}`, "DELETE"),
  restart: (botId: string, id: string, cols: number, rows: number): Promise<{ terminal: TerminalInfo }> =>
    send(`${base(botId)}/${id}/restart`, "POST", { cols, rows }),
  clear: (botId: string, id: string) => send(`${base(botId)}/${id}/clear`, "POST", {}),
  busy: (botId: string, id: string): Promise<{ running: boolean; command?: string }> =>
    send(`${base(botId)}/${id}/busy`, "GET"),
  input: (botId: string, id: string, body: { data?: string; cols?: number; rows?: number }) =>
    send(`${base(botId)}/${id}/input`, "POST", body),
};
