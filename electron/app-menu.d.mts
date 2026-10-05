// Hand-written twin of app-menu.mjs, so the tests typecheck against the
// same shape the main process builds its menu from.

export type MenuCommand = "settings" | "shortcuts";

export interface MenuTemplateItem {
  label?: string;
  role?: string;
  type?: "separator";
  accelerator?: string;
  click?: () => void;
  submenu?: MenuTemplateItem[];
}

export function appMenuTemplate(options: {
  name: string;
  packaged: boolean;
  command: (word: MenuCommand) => void;
}): MenuTemplateItem[];
