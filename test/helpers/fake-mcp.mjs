// A tiny MCP server over stdio, for the tests.
//
// Publishes one interface and two tools: enough to prove the app can find
// what a server draws, frame it, and call back only what was offered.
import { createInterface } from "node:readline";

const APP = `<div id="app"><h1>Sales</h1><button id="go">Refresh</button></div>
<script>
  document.getElementById("go").addEventListener("click", () => {
    parent.postMessage({ type: "tool", payload: { toolName: "refresh", params: { since: "today" } } }, "*");
  });
</script>`;

const TOOLS = [
  { name: "refresh", description: "Fetch the latest numbers", inputSchema: { type: "object" } },
  { name: "export", description: "Write a CSV", inputSchema: { type: "object" } },
];

const RESOURCES = [
  { uri: "ui://sales/dashboard", name: "Sales dashboard", description: "This quarter", mimeType: "text/html" },
  { uri: "res://sales/raw", name: "Raw rows", mimeType: "application/json" },
];

const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  const reply = (result) => id !== undefined && send({ jsonrpc: "2.0", id, result });

  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "fake-sales", version: "1" },
      });
    case "notifications/initialized":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "resources/list":
      return reply({ resources: RESOURCES });
    case "resources/read": {
      if (params?.uri === "ui://sales/dashboard") {
        return reply({ contents: [{ uri: params.uri, mimeType: "text/html", text: APP }] });
      }
      return reply({ contents: [{ uri: params?.uri ?? "", mimeType: "application/json", text: "[]" }] });
    }
    case "tools/call": {
      if (params?.name === "refresh") {
        return reply({
          content: [{ type: "text", text: `refreshed since ${params?.arguments?.since ?? "never"}` }],
        });
      }
      return reply({ content: [{ type: "text", text: "ok" }] });
    }
    default:
      if (id !== undefined) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `no such method: ${method}` } });
      }
  }
});
