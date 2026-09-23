// Resolve the theme before first paint so there is no flash.
// src/lib/theme.tsx owns this class after hydration. This lives in its
// own file, not inline in index.html, because the packaged UI's CSP only
// allows same-origin scripts, and an inline block would never run.
try {
  var stored = localStorage.getItem("bloks-theme");
  var dark =
    stored === "dark" ||
    ((!stored || stored === "system") &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  if (dark) document.documentElement.classList.add("dark");
} catch (e) {}
