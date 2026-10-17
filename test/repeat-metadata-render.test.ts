import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";

test("actual ToolRun ignores legacy repeat metadata while retaining tool states", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-legacy-tool-render-"));
  try {
    const compiled = await build({
      stdin: { contents: `import {createElement} from 'react';
        import {renderToStaticMarkup} from 'react-dom/server';
        import {ToolRun} from './src/components/ToolRun.tsx';
        export const render = messages => renderToStaticMarkup(createElement(ToolRun,{messages}));`,
        resolveDir: resolve("."), loader: "tsx" },
      bundle: true, platform: "node", format: "esm", write: false,
      banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
    });
    const file = join(dir, "render.mjs"); writeFileSync(file, compiled.outputFiles[0].text);
    const { render } = await import(pathToFileURL(file).href);
    for (const repeated of [5, 10, 20]) {
      for (const state of [{ok:true}, {ok:false}, {}, {stopped:true}]) {
        const messages = [{id:"one",role:"bot",kind:"activity",repeated,tool:{name:"shell",command:"node sample.js",...state}}];
        const html = render(messages);
        assert.doesNotMatch(html, /Same call repeated|It may be stuck|same arguments/i);
        assert.match(html, /node sample.js/);
        const status = "stopped" in state ? "stopped" : state.ok === undefined ? "running" : state.ok ? "done" : "failed";
        assert.ok(html.includes(`aria-label="${status}"`));
        const grouped = render([...messages,{id:"two",role:"bot",kind:"activity",repeated:20,tool:{name:"Read",ok:true}}]);
        assert.doesNotMatch(grouped, /Same call repeated|It may be stuck|same arguments/i);
        assert.match(grouped, /read 1 file/);
      }
    }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
