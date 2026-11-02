// The one line a person runs to install or update an engine's CLI.
//
// Said wherever Bloks cannot do it for them: a window on another device,
// an install that failed, a CLI that was not found when a turn started,
// and on Windows, where the app does not run installers (its scripts are
// POSIX shell). Windows got the Mac line, `curl ... | bash`, which a stock
// PowerShell cannot run at all (GitHub 438). So each engine has the line
// its maker documents for each kind of computer, kept here so the
// settings row, the first-run check and the driver errors say the same.
//
// The scripts the app itself runs live in server/engine-setup.ts and
// server/engine-updates.ts; these are their one-line, readable forms.

/** Where each line comes from, so the next person to check can:
 * Claude Code   code.claude.com/docs/en/setup (native installer, `claude update`)
 * Codex         github.com/openai/codex README (`npm install -g @openai/codex`)
 * Gemini CLI    geminicli.com/docs/get-started/installation (npm)
 * OpenCode      opencode.ai/docs (`npm install -g opencode-ai`)
 * Cline         docs.cline.bot/cline-cli/installation (`npm install -g cline`)
 * Pi            pi.dev/docs/latest/quickstart (npm with --ignore-scripts)
 * Antigravity   github.com/google-antigravity/antigravity-cli (install.ps1)
 * Grok CLI      x.ai/cli/install.ps1, whose header gives its usage
 * Cursor        cursor.com/docs/cli/installation (install?win32=true)
 * Command Code  commandcode.ai/docs (`npm install -g command-code`)
 * Devin         docs.devin.ai/cli (install.sh, setup.ps1) */
interface EngineLines {
  /** macOS and Linux, run in Terminal. */
  posix: string;
  /** Windows, run in PowerShell. */
  windows: string;
}

const INSTALL: Record<string, EngineLines> = {
  claudeAgent: { posix: "curl -fsSL https://claude.ai/install.sh | bash", windows: "irm https://claude.ai/install.ps1 | iex" },
  // npm on Windows writes to the person's own %AppData%\npm, so it needs
  // no --prefix there; on a Mac the global folder belongs to root
  codex: { posix: "npm i -g --prefix ~/.local @openai/codex", windows: "npm install -g @openai/codex" },
  geminiCli: { posix: "npm i -g --prefix ~/.local @google/gemini-cli", windows: "npm install -g @google/gemini-cli" },
  opencode: { posix: "npm i -g --prefix ~/.local opencode-ai", windows: "npm install -g opencode-ai" },
  cline: { posix: "npm i -g --prefix ~/.local cline", windows: "npm install -g cline" },
  pi: {
    posix: "npm i -g --prefix ~/.local --ignore-scripts @earendil-works/pi-coding-agent pi-acp",
    windows: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent pi-acp",
  },
  antigravity: {
    posix: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    windows: "irm https://antigravity.google/cli/install.ps1 | iex",
  },
  grokCli: { posix: "curl -fsSL https://x.ai/cli/install.sh | bash", windows: "irm https://x.ai/cli/install.ps1 | iex" },
  cursor: { posix: "curl https://cursor.com/install -fsS | bash", windows: "irm 'https://cursor.com/install?win32=true' | iex" },
  commandcode: { posix: "npm i -g --prefix ~/.local command-code", windows: "npm install -g command-code" },
  devin: { posix: "curl -fsSL https://cli.devin.ai/install.sh | bash", windows: "irm https://static.devin.ai/cli/setup.ps1 | iex" },
};

/** Windows only: the app updates in place on a Mac or Linux
 * (server/engine-updates.ts), and on Windows the person runs this. The
 * engines that are not here update themselves. */
const WINDOWS_UPDATE: Record<string, string> = {
  claudeAgent: "claude update",
  codex: "npm install -g @openai/codex@latest",
  geminiCli: "npm install -g @google/gemini-cli@latest",
  opencode: "npm install -g opencode-ai@latest",
  cline: "npm install -g cline@latest",
  pi: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent@latest pi-acp@latest",
  commandcode: "npm install -g command-code@latest",
};

/** The line that installs this engine on a computer of this kind. */
export function installCommand(kind: string, platform: string = process.platform): string | undefined {
  const lines = INSTALL[kind];
  return lines && (platform === "win32" ? lines.windows : lines.posix);
}

/** The line that updates this engine on Windows, where the app cannot. */
export function windowsUpdateCommand(kind: string): string | undefined {
  return WINDOWS_UPDATE[kind];
}
