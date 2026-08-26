import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StallNudge } from "./plugin.js";

function makeClient(stallNudge) {
  const calls = { prompts: [], toasts: [] };
  const client = {
    config: {
      get: async () => ({ data: { stallNudge } }),
    },
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

function writeStatus(dir, content, stateDir = ".scratch") {
  mkdirSync(join(dir, stateDir), { recursive: true });
  writeFileSync(join(dir, stateDir, "status.txt"), content);
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

const TOOL_AFTER = { type: "tool.execute.after", properties: { sessionID: "ses_1" } };
const IDLE = { type: "session.idle", properties: { sessionID: "ses_1" } };

// --- ticket #2: scaffold + config + logging ---

test("does not write a log and exposes no event hook when disabled", async () => {
  const dir = tempDir();
  const hooks = await StallNudge({ client: makeClient({}), directory: dir });
  assert.deepEqual(hooks, {});
  assert.equal(existsSync(logPath(dir)), false);
});

test("writes a startup line with resolved config defaults when enabled", async () => {
  const dir = tempDir();
  await StallNudge({ client: makeClient({ enabled: true }), directory: dir }, fakeClock());
  const log = readFileSync(logPath(dir), "utf8");
  assert.match(log, /stall-nudge armed/);
  assert.match(log, /idleTimeoutMs=180000/);
  assert.match(log, /maxNudges=3/);
  assert.match(log, /onStall=nudge/);
  assert.match(log, /stateDir=\.scratch/);
});

test("logs each observed event when enabled", async () => {
  const dir = tempDir();
  const hooks = await StallNudge({ client: makeClient({ enabled: true }), directory: dir }, fakeClock());
  await hooks.event({ event: { type: "session.idle" } });
  await hooks.event({ event: { type: "tool.execute.after" } });
  const log = readFileSync(logPath(dir), "utf8");
  assert.match(log, /event session\.idle/);
  assert.match(log, /event tool\.execute\.after/);
});

test("writes the log under a custom stateDir", async () => {
  const dir = tempDir();
  await StallNudge({ client: makeClient({ enabled: true, stateDir: "logs" }), directory: dir }, fakeClock());
  assert.equal(existsSync(logPath(dir, "logs")), true);
  assert.equal(existsSync(logPath(dir, ".scratch")), false);
});

// --- ticket #3: empty-final-turn detection + auto-nudge ---

test("nudges with the configured prompt when the turn ends empty after a tool result", async () => {
  const dir = tempDir();
  const client = makeClient({ enabled: true, nudgePrompt: "Продолжай, пожалуйста" });
  const hooks = await StallNudge({ client, directory: dir }, fakeClock());
  await hooks.event({ event: TOOL_AFTER });
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 1);
  assert.deepEqual(client.calls.prompts[0].path, { id: "ses_1" });
  assert.deepEqual(client.calls.prompts[0].body.parts, [{ type: "text", text: "Продолжай, пожалуйста" }]);
});

test("does not nudge when the model produced text after the tool result", async () => {
  const dir = tempDir();
  const client = makeClient({ enabled: true });
  const hooks = await StallNudge({ client, directory: dir }, fakeClock());
  await hooks.event({ event: TOOL_AFTER });
  await hooks.event({
    event: {
      type: "message.part.updated",
      properties: { info: { role: "assistant" }, part: { type: "text", text: "Готово" } },
    },
  });
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 0);
});

test("does not nudge when status.txt is DONE", async () => {
  const dir = tempDir();
  writeStatus(dir, "DONE");
  const client = makeClient({ enabled: true });
  const hooks = await StallNudge({ client, directory: dir }, fakeClock());
  await hooks.event({ event: TOOL_AFTER });
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 0);
});

test("logs the nudge", async () => {
  const dir = tempDir();
  const client = makeClient({ enabled: true });
  const hooks = await StallNudge({ client, directory: dir }, fakeClock());
  await hooks.event({ event: TOOL_AFTER });
  await hooks.event({ event: IDLE });
  const log = readFileSync(logPath(dir), "utf8");
  assert.match(log, /STALL detected/);
});

// --- ticket #4: hung-turn watchdog + nudge budget ---

test("nudges when the idle timer expires with no model output", async () => {
  const dir = tempDir();
  const client = makeClient({ enabled: true });
  const clock = fakeClock();
  const hooks = await StallNudge({ client, directory: dir }, clock);
  await hooks.event({ event: TOOL_AFTER });
  await clock.advance(180000);
  assert.equal(client.calls.prompts.length, 1);
});

test("resets the nudge budget when the model outputs after a nudge", async () => {
  const dir = tempDir();
  const client = makeClient({ enabled: true });
  const clock = fakeClock();
  const hooks = await StallNudge({ client, directory: dir }, clock);
  await hooks.event({ event: TOOL_AFTER });
  await hooks.event({ event: IDLE });
  await hooks.event({
    event: {
      type: "message.part.updated",
      properties: { info: { role: "assistant" }, part: { type: "text", text: "работаю" } },
    },
  });
  await hooks.event({ event: TOOL_AFTER });
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 2);
});

test("stops nudging after maxNudges without progress", async () => {
  const dir = tempDir();
  const client = makeClient({ enabled: true, maxNudges: 2 });
  const clock = fakeClock();
  const hooks = await StallNudge({ client, directory: dir }, clock);
  await hooks.event({ event: TOOL_AFTER });
  await hooks.event({ event: IDLE });
  await hooks.event({ event: IDLE });
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 2);
});

// --- ticket #5: alert mode + observability + docs ---

test("alert mode only alerts, never nudges", async () => {
  const dir = tempDir();
  const client = makeClient({ enabled: true, onStall: "alert" });
  const hooks = await StallNudge({ client, directory: dir }, fakeClock());
  await hooks.event({ event: TOOL_AFTER });
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 0);
  assert.equal(client.calls.toasts.length, 1);
});

test("both mode nudges and alerts", async () => {
  const dir = tempDir();
  const client = makeClient({ enabled: true, onStall: "both" });
  const hooks = await StallNudge({ client, directory: dir }, fakeClock());
  await hooks.event({ event: TOOL_AFTER });
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 1);
  assert.equal(client.calls.toasts.length, 1);
});

test("writes the stall log line in the agreed format", async () => {
  const dir = tempDir();
  const client = makeClient({ enabled: true });
  const hooks = await StallNudge({ client, directory: dir }, fakeClock());
  await hooks.event({ event: TOOL_AFTER });
  await hooks.event({ event: IDLE });
  const log = readFileSync(logPath(dir), "utf8");
  assert.match(log, /STALL detected \(age=\d+s\) → nudge #1/);
});

test("alerts after the nudge budget is exhausted", async () => {
  const dir = tempDir();
  const client = makeClient({ enabled: true, maxNudges: 1 });
  const hooks = await StallNudge({ client, directory: dir }, fakeClock());
  await hooks.event({ event: TOOL_AFTER });
  await hooks.event({ event: IDLE });
  await hooks.event({ event: IDLE });
  await hooks.event({ event: IDLE });
  assert.equal(client.calls.prompts.length, 1);
  assert.equal(client.calls.toasts.length, 2);
});
