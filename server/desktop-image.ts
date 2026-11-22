// What Bloks knows about its own desktop image, wherever a container of
// it runs: the Local VM it makes (server/local-vm.ts), or one the person
// runs by hand and points an agent at (server/workplace-run.ts).
//
// The image starts as root, so supervisord can bring up the desktop, and
// everything on the desktop then runs as cua: the session, its files
// under /home/cua, and the computer-use driver, which refuses a caller
// of any other uid. Whatever Bloks runs in it has to run as cua too, or
// it can neither write its own home nor reach the screen (GitHub 541).

/** On the image, and so on every container made from it or from an
 * image built on it. */
export const DESKTOP_LABEL = "dev.bloks.vm";

/** Who runs on the desktop, and their home. */
export const DESKTOP_USER = "cua";
export const DESKTOP_HOME = "/home/cua";

/** The computer-use driver, and the socket its server listens on. */
export const DESKTOP_DRIVER = "/usr/local/libexec/bloks/cua-driver";
export const DESKTOP_SOCKET = "/run/user/1000/bloks-cua.sock";
