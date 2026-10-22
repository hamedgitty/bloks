// Hold the real listener's connect notification at the preflight await.
// Imported only by the synthetic server fixture, never by application code.
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, writeFileSync } from "node:fs";
const connect = net.createConnection;
net.createConnection = function (...args) {
  const socket = connect.apply(this, args);
  if (typeof args[0] === "string" && args[0].includes("bloks-turn-reply-")) {
    socket.once("close", () => writeFileSync(process.env.BLOKS_TEST_REPLY_CLOSED, "closed"));
    const emit = socket.emit.bind(socket);
    socket.emit = function (event, ...values) {
      if (event !== "connect") return emit(event, ...values);
      writeFileSync(process.env.BLOKS_TEST_REPLY_READY, args[0]);
      const deliver = () => {
        if (!existsSync(process.env.BLOKS_TEST_REPLY_RELEASE)) { setTimeout(deliver, 5); return; }
        emit(event, ...values);
        writeFileSync(process.env.BLOKS_TEST_REPLY_RELEASE + ".delivered", "delivered");
      };
      deliver();
      return true;
    };
  }
  return socket;
};
syncBuiltinESMExports();
