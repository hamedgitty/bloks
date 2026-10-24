**The Local VM opens full size again, and two checks that let bad input through now hold.**

## What changed

- **Open desktop shows the Local VM.** The full-size view opened as a white page, because the app wouldn't load the VM's viewer inside its window. It loads now. On a Mac the buttons in its top corner, Open in browser and Close, didn't respond to clicks, and the window buttons sat on the agent's picture. Both are fixed.
- **Codex leaves out an MCP server it can't use as written.** An address that isn't one, an argument that isn't text, or an environment name or value no environment can hold now keeps that server out, with the field named in the chat, instead of mounting it half right. Values are never shown. Thanks @ashottonoyan (#372)
- **A file in one part is checked like any other.** A shared file that came back in a single part skipped the size and byte checks. It's now held to the 50 MB limit and its stated size. Thanks @ashottonoyan (#371)
