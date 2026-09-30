// Background programs without console windows on Windows.
//
// Bloks runs from a GUI app, so on Windows its server has no console. A
// console program it starts (an agent CLI, docker, npx) gets a brand new
// console window unless it is told not to, so every turn flashes one.
// `windowsHide: true` makes Node pass CREATE_NO_WINDOW: the child still
// has a console, just an invisible one, and anything it starts in turn (a
// shell command an agent runs, git, a helper) shares it instead of
// opening its own. Every spawn and execFile of a console program in the
// server sets it (test/windows-consoles.test.ts keeps it that way).
//
// `detached` has to be off on Windows for that to work. There it means
// DETACHED_PROCESS, which leaves the child with no console at all:
// CREATE_NO_WINDOW is ignored next to it, the child's own children each
// get a visible console again, and the child escapes the job object that
// ends it when Bloks exits. Process groups, the reason the drivers
// detach on macOS and Linux, do not exist on Windows anyway.

/** For `detached`: its own process group where there are process groups. */
export const OWN_GROUP = process.platform !== "win32";
