# The desktop service

An agent's own Linux desktop, run beside Bloks on a server: the
`desktop` service in `compose.yml`, turned on with
`COMPOSE_PROFILES=desktop` in `.env`. docs/DOCKER.md says more.

`Dockerfile` here is written by `desktopServiceDockerfile()` in
`server/local-vm.ts`, and a test fails if the two differ. Change the
function, then write the file again from the repository's root:

    node --experimental-strip-types -e 'import("./server/local-vm.ts").then(m=>process.stdout.write(m.desktopServiceDockerfile()))' > docker/desktop/Dockerfile
