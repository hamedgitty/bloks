// Packs bloks-server: the Bloks server with no desktop around it, for a
// computer that never sleeps. Run after `pnpm build` and `pnpm build:server`.
//
// The package is the compiled server with the few npm packages it imports
// already beside it (dist-server/node_modules, staged by
// scripts/stage-server-deps.mjs), the built UI it serves, the two command
// line entry points, the line a network-off container runs, the English
// catalogue the server names the app's places in, and a package.json to
// mark it as ES modules. Nothing is installed after unpacking: anything
// with Node 22 runs it.
//
// Beside the tarball goes its sha256, in the form sha256sum -c and
// shasum -a 256 -c read. A server updating itself from the app refuses a
// download that does not match it (server/server-update.ts), so the
// release has to carry both files.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, "release");
const stage = join(out, "bloks-server");

for (const need of ["dist-server/index.js", "dist-server/node_modules", "dist/index.html", "bin/bloks-server.mjs", "bin/bloks.mjs", "bin/bloks-line.mjs"]) {
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
// The line a network-off container runs for a turn: the server sends it
// there from bin/ beside itself (LINE_SCRIPT in server/index.ts).
cpSync(join(root, "bin", "bloks-line.mjs"), join(stage, "bin", "bloks-line.mjs"));
// Beside dist-server, where server/where.ts reads it, as in the app's
// Resources. Without it nothing fails: `bloks where` and the card `bloks
// open` leaves call every Settings page "label".
mkdirSync(join(stage, "locales"));
cpSync(join(root, "src", "locales", "en.json"), join(stage, "locales", "en.json"));

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

    node bin/bloks-server.mjs update             # install the latest release
    node bin/bloks-server.mjs stop               # stop it

From scripts, CI and a terminal:

    node bin/bloks-server.mjs run Ada "TASK"     # hand an agent a job, print the answer
    node bin/bloks-server.mjs team apply team.md # keep a room in line with a team file
    node bin/bloks-server.mjs chat Ada           # talk to an agent here

The owner can update it from the app too, in Settings, About. A new
version is unpacked under versions/ in this folder, checked against the
release's checksum, and switched to; if it does not start, this one comes
back. Under systemd, launchd or Docker it is updated by hand instead, and
the app shows the steps. Your workspace in ~/.bloks is never touched.

A Dockerfile and a systemd unit are included. Full guide:
https://bloks.dev/docs#server
`,
);

const tarball = join(out, `bloks-server-${version}.tar.gz`);
execFileSync("tar", ["-czf", tarball, "-C", out, "bloks-server"]);
const sum = createHash("sha256").update(readFileSync(tarball)).digest("hex");
writeFileSync(`${tarball}.sha256`, `${sum}  ${basename(tarball)}\n`);
console.log(`packed ${tarball} (sha256 ${sum})`);
