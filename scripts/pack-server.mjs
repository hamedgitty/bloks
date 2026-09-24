// Packs bloks-server: the Bloks server with no desktop around it, for a
// computer that never sleeps. Run after `pnpm build` and `pnpm build:server`.
//
// The server has no npm dependencies, so the package is only the compiled
// server, the built UI it serves, the two command line entry points, and a
// package.json to mark it as ES modules. Anything with Node 22 runs it.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, "release");
const stage = join(out, "bloks-server");

for (const need of ["dist-server/index.js", "dist/index.html", "bin/bloks-server.mjs", "bin/bloks.mjs"]) {
  if (!existsSync(join(root, need))) {
    console.error(`missing ${need}: run pnpm build and pnpm build:server first`);
    process.exit(1);
  }
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "bin"), { recursive: true });
cpSync(join(root, "dist-server"), join(stage, "dist-server"), { recursive: true });
cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
cpSync(join(root, "bin", "bloks-server.mjs"), join(stage, "bin", "bloks-server.mjs"));
cpSync(join(root, "bin", "bloks.mjs"), join(stage, "bin", "bloks.mjs"));

writeFileSync(
  join(stage, "package.json"),
  JSON.stringify(
    {
      name: "bloks-server",
      version,
      description: "Bloks on a computer that never sleeps",
      license: "FSL-1.1-MIT",
      type: "module",
      bin: { "bloks-server": "bin/bloks-server.mjs" },
      engines: { node: ">=22.6" },
    },
    null,
    2,
  ),
);

writeFileSync(
  join(stage, "Dockerfile"),
  `# Bloks on a server, in a container. Build it next to this file:
#   docker build -t bloks-server .
#   docker run -d --name bloks --restart unless-stopped -v bloks:/root/.bloks bloks-server
# Then, in the running container:
#   docker exec bloks bloks-server activate blok_live_...
#   docker exec bloks bloks-server pair
# No port is published: the server is reached through Bloks Cloud only.
FROM node:22-slim
# the engines agents run on; sign in to them with docker exec afterwards,
# or give agents API keys in the app instead
RUN npm install -g @anthropic-ai/claude-code @openai/codex
WORKDIR /opt/bloks-server
COPY . .
RUN npm link
CMD ["bloks-server"]
`,
);

writeFileSync(
  join(stage, "bloks-server.service"),
  `# A systemd unit, for a Linux server without Docker. Copy to
# /etc/systemd/system/, set User to the account that owns ~/.bloks, then:
#   systemctl enable --now bloks-server
[Unit]
Description=Bloks
After=network-online.target
Wants=network-online.target

[Service]
User=bloks
ExecStart=/usr/bin/env node /opt/bloks-server/bin/bloks-server.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`,
);

writeFileSync(
  join(stage, "README.md"),
  `# bloks-server ${version}

Bloks on a computer that never sleeps: a small rented server, a Mac mini,
a home server. Your agents keep working when your laptop is closed, and
your phone and the desktop app use them through Bloks Cloud.

Needs Node 22.6 or newer, and a Bloks Cloud licence.

    node bin/bloks-server.mjs                    # run it, and keep it running
    node bin/bloks-server.mjs activate KEY       # turn on Bloks Cloud
    node bin/bloks-server.mjs pair               # pair a phone or the desktop app

It listens on loopback only and opens no port: everything reaches it
through Bloks Cloud. Your workspace lives in ~/.bloks on this machine.

Agents run on the engines installed here. Install and sign in to Claude
Code or Codex on this machine, or give agents API keys in the app.

A Dockerfile and a systemd unit are included. Full guide:
https://bloks.dev/docs/server
`,
);

const tarball = join(out, `bloks-server-${version}.tar.gz`);
execFileSync("tar", ["-czf", tarball, "-C", out, "bloks-server"]);
console.log(`packed ${tarball}`);
