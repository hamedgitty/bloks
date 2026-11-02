# The interface's words

Every sentence the Bloks desktop and web app shows lives here, one file
per language. `en.json` is the source: the code asks for its keys, and the
typecheck refuses a key it does not have. The other files say the same
keys in their own language.

| File | Language |
| --- | --- |
| `en.json` | English, the source |
| `es.json` | Español |
| `fr.json` | Français |
| `de.json` | Deutsch |
| `pt-BR.json` | Português (Brasil) |
| `ja.json` | 日本語 |
| `zh-CN.json` | 简体中文 |

Each file is one flat object, sorted by key. A key is named by what the
sentence is for, under the area it belongs to (`composer.placeholder`,
`menu.quit`, `common.cancel`), and never changes when the English does.
The `menu.` keys are the macOS menu bar, read by the main process
(`electron/menu-words.mjs`).

## Translating

Translate the value, never the key. Keep the file's shape: same keys,
same order, valid JSON, every value a string. A key you leave out, or
leave in English, shows the English sentence; it never shows the key.

Check your work with `node --test test/i18n.test.ts`. It fails on a
placeholder English does not have, a key English does not have, a dash
the house style forbids, and a file that is not valid JSON.

## The voice

The same in every language:

- **Plain and short.** Say what happens, in the words a person would use
  out loud. No marketing, no exclamation marks.
- **Sentence case.** Only the first word and names take a capital, in
  buttons and titles too ("New agent", not "New Agent"). The macOS menu
  bar is the exception, because macOS writes its menus in title case in
  English; in other languages follow what that language's macOS does.
- **No em dash and no en dash**, in any language. Use a comma, a colon,
  a full stop or brackets instead. Ranges are written with "to" or the
  language's own word for it.
- **The reader is "you"**: the informal you where a language has two
  (tú, du, tu), the polite neutral register in Japanese (です/ます) and
  plain Simplified Chinese (你). Bloks talks to one person, not an
  audience.
- **Keep the punctuation's job.** A trailing "…" means the action opens
  something or is under way ("Saving…"); keep it. Curly quotes in
  English become the language's own quotes (« » in French, „ " in
  German, 「」 in Japanese, “” in Chinese).

## Never translate

- **Bloks** and **Bloks AI**, and every product, company and service
  name: Claude, Claude Code, Codex, Gemini, GitHub, Telegram, Signal,
  WhatsApp, Composio, Home Assistant, iPhone, macOS and the rest.
- **`{placeholders}`**: the word inside the braces stays exactly as it
  is, in any order the sentence needs. `"{name} is working"` may become
  `"{name} trabaja"` or `"{name} が作業中です"`, but never `"{nombre}"`.
- **Keyboard symbols and key names**: ⌘ ⌥ ⇧ ⌃ ↩ ⎋ ⇥, and Esc, Tab,
  Enter, Shift when they name a key.
- **Code and anything typed literally**: commands (`pnpm dev:server`),
  file names and paths, URLs, environment variables, model names,
  `@mentions` and `/slash` commands.

## Plurals

A sentence with a count is one key per plural form, named
`<key>_<form>`, and the code asks for it once with a `count`:

```json
"sidebar.unread_one": "{count} unread message",
"sidebar.unread_other": "{count} unread messages"
```

The forms are the ones each language's own rules use (Unicode CLDR, as
`Intl.PluralRules` reads them):

| Language | Forms to write |
| --- | --- |
| English, Deutsch | `_one`, `_other` |
| Español, Français, Português (Brasil) | `_one`, `_many`, `_other` (`_many` is for round millions, "1 000 000 d’agents"; left out, `_other` is used) |
| 日本語, 简体中文 | `_other` only (delete `_one`) |

French and Brazilian Portuguese read 0 as `_one` ("0 agent"); Spanish
and German read it as `_other`. Always write `_other`: it is what every
missing form falls back to. Keep `{count}` in each form unless the
English form leaves it out (a `_one` that says "an agent" may too).

## The computer

`{computer}` names the machine the way the person has it: "this Mac",
"this PC" or "this computer", or "your Mac" and the rest. Each form is
a whole entry under `thisComputer.`, so a language agrees its "this"
with its own noun ("ce Mac", "cet ordinateur").

Where English puts it after "on", "to" or "from", the code fills it
from `thisComputer.thisOn`, `thisTo`, `thisFrom` or `yourOn` instead,
so each language can say it the way that place needs. German declines
it ("auf diesem Mac", and a move "auf diesen Mac"). Portuguese folds its
"em" and "de" into it ("neste Mac", "deste Mac", "no seu Mac"), so a
Portuguese sentence leaves those words out before `{computer}`.
