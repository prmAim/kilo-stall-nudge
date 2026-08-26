import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const DEFAULTS = {
  enabled: false,
  stateDir: ".scratch",
  idleTimeoutMs: 180000,
  maxNudges: 3,
  onStall: "nudge",
  nudgePrompt:
    "Продолжи с Next step из .scratch/state.md: сначала прочитай state.md и worklog.md, затем допиши heartbeat в worklog.md и выполни следующий шаг.",
};

const StallNudge = async (ctx, options = {}, deps = {}) => {
  const { client, directory } = ctx;
  const config = readConfig(options);

  if (!config.enabled) {
    return {};
  }

  const base = directory || process.cwd();
  const logPath = join(base, config.stateDir, "plugin.log");
  const log = (line) => appendLog(logPath, line);

  const now = deps.now ?? (() => Date.now());
  const setTimeoutFn = deps.setTimeout ?? globalThis.setTimeout;
  const clearTimeoutFn = deps.clearTimeout ?? globalThis.clearTimeout;

  const state = { armed: false, sessionID: null, nudgeCount: 0, timer: null, armTime: 0 };

  const ts = () => new Date(now()).toISOString();

  await log(
    `[${ts()}] stall-nudge armed enabled=true stateDir=${config.stateDir} idleTimeoutMs=${config.idleTimeoutMs} maxNudges=${config.maxNudges} onStall=${config.onStall}`,
  );

  const isDone = async () => {
    try {
      const content = await readFile(join(base, config.stateDir, "status.txt"), "utf8");
      return content.trim() === "DONE";
    } catch {
      return false;
    }
  };

  const clearTimer = () => {
    if (state.timer != null) {
      clearTimeoutFn(state.timer);
      state.timer = null;
    }
  };

  const disarm = () => {
    state.armed = false;
    state.nudgeCount = 0;
    clearTimer();
  };

  const handleStall = async () => {
    const ageS = Math.round((now() - state.armTime) / 1000);
    const base = `[${ts()}] STALL detected (age=${ageS}s)`;

    if (await isDone()) {
      await log(`${base} → skipped (DONE)`);
      disarm();
      return;
    }

    const wantsNudge = config.onStall !== "alert";
    const wantsAlert = config.onStall !== "nudge";
    const budgetLeft = state.nudgeCount < config.maxNudges;

    if (wantsNudge && budgetLeft) {
      state.nudgeCount += 1;
      await client.session.prompt({
        path: { id: state.sessionID },
        body: { parts: [{ type: "text", text: config.nudgePrompt }] },
      });
      await log(`${base} → nudge #${state.nudgeCount}`);
      if (wantsAlert) {
        await client.tui.showToast({
          body: { message: `STALL detected → nudge #${state.nudgeCount}`, variant: "warning" },
        });
      }
      arm();
      return;
    }

    await client.tui.showToast({
      body: { message: "STALL detected: session stalled", variant: "warning" },
    });
    await log(`${base} → alert (no nudge)`);
    arm();
  };

  const arm = () => {
    state.armed = true;
    state.armTime = now();
    clearTimer();
    state.timer = setTimeoutFn(() => {
      state.timer = null;
      if (state.armed) return handleStall();
    }, config.idleTimeoutMs);
  };

  return {
    "tool.execute.after": async (input) => {
      state.sessionID = input?.sessionID ?? state.sessionID;
      arm();
    },
    "tool.execute.before": async () => {
      disarm();
    },
    event: async ({ event }) => {
      switch (event.type) {
        case "message.part.updated":
          if (isAssistantText(event)) disarm();
          break;
        case "session.idle":
          state.sessionID = event.properties?.sessionID ?? state.sessionID;
          if (state.armed) await handleStall();
          break;
      }
    },
  };
};

function isAssistantText(event) {
  const properties = event.properties ?? {};
  const info = properties.info ?? {};
  const part = properties.part ?? {};
  if (info.role !== "assistant") return false;
  return part.type === "text" && (part.text ?? "").trim() !== "";
}

function readConfig(options) {
  const c = options ?? {};
  return {
    enabled: c.enabled ?? DEFAULTS.enabled,
    stateDir: c.stateDir ?? DEFAULTS.stateDir,
    idleTimeoutMs: c.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
    maxNudges: c.maxNudges ?? DEFAULTS.maxNudges,
    onStall: c.onStall ?? DEFAULTS.onStall,
    nudgePrompt: c.nudgePrompt ?? DEFAULTS.nudgePrompt,
  };
}

async function appendLog(logPath, line) {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, line + "\n", "utf8");
}

export { StallNudge };
export default { id: "stall-nudge", server: StallNudge };
