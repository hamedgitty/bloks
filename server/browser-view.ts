// The agent's browser, seen from the chat.
//
// The agent drives its own Chrome over the debugging protocol (see
// server/browser-proxy.ts). This is the person's side of the same
// connection: a picture of the page while a turn runs, and a way to
// click or type into it when the agent is stuck on something only a
// person can do, like a login or a cookie wall.
//
// Each call attaches, does one thing and lets go. Chrome is happy to
// have several clients on one page, and holding a socket open here would
// be one more thing to clean up when the agent closes its tab.
import { listTargets, Session } from "./cdp.ts";

/** The page the agent means, by the same rule its browser tool uses:
 * the newest one open. */
async function withPage<T>(port: number, act: (page: Session) => Promise<T>): Promise<T> {
  const targets = await listTargets(port);
  if (!targets.length) throw new Error("the agent's browser has no page open");
  const page = new Session(targets[targets.length - 1].webSocketDebuggerUrl);
  await page.open();
  try {
    return await act(page);
  } finally {
    page.close();
  }
}

/** A JPEG of what is on screen. Quality is kept low on purpose: this is a
 * preview that refreshes every second or two, not a record. */
export function captureFrame(port: number): Promise<{ png: string; mime: string }> {
  return withPage(port, async (page) => {
    const shot = await page.send("Page.captureScreenshot", { format: "jpeg", quality: 60 }, 8_000);
    return { png: String(shot.data), mime: "image/jpeg" };
  });
}

/** A click where the person clicked on the preview. The preview is the
 * visible viewport, so a position given as a fraction of it lands on the
 * same spot whatever size the picture was drawn at. */
export function clickAt(port: number, fx: number, fy: number): Promise<void> {
  return withPage(port, async (page) => {
    const metrics = await page.send("Page.getLayoutMetrics", {}, 5_000);
    const viewport = metrics.cssVisualViewport ?? metrics.layoutViewport;
    const x = Math.round(fx * viewport.clientWidth);
    const y = Math.round(fy * viewport.clientHeight);
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (const type of ["mousePressed", "mouseReleased"] as const) {
      await page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
  });
}

/** Text into whatever has focus, and Enter after it when asked. */
export function typeText(port: number, text: string, enter: boolean): Promise<void> {
  return withPage(port, async (page) => {
    if (text) await page.send("Input.insertText", { text });
    if (enter) {
      const key = { key: "Enter", code: "Enter", keyCode: 13, windowsVirtualKeyCode: 13 };
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...key, text: "\r" });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
    }
  });
}
