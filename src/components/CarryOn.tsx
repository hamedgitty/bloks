// The Continue on a notice about a turn cut off too long ago to be picked
// up on its own (server/index.ts, recoverCutOff). Pressing it makes the
// same pickup a restart would have. Once it has gone, or the conversation
// moved on without it, the button goes too.
import { useState } from "react";
import { api, useStore, type Message } from "@/state/store";

export function CarryOn({ message }: { message: Message }) {
  const { dispatch } = useStore();
  const [pressed, setPressed] = useState(false);
  const carry = message.carryOn;
  if (!carry || carry.done) return null;
  return (
    <button
      disabled={pressed}
      className="ml-1.5 font-medium underline underline-offset-2 disabled:opacity-60"
      onClick={() => {
        setPressed(true);
        api(`/api/threads/${carry.laneId}/carry-on`, { method: "POST" }).catch((e) => {
          setPressed(false);
          dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
          setTimeout(() => dispatch({ type: "error", message: null }), 6000);
        });
      }}
    >
      Continue
    </button>
  );
}
