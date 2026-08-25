// Whether anyone can see the page.
//
// Half the components in this app poll: status every few seconds, a
// screenshot every three. All of that keeps running when the window is
// minimised or on another Space, where every frame is captured for
// nobody. Pollers include this hook's value in their effect deps, so a
// hidden window tears its interval down and a re-shown one starts it
// again, fresh.
import { useEffect, useState } from "react";

export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}
