import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ThemeProvider } from "./lib/theme";
// the optical-size cut: big type drawn tighter, small type more open
import "@fontsource-variable/inter/opsz.css";
import "./styles.css";
import { startTranscriptWidth } from "./lib/useTranscriptWidth";
import { installCleanCopy } from "./lib/cleanCopy";
import { applyAccent, chooseAccent, hasStoredAccent, storedAccent } from "./lib/accent";
import { accentForMark } from "./lib/workspaceMark";
import { useLanguage } from "./lib/i18n";
import { startLanguage } from "./lib/language";

// before the first render, so the chosen colour is there from the start.
// A workspace opened for the first time starts on the accent nearest its
// mark, so it looks like itself from its first screen; Personal keeps the
// accent it always had.
const workspace = window.bloks?.workspace;
if (workspace && workspace.kind !== "personal" && workspace.mark && !hasStoredAccent()) chooseAccent(accentForMark(workspace.mark.color));
else applyAccent(storedAccent());
startTranscriptWidth();
// a copy out of a reply pastes as its words and structure, not the theme
installCleanCopy();

/**
 * The whole interface, drawn again when the language changes. The words
 * are read where they are drawn (src/lib/i18n.ts), so drawing everything
 * once more is the whole of a language change: nothing remounts, and an
 * open dialog, a draft or a scroll position stays where it was.
 */
function Root() {
  useLanguage();
  return (
    <ThemeProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </ThemeProvider>
  );
}

// The person's language is loaded before the first frame, so the window
// never opens in English and then changes its mind.
void startLanguage()
  .catch(() => {})
  .then(() => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <Root />
      </StrictMode>,
    );
  });
