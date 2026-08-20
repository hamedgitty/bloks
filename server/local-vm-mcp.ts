// The thinnest possible bridge into the Local VM.
//
// Drivers speak MCP over stdio to whatever command they are given. This
// is that command for the VM: it execs `cua-driver mcp` inside the
// container and pipes bytes through untouched. No parsing, no tools, no
// state; the isolation is the container boundary, and the only checks
// here make sure the exec goes where the harness said it should.
import { spawn } from "node:child_process";

const [runtime, container, socket] = process.argv.slice(2);

if (!["docker", "podman", "container"].includes(runtime ?? "")) {
  process.stderr.write("unknown container runtime\n");
  process.exit(2);
}
if (!/^[a-zA-Z0-9_.-]+$/.test(container ?? "")) {
  process.stderr.write("bad container name\n");
  process.exit(2);
}
if (!socket?.startsWith("/run/user/1000/")) {
  process.stderr.write("bad socket path\n");
  process.exit(2);
}

const child = spawn(
  runtime,
  [
    "exec", "-i", "-u", "cua",
    "-e", "HOME=/home/cua",
    "-e", "DISPLAY=:1",
    "-e", "CUA_DRIVER_INSTALL_CHANNEL=python_package",
    "-e", "CUA_DRIVER_RS_TELEMETRY_ENABLED=0",
    container,
    "/usr/local/libexec/bloks/cua-driver", "mcp", "--socket", socket,
  ],
  { stdio: ["pipe", "pipe", "pipe"] },
);

child.on("error", (e) => {
  process.stderr.write(`could not exec the container runtime: ${e.message}\n`);
  process.exit(2);
});
child.stdin.on("error", () => {});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on("exit", (code) => process.exit(code ?? 1));
process.on("SIGTERM", () => child.kill("SIGTERM"));
