// A phone-narrow window's way around: one round button of three lines in
// the top-left corner, and behind it a drawer with the rail's places and the agents and
// rooms. The page gets the whole screen until you ask for the list, rather
// than a header strip of faces and icons sitting over every conversation.
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Menu } from "@/components/icons";
import { useStore } from "@/state/store";
import { useEscape } from "@/lib/useEscape";
import { AppRail } from "./AppRail";
import { Sidebar } from "./Sidebar";
import { t } from "@/lib/i18n";

export function MobileNav() {
  const { state } = useStore();
  const [open, setOpen] = useState(false);
  useEscape(() => setOpen(false), open);

  // Going somewhere is what the drawer was opened for, so it closes on
  // arrival: a chat picked, a page opened from the rail.
  const where = `${state.selectedId}|${state.page}|${state.appSettingsOpen}|${state.routinesOpen}|${state.settingsOpen}`;
  useEffect(() => setOpen(false), [where]);

  const unread = state.bots.some((b) => !b.hidden && b.unread);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label={unread ? t("mobileNav.openSidebarUnreadMessages") : t("mobileNav.openSidebar")}
        aria-expanded={open}
        className="fixed left-3 top-[max(env(safe-area-inset-top),10px)] z-30 flex size-10 items-center justify-center rounded-full border bg-popover/95 text-muted-foreground shadow-md shadow-(color:--shadow-color) backdrop-blur-sm transition-[scale,color] duration-150 ease-out hover:text-foreground active:scale-[0.96] md:hidden"
      >
        <Menu size={19} />
        {unread && <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-success ring-2 ring-popover" />}
      </button>
      <AnimatePresence>
        {open && (
          <div className="fixed inset-0 z-40 md:hidden">
            <motion.div
              className="absolute inset-0 bg-black/40 dark:bg-black/60"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={() => setOpen(false)}
            />
            <motion.nav
              aria-label={t("mobileNav.sidebar")}
              className="absolute inset-y-0 left-0 flex w-[min(380px,88vw)] overflow-hidden rounded-r-2xl border-r bg-sidebar pt-[env(safe-area-inset-top)] shadow-2xl shadow-(color:--shadow-color)"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", duration: 0.35, bounce: 0 }}
            >
              <AppRail />
              <div className="flex min-w-0 flex-1 border-l">
                <Sidebar drawer />
              </div>
            </motion.nav>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}
