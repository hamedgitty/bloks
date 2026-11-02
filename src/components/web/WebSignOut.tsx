// "Signed in", with the way out, for a browser signed in at a server's web
// door (src/lib/webDoor.ts). Drawn in the owner's Settings and on a
// member's workspace page; nothing anywhere else.
import { useState } from "react";
import { Loader2, LogOut } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { signOut, useWebDoor } from "@/lib/webDoor";
import { SettingRow } from "../SettingsLayout";

export function WebSignOutRow() {
  const door = useWebDoor();
  const [busy, setBusy] = useState(false);
  if (!door?.signedIn) return null;
  return (
    <SettingRow
      label={t("webDoor.signedIn")}
      description={door.as?.signIn ? t("webDoor.signedInAs", { account: door.as.signIn, provider: door.provider }) : t("webDoor.signedInWith", { provider: door.provider })}
      control={
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void signOut();
          }}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />}
          {t("webDoor.signOut")}
        </Button>
      }
    />
  );
}
