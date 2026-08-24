// An agent leaving, and one arriving from somewhere else.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  AGENT_FILE_KIND,
  AGENT_FILE_VERSION,
  LIMITS,
  describeAgentFile,
  fileNameFor,
  packAgent,
  parseAgentDocument,
  parseAgentFile,
  profileFromFile,
  type AgentFile,
} from "../server/agent-transfer.ts";

const bot = {
  name: "Ivy",
  title: "Research analyst",
  description: "Reads the primary sources and says where the evidence is thin.",
  color: "blue" as const,
  shape: "diamond" as const,
  skills: ["Sourcing", "Summarising"],
  seniority: 3,
  effort: "high" as const,
  mascotExpression: "focused" as const,
  modelSelection: { instanceId: "inst-a", model: "claude-opus-5" },
  voice: { provider: "elevenlabs" as const, id: "voice-1", name: "Calm" },
};

const round = (input: Parameters<typeof packAgent>[0]) => {
  const packed = packAgent(input);
  const result = parseAgentDocument(JSON.stringify(packed));
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  return (result as { ok: true; file: AgentFile }).file;
};

describe("packing an agent", () => {
  test("carries who it is, what it can do and what it learned", () => {
    const file = round({
      bot,
      memory: "# What I know\n- The Q3 deck lives in Drive.",
      topics: [{ name: "clients.md", text: "Acme prefers bullets." }],
      skills: [{ id: "brief", name: "Brief", description: "Tight briefs", body: "Lead with the answer." }],
      exportedAt: 1_700_000_000_000,
      app: "0.1.6",
    });

    assert.equal(file.kind, AGENT_FILE_KIND);
    assert.equal(file.version, AGENT_FILE_VERSION);
    assert.equal(file.agent.name, "Ivy");
    assert.equal(file.agent.title, "Research analyst");
    assert.deepEqual(file.agent.capabilities, ["Sourcing", "Summarising"]);
    assert.equal(file.agent.seniority, 3);
    assert.equal(file.agent.effort, "high");
    assert.equal(file.agent.mascotExpression, "focused");
    assert.deepEqual(file.agent.model, { instanceId: "inst-a", model: "claude-opus-5" });
    assert.equal(file.agent.voice?.id, "voice-1");
    assert.match(file.memory?.text ?? "", /Q3 deck/);
    assert.deepEqual(file.memory?.topics, [{ name: "clients.md", text: "Acme prefers bullets." }]);
    assert.equal(file.skills?.[0].id, "brief");
    assert.equal(file.exportedAt, 1_700_000_000_000);
  });

  test("leaves behind everything that only means something here", () => {
    // the record an agent lives in carries a thread, tasks, resume
    // cursors, a working folder and its connector grants. None of those
    // survive the trip, and the type is not the guard: the JSON is.
    const file = packAgent({
      bot: {
        ...bot,
        // deliberately shaped like a record with more on it than we pack
        ...({
          id: "bot-1",
          threadId: "t-1",
          cwd: "/Users/someone/secrets",
          computer: "local",
          composio: true,
          mcpServers: ["srv-1"],
          resumeCursors: { "inst-a": { token: "abc" } },
          unread: true,
        } as Record<string, unknown>),
      },
      exportedAt: 1,
    });
    const flat = JSON.stringify(file);
    for (const leak of ["bot-1", "t-1", "/Users/someone/secrets", "srv-1", "abc", "composio"]) {
      assert.equal(flat.includes(leak), false, `${leak} should not travel`);
    }
  });

  test("a nameless agent still gets a name and a filename", () => {
    const file = packAgent({ bot: {}, exportedAt: 1 });
    assert.equal(file.agent.name, "Agent");
    assert.equal(fileNameFor(file.agent.name), "agent.bloks-agent.json");
    assert.equal(fileNameFor("Head of Marketing"), "head-of-marketing.bloks-agent.json");
    assert.equal(fileNameFor("../../etc/passwd"), "etc-passwd.bloks-agent.json");
  });

  test("memory too long for the budget is cut on a character boundary", () => {
    const file = packAgent({ bot, memory: "é".repeat(LIMITS.memory), exportedAt: 1 });
    const text = file.memory?.text ?? "";
    assert.ok(Buffer.byteLength(text, "utf8") <= LIMITS.memory);
    assert.equal(text.includes("�"), false, "no half characters left behind");
  });

  test("a picture only travels if it is one", () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    assert.ok(packAgent({ bot, avatar: { mime: "image/png", data: png }, exportedAt: 1 }).avatar);
    assert.equal(
      packAgent({ bot, avatar: { mime: "text/html", data: png }, exportedAt: 1 }).avatar,
      undefined,
    );
    const huge = Buffer.alloc(LIMITS.avatar + 1).toString("base64");
    assert.equal(
      packAgent({ bot, avatar: { mime: "image/png", data: huge }, exportedAt: 1 }).avatar,
      undefined,
    );
  });
});

describe("reading a file someone sent", () => {
  const good = () => packAgent({ bot, exportedAt: 1 }) as unknown as Record<string, unknown>;

  test("refuses anything that is not one of ours", () => {
    for (const bad of [null, 7, "hello", [], {}, { kind: "something.else" }]) {
      const out = parseAgentFile(bad);
      assert.equal(out.ok, false);
    }
    assert.equal(parseAgentDocument("not json at all").ok, false);
  });

  test("refuses a file from a version that knows more than we do", () => {
    const out = parseAgentFile({ ...good(), version: AGENT_FILE_VERSION + 1 });
    assert.equal(out.ok, false);
    assert.match(out.ok ? "" : out.error, /newer version/);
  });

  test("an agent with no name is not an agent", () => {
    assert.equal(parseAgentFile({ ...good(), agent: { name: "   " } }).ok, false);
    assert.equal(parseAgentFile({ ...good(), agent: "Ivy" }).ok, false);
  });

  test("extra keys are not carried across", () => {
    const out = parseAgentFile({
      ...good(),
      agent: { name: "Ivy", cwd: "/etc", composio: true, mcpServers: ["x"], id: "bot-9" },
      tasks: [{ id: "t" }],
      resumeCursors: { a: 1 },
    });
    assert.equal(out.ok, true);
    const flat = JSON.stringify(out.ok ? out.file : {});
    for (const leak of ["/etc", "composio", "mcpServers", "bot-9", "resumeCursors", "tasks"]) {
      assert.equal(flat.includes(leak), false, `${leak} should not survive parsing`);
    }
  });

  test("a memory file that names its way out of the directory is refused", () => {
    for (const name of ["../escape.md", "/etc/passwd", "notes.md/../../x.md", ".hidden.md", "notes.txt"]) {
      const out = parseAgentFile({
        ...good(),
        memory: { text: "", topics: [{ name, text: "x" }] },
      });
      assert.equal(out.ok, false, `${name} should be refused`);
    }
    const fine = parseAgentFile({
      ...good(),
      memory: { text: "", topics: [{ name: "client notes.md", text: "x" }] },
    });
    assert.equal(fine.ok, true);
  });

  test("oversized parts are refused rather than quietly trimmed", () => {
    const over = (extra: Record<string, unknown>) => parseAgentFile({ ...good(), ...extra });
    assert.equal(over({ memory: { text: "x".repeat(LIMITS.memory + 1), topics: [] } }).ok, false);
    assert.equal(
      over({ memory: { text: "", topics: [{ name: "a.md", text: "x".repeat(LIMITS.topicBytes + 1) }] } }).ok,
      false,
    );
    assert.equal(over({ skills: [{ id: "a", name: "A", body: "x".repeat(LIMITS.skillBytes + 1) }] }).ok, false);
    assert.equal(
      over({ skills: Array.from({ length: LIMITS.skills + 1 }, (_, i) => ({ id: `s${i}`, body: "x" })) }).ok,
      false,
    );
    assert.equal(
      over({ memory: { text: "", topics: Array.from({ length: LIMITS.topics + 1 }, (_, i) => ({ name: `t${i}.md`, text: "x" })) } }).ok,
      false,
    );
    assert.equal(parseAgentDocument("\"" + "x".repeat(LIMITS.file) + "\"").ok, false);
  });

  test("a skill id from a file cannot leave the skills directory", () => {
    const out = parseAgentFile({
      ...good(),
      skills: [{ id: "../../../etc/cron.d/evil", name: "Evil", body: "do things" }],
    });
    assert.equal(out.ok, true);
    assert.equal(out.ok ? out.file.skills?.[0].id : "", "etc-cron-d-evil");
  });

  test("a picture that is not an image, or is empty, is refused", () => {
    assert.equal(parseAgentFile({ ...good(), avatar: { mime: "image/svg+xml", data: "eA==" } }).ok, false);
    assert.equal(parseAgentFile({ ...good(), avatar: { mime: "image/png", data: "" } }).ok, false);
    assert.equal(parseAgentFile({ ...good(), avatar: "picture.png" }).ok, false);
  });
});

describe("what the preview says before you say yes", () => {
  const file = packAgent({
    bot,
    memory: "# What I know\n- lots",
    topics: [{ name: "clients.md", text: "x" }],
    skills: [
      { id: "brief", name: "Brief", description: "", body: "one" },
      { id: "sourcing", name: "Sourcing", description: "", body: "two" },
    ],
    exportedAt: 5,
  });

  test("counts what will be added and what will be kept", () => {
    const preview = describeAgentFile(file, { skillIds: ["brief"], instanceIds: ["inst-a"] });
    assert.equal(preview.name, "Ivy");
    assert.deepEqual(
      preview.skills.map((s) => [s.id, s.alreadyHere]),
      [
        ["brief", true],
        ["sourcing", false],
      ],
    );
    assert.ok(preview.notes.some((n) => /One skill will be added/.test(n)));
    assert.ok(preview.notes.some((n) => /already have a skill called Brief/.test(n)));
  });

  test("says so when the engine it ran on is not set up here", () => {
    const here = describeAgentFile(file, { skillIds: [], instanceIds: ["inst-a"] });
    assert.equal(here.notes.some((n) => /engine you have not set up/.test(n)), false);
    const elsewhere = describeAgentFile(file, { skillIds: [], instanceIds: ["inst-other"] });
    assert.ok(elsewhere.notes.some((n) => /engine you have not set up/.test(n)));
  });

  test("is honest that the conversations stay behind", () => {
    const preview = describeAgentFile(file, { skillIds: [], instanceIds: [] });
    assert.ok(preview.notes.some((n) => /conversations stay behind/.test(n)));
    assert.ok(preview.notes.some((n) => /memory comes with it/.test(n)));
    assert.ok(preview.memoryBytes > 0);
    assert.equal(preview.topics, 1);
  });

  test("a voice with nothing to speak it is called out", () => {
    const quiet = describeAgentFile(file, { skillIds: [], instanceIds: [], voiceReady: false });
    assert.ok(quiet.notes.some((n) => /needs a speech key/.test(n)));
    const loud = describeAgentFile(file, { skillIds: [], instanceIds: [], voiceReady: true });
    assert.equal(loud.notes.some((n) => /needs a speech key/.test(n)), false);
  });
});

describe("what an import actually creates", () => {
  test("the profile is the agent, and nothing it was granted here", () => {
    const file = packAgent({
      bot,
      skills: [{ id: "brief", name: "Brief", description: "", body: "one" }],
      exportedAt: 1,
    });
    const { profile, patch } = profileFromFile(file);
    assert.equal(profile.name, "Ivy");
    assert.deepEqual(profile.skills, ["Sourcing", "Summarising"]);
    assert.deepEqual(profile.skillIds, ["brief"]);
    assert.equal(profile.seniority, 3);
    assert.equal(patch.effort, "high");
    assert.equal(patch.voice?.id, "voice-1");
    const flat = JSON.stringify({ profile, patch });
    for (const leak of ["computer", "cwd", "composio", "mcpServers", "threadId"]) {
      assert.equal(flat.includes(leak), false, `${leak} is not something a file may ask for`);
    }
  });
});
