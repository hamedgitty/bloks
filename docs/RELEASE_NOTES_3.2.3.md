**The Local VM opens full size from a computer paired to a server.**

## What changed

- **Open desktop from a paired computer.** On a desktop app paired to a server, opening an agent's Local VM full size showed a white page, while the small preview worked. Paired by the server's address, it now opens the live desktop, to watch and to work, as it does on the server itself. Paired through Bloks Cloud, which carries requests and their answers but not a live desktop, it opens the desktop as pictures that keep up every second, and says how to work it yourself.

## For people who build Bloks

- `electron/remote.mjs`: both stand-ins now pass a desktop's viewer (`/local-vm/desktop/<ticket>/` and `/hosted/desktop/<ticket>/`) to the computer it runs on, page and socket, with the ticket as the only credential. Before, the stand-in for a server paired by address answered those paths with the app's own page. A viewer socket that hangs up now closes both ways.
- `POST /api/local-vm/viewer` answers `{ url: null, frames: true }` to a window carried by Bloks Cloud, unless the machine has a public door, which it then names as `/api/hosted/desktop` does.
