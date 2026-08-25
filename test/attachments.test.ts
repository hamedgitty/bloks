// Chips in, one plain prompt out.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  composeOutgoing,
  fileAttachment,
  intakeFiles,
  isLongPaste,
  pasteAttachment,
  splitAttachments,
  attachmentBasename,
  formatBytes,
  type ImageAttachment,
} from "../src/lib/attachments.ts";
import { extensionFor } from "../server/attachments.ts";

const textFile = (name: string, contents: string) => ({
  name,
  size: contents.length,
  type: "text/plain",
  text: async () => contents,
});

describe("isLongPaste", () => {
  test("short text is typing, long text is a chip", () => {
    assert.equal(isLongPaste("hello there"), false);
    assert.equal(isLongPaste("x".repeat(900)), true);
    assert.equal(isLongPaste(Array(12).fill("line").join("\n")), true);
  });
});

describe("intakeFiles", () => {
  const image = (name: string): ImageAttachment => ({
    kind: "image",
    id: "i1",
    path: `/tmp/${name}`,
    name,
    bytes: 10,
    mime: "image/png",
  });

  test("images upload, pathed files keep their path, order survives", async () => {
    const files = [
      { name: "shot.png", size: 10, type: "image/png", text: async () => "" },
      textFile("notes.txt", "hello"),
    ];
    const { attachments, refused } = await intakeFiles(files, {
      pathOf: (f) => (f.name === "notes.txt" ? "/Users/h/notes.txt" : ""),
      uploadImage: async (f) => image(f.name),
    });
    assert.equal(refused, null);
    assert.deepEqual(
      attachments.map((a) => a.kind),
      ["image", "file"],
    );
  });

  test("a pathless text drop keeps its contents inline", async () => {
    const { attachments } = await intakeFiles([textFile("snippet.txt", "line one\nline two")], {
      pathOf: () => "",
      uploadImage: async () => null,
    });
    assert.equal(attachments[0]?.kind, "paste");
    assert.equal((attachments[0] as { text: string }).text, "line one\nline two");
  });

  test("nothing is dropped in silence", async () => {
    const { attachments, refused } = await intakeFiles(
      [{ name: "movie.mp4", size: 5, type: "video/mp4", text: async () => "" }],
      { pathOf: () => "", uploadImage: async () => null },
    );
    assert.equal(attachments.length, 0);
    assert.match(refused ?? "", /movie\.mp4/);
  });

  test("a failed upload becomes a sentence, not an exception", async () => {
    const { attachments, refused } = await intakeFiles(
      [{ name: "big.png", size: 10, type: "image/png", text: async () => "" }],
      {
        pathOf: () => "",
        uploadImage: async () => {
          throw new Error("big.png is over 10 MB");
        },
      },
    );
    assert.equal(attachments.length, 0);
    assert.match(refused ?? "", /over 10 MB/);
  });
});

describe("composeOutgoing and splitAttachments", () => {
  test("chips fold into tagged blocks after the typed text", () => {
    const prompt = composeOutgoing("look at this", [
      fileAttachment("a.ts", "/src/a.ts", 10),
      pasteAttachment("some\npasted\ntext"),
    ]);
    assert.ok(prompt.startsWith("look at this"));
    assert.ok(prompt.includes('<attached-file path="/src/a.ts" />'));
    assert.ok(prompt.includes("<pasted-text>\nsome\npasted\ntext\n</pasted-text>"));
  });

  test("a hostile filename stays inside its attribute", () => {
    const prompt = composeOutgoing("", [fileAttachment("x", '/tmp/a"><evil>.txt', 1)]);
    assert.ok(!prompt.includes('"><evil>'));
    const { files } = splitAttachments(prompt);
    assert.deepEqual(files, ['/tmp/a"><evil>.txt']);
  });

  test("images round-trip out of the transcript text", () => {
    const prompt = composeOutgoing("here", [
      { kind: "image", id: "i", path: "/tmp/att/abc.png", name: "s.png", bytes: 5, mime: "image/png" },
    ]);
    const { display, images } = splitAttachments(prompt);
    assert.equal(display, "here");
    assert.deepEqual(images, ["/tmp/att/abc.png"]);
  });

  test("attachments alone make a sendable prompt", () => {
    const prompt = composeOutgoing("   ", [fileAttachment("a", "/a", 1)]);
    assert.equal(prompt, '<attached-file path="/a" />');
  });
});

describe("small helpers", () => {
  test("basename handles both slash directions", () => {
    assert.equal(attachmentBasename("/tmp/att/abc.png"), "abc.png");
    assert.equal(attachmentBasename("C:\\att\\abc.png"), "abc.png");
  });

  test("sizes read like a human wrote them", () => {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(2048), "2.0 KB");
    assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
  });

  test("only real image types earn an extension", () => {
    assert.equal(extensionFor("image/png"), "png");
    assert.equal(extensionFor("image/jpeg; charset=binary"), "jpg");
    assert.equal(extensionFor("image/svg+xml"), null);
    assert.equal(extensionFor("text/html"), null);
    assert.equal(extensionFor(undefined), null);
  });
});
