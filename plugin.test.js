import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StallNudge } from "./plugin.js";

function makeClient() {
  const calls = { prompts: [], toasts: [] };
  const client = {
    session: {
      prompt: async (req) => {
        calls.prompts.push(req);
        return {};
      },
    },
    tui: {
      showToast: async (req) => {
        calls.toasts.push(req);
      },
    },
  };
  client.calls = calls;
  return client;
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "stall-nudge-"));
}

function logPath(dir, stateDir = ".scratch") {
  return join(dir, stateDir, "plugin.log");
}

function writeStateFile(dir, name, content, stateDir = ".scratch") {
  mkdirSync(join(dir, stateDir), { recursive: true });
  writeFileSync(join(dir, stateDir, name), content);
}

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++nextId;
      timers.set(id, { fn, due: now + ms });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    advance: async (ms) => {
      now += ms;
      const due = [...timers.entries()].filter(([, t]) => t.due <= now);
      for (const [id, t] of due) {
        timers.delete(id);
        await t.fn();
      }
    },
  };
}

async function makeHooks({ options = {}, client = makeClient(), clock = fakeClock() } = {}) {
  const dir = tempDir();
  const hooks = await StallNudge({ client, directory: dir }, options, clock);
  return { dir, hooks, client, clock };
}

const TOOL_AFTER = { sessionID: "ses_1", tool: "bash", callID: "call_1", args: {} };
const IDLE = { type: "session.idle", properties: { sessionID: "ses_1" } };

async function assistantText(hooks, txt) {
  await hooks.event({
    event: {
      type: "message.updated",
      properties: { sessionID: "ses_1", info: { id: "msg_1", role: "assistant" } },
    },
  });
  await hooks.event({
    event: {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: { id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: txt },
      },
    },
  });
}

// --- ticket #2: scaffold + config + logging ---

test("does not write a log and exposes no hooks when disabled", async () => {
  const { dir, hooks } = await makeHooks();
  assert.deepEqual(hooks, {});
  assert.equal(existsSync(logPath(dir)), false);
});

test("writes a startup line with resolved config defaults when enabled", async () => {
  const { dir } = await makeHooks({ options: { enabled: true } });
  const log = readFileSync(logPath(dir), "utf8");
  assert.match(log, /stall-nudge armed/);
  assert.match(log, /idleTimeoutMs=180000/);
  assert.match(log, /maxNudges=3/);
  assert.match(log, /onStall=nudge/);
  assert.match(log, /stateDir=\.scratch/);
});

test("writes the log under a custom stateDir", async () => {
  const { dir } = await makeHooks({ options: { enabled: true, stateDir: "logs" } });
  assert.equal(existsSync(logPath(dir, "logs")), true);
  assert.equal(existsSync(logPath(dir, ".scratch")), false);
});

// --- ticket #3: empty-final-turn detection + auto-nudge ---

test("nudges with the configured prompt when the turn ends empty after a tool result", async () => {
  const { hooks, client } = await makeHooks({ options: { enabled: true, nudgePrompt: "Продолжай, пожалуйста" } });
  await hooks["tool.execute.after"](TOOL_AFTER);
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 1);
  assert.deepEqual(client.calls.prompts[0].path, { id: "ses_1" });
  assert.deepEqual(client.calls.prompts[0].body.parts, [{ type: "text", text: "Продолжай, пожалуйста" }]);
});

test("does not nudge when the model produced text after the tool result", async () => {
  const { hooks, client } = await makeHooks({ options: { enabled: true } });
  await hooks["tool.execute.after"](TOOL_AFTER);
  await assistantText(hooks, "Готово");
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 0);
});

test("does not disarm on user text without an assistant message", async () => {
  const { hooks, client } = await makeHooks({ options: { enabled: true } });
  await hooks["tool.execute.after"](TOOL_AFTER);
  await hooks.event({
    event: {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: { id: "prt_u1", sessionID: "ses_1", messageID: "msg_u1", type: "text", text: "юзер печатает" },
      },
    },
  });
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 1);
});

test("does not nudge when the model called another tool after the tool result", async () => {
  const { hooks, client } = await makeHooks({ options: { enabled: true } });
  await hooks["tool.execute.after"](TOOL_AFTER);
  await hooks["tool.execute.before"]();
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 0);
});

test("does not nudge when status.txt is DONE", async () => {
  const { dir, hooks, client } = await makeHooks({ options: { enabled: true } });
  writeStateFile(dir, "status.txt", "DONE");
  await hooks["tool.execute.after"](TOOL_AFTER);
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 0);
});

test("does not nudge when state.md contains WAITING_FOR_HUMAN", async () => {
  const { dir, hooks, client } = await makeHooks({ options: { enabled: true } });
  writeStateFile(dir, "state.md", "# State\n\n## Следующий шаг\nWAITING_FOR_HUMAN: ждём merge человеком\n");
  await hooks["tool.execute.after"](TOOL_AFTER);
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 0);
});

test("nudges again after the WAITING_FOR_HUMAN marker is removed", async () => {
  const { dir, hooks, client } = await makeHooks({ options: { enabled: true } });
  writeStateFile(dir, "state.md", "WAITING_FOR_HUMAN");
  await hooks["tool.execute.after"](TOOL_AFTER);
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 0);
  writeStateFile(dir, "state.md", "# State\n\n## Следующий шаг\nработаем\n");
  await hooks["tool.execute.after"](TOOL_AFTER);
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 1);
});

test("logs the nudge", async () => {
  const { dir, hooks, client } = await makeHooks({ options: { enabled: true } });
  await hooks["tool.execute.after"](TOOL_AFTER);
  await hooks.event({ event: IDLE });
  const log = readFileSync(logPath(dir), "utf8");
  assert.match(log, /STALL detected/);
});

// --- ticket #4: hung-turn watchdog + nudge budget ---

test("nudges when the idle timer expires with no model output", async () => {
  const { hooks, client, clock } = await makeHooks({ options: { enabled: true } });
  await hooks["tool.execute.after"](TOOL_AFTER);
  await clock.advance(180000);
  assert.equal(client.calls.prompts.length, 1);
});

test("resets the nudge budget when the model outputs after a nudge", async () => {
  const { hooks, client, clock } = await makeHooks({ options: { enabled: true } });
  await hooks["tool.execute.after"](TOOL_AFTER);
  await hooks.event({ event: IDLE });
  await assistantText(hooks, "работаю");
  await hooks["tool.execute.after"](TOOL_AFTER);
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 2);
});

test("stops nudging after maxNudges without progress", async () => {
  const { hooks, client, clock } = await makeHooks({ options: { enabled: true, maxNudges: 2 } });
  await hooks["tool.execute.after"](TOOL_AFTER);
  await hooks.event({ event: IDLE });
  await clock.advance(180000);
  await clock.advance(180000);
  assert.equal(client.calls.prompts.length, 2);
});

// --- ticket #5: alert mode + observability + docs ---

test("alert mode only alerts, never nudges", async () => {
  const { hooks, client } = await makeHooks({ options: { enabled: true, onStall: "alert" } });
  await hooks["tool.execute.after"](TOOL_AFTER);
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 0);
  assert.equal(client.calls.toasts.length, 1);
});

test("both mode nudges and alerts", async () => {
  const { hooks, client } = await makeHooks({ options: { enabled: true, onStall: "both" } });
  await hooks["tool.execute.after"](TOOL_AFTER);
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 1);
  assert.equal(client.calls.toasts.length, 1);
});

test("writes the stall log line in the agreed format", async () => {
  const { dir, hooks } = await makeHooks({ options: { enabled: true } });
  await hooks["tool.execute.after"](TOOL_AFTER);
  await hooks.event({ event: IDLE });
  const log = readFileSync(logPath(dir), "utf8");
  assert.match(log, /STALL detected \(age=\d+s\) → nudge #1/);
});

test("logs the correct nudge number when the model responds during the nudge", async () => {
  const dir = tempDir();
  const client = makeClient();
  let hooks;
  client.session.prompt = async (req) => {
    client.calls.prompts.push(req);
    await hooks["tool.execute.before"]();
    return {};
  };
  hooks = await StallNudge({ client, directory: dir }, { enabled: true }, fakeClock());
  await hooks["tool.execute.after"](TOOL_AFTER);
  await hooks.event({ event: IDLE });
  const log = readFileSync(logPath(dir), "utf8");
  assert.match(log, /→ nudge #1/);
});

test("alerts after the nudge budget is exhausted", async () => {
  const { hooks, client, clock } = await makeHooks({ options: { enabled: true, maxNudges: 1 } });
  await hooks["tool.execute.after"](TOOL_AFTER);
  await hooks.event({ event: IDLE });
  await clock.advance(180000);
  await clock.advance(180000);
  assert.equal(client.calls.prompts.length, 1);
  assert.equal(client.calls.toasts.length, 2);
});

// --- ticket #6: nudge pacing — no instant re-stall after a nudge ---

test("does not re-nudge on immediate session.idle after a nudge; next nudge waits idleTimeoutMs", async () => {
  const { dir, hooks, client, clock } = await makeHooks({ options: { enabled: true } });
  await hooks["tool.execute.after"](TOOL_AFTER);
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 1);
  await hooks.event({ event: IDLE });
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 1);
  assert.match(readFileSync(logPath(dir), "utf8"), /→ skipped \(cooldown\)/);
  await clock.advance(179000);
  assert.equal(client.calls.prompts.length, 1);
  await clock.advance(1000);
  assert.equal(client.calls.prompts.length, 2);
  assert.match(readFileSync(logPath(dir), "utf8"), /→ nudge #2/);
});

// --- ticket #7: cross-instance dedup ---

function makeDeps(clock, pid) {
  return { ...clock, pid };
}

test("skips the nudge while another instance's trace is fresh", async () => {
  const dir = tempDir();
  const clock = fakeClock();
  const clientA = makeClient();
  const clientB = makeClient();
  const a = await StallNudge({ client: clientA, directory: dir }, { enabled: true }, makeDeps(clock, "inst-A"));
  const b = await StallNudge({ client: clientB, directory: dir }, { enabled: true }, makeDeps(clock, "inst-B"));
  await a["tool.execute.after"](TOOL_AFTER);
  await b["tool.execute.after"](TOOL_AFTER);
  await a.event({ event: IDLE });
  await b.event({ event: IDLE });
  assert.equal(clientA.calls.prompts.length, 1);
  assert.equal(clientB.calls.prompts.length, 0);
  assert.match(readFileSync(logPath(dir), "utf8"), /→ skipped \(recent nudge by another instance\)/);
});

test("skips the alert while another instance's trace is fresh", async () => {
  const dir = tempDir();
  const clock = fakeClock();
  const clientA = makeClient();
  const clientB = makeClient();
  const a = await StallNudge(
    { client: clientA, directory: dir },
    { enabled: true, onStall: "alert" },
    makeDeps(clock, "inst-A"),
  );
  const b = await StallNudge(
    { client: clientB, directory: dir },
    { enabled: true, onStall: "alert" },
    makeDeps(clock, "inst-B"),
  );
  await a["tool.execute.after"](TOOL_AFTER);
  await b["tool.execute.after"](TOOL_AFTER);
  await a.event({ event: IDLE });
  await b.event({ event: IDLE });
  assert.equal(clientA.calls.toasts.length, 1);
  assert.equal(clientB.calls.toasts.length, 0);
  assert.match(readFileSync(logPath(dir), "utf8"), /→ skipped \(recent nudge by another instance\)/);
});

test("nudges again once the other instance's trace goes stale", async () => {
  const dir = tempDir();
  const clock = fakeClock();
  const clientA = makeClient();
  const clientB = makeClient();
  const a = await StallNudge({ client: clientA, directory: dir }, { enabled: true }, makeDeps(clock, "inst-A"));
  const b = await StallNudge({ client: clientB, directory: dir }, { enabled: true }, makeDeps(clock, "inst-B"));
  await a["tool.execute.after"](TOOL_AFTER);
  await b["tool.execute.after"](TOOL_AFTER);
  await a.event({ event: IDLE });
  await b.event({ event: IDLE });
  assert.equal(clientB.calls.prompts.length, 0);
  await clock.advance(60000);
  await b.event({ event: IDLE });
  assert.equal(clientB.calls.prompts.length, 1);
});

test("own fresh marker does not block the next nudge", async () => {
  const { hooks, client, clock } = await makeHooks({ options: { enabled: true }, clock: makeDeps(fakeClock(), "solo") });
  await hooks["tool.execute.after"](TOOL_AFTER);
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 1);
  await assistantText(hooks, "работаю");
  await hooks["tool.execute.after"](TOOL_AFTER);
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 2);
});

// --- review fixes: concurrency guard, gen guard, error recovery, bounded tracking ---

test("drops concurrent stall handling while one is already in flight", async () => {
  const client = makeClient();
  let releasePrompt;
  const gate = new Promise((resolve) => {
    releasePrompt = resolve;
  });
  client.session.prompt = async (req) => {
    client.calls.prompts.push(req);
    await gate;
    return {};
  };
  const { hooks, clock } = await makeHooks({ client, options: { enabled: true } });
  await hooks["tool.execute.after"](TOOL_AFTER);
  const first = hooks.event({ event: IDLE });
  const second = hooks.event({ event: IDLE });
  releasePrompt();
  await first;
  await second;
  assert.equal(client.calls.prompts.length, 1);
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 1);
});

test("does not re-arm when the model responds during the nudge prompt", async () => {
  const dir = tempDir();
  const client = makeClient();
  const clock = fakeClock();
  let hooks;
  client.session.prompt = async (req) => {
    client.calls.prompts.push(req);
    await hooks["tool.execute.before"]();
    return {};
  };
  hooks = await StallNudge({ client, directory: dir }, { enabled: true }, clock);
  await hooks["tool.execute.after"](TOOL_AFTER);
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 1);
  await clock.advance(180000);
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 1);
});

test("recovers and retries after a failed nudge prompt", async () => {
  const client = makeClient();
  let fail = true;
  client.session.prompt = async (req) => {
    client.calls.prompts.push(req);
    if (fail) throw new Error("sdk down");
    return {};
  };
  const { hooks, clock } = await makeHooks({ client, options: { enabled: true } });
  await hooks["tool.execute.after"](TOOL_AFTER);
  await clock.advance(180000);
  assert.equal(client.calls.prompts.length, 1);
  fail = false;
  await clock.advance(180000);
  assert.equal(client.calls.prompts.length, 2);
});

test("bounds the assistant message tracking to recent ids", async () => {
  const { hooks, client } = await makeHooks({ options: { enabled: true } });
  await hooks["tool.execute.after"](TOOL_AFTER);
  for (let i = 1; i <= 501; i++) {
    await hooks.event({
      event: { type: "message.updated", properties: { sessionID: "ses_1", info: { id: `msg_${i}`, role: "assistant" } } },
    });
  }
  await hooks.event({
    event: {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: { id: "prt_old", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "вытесненный текст" },
      },
    },
  });
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 1);
});
