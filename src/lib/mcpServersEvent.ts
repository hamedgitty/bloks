// The server's word that its MCP servers are worth reading again, passed
// from the event stream (src/state/store.tsx) to every list of them
// (src/components/McpServers.tsx). It says so when the desktop app hands
// it a PATH it learned late, so a "Command not found" that was only a
// slow login shell goes away without anyone reopening the page.
export const MCP_SERVERS_EVENT = "bloks:mcp-servers";

export function sayMcpServersChanged() {
  window.dispatchEvent(new Event(MCP_SERVERS_EVENT));
}
