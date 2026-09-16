import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const DEFAULTS = {
  enabled: false,
  stateDir: ".scratch",
  idleTimeoutMs: 180000,
  maxNudges: 3,
  onStall: "nudge",
  dedupWindowMs: 60000,
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
  const markerPath = join(base, config.stateDir, "nudge.marker");
  const log = (line) => appendLog(logPath, line);

  const now = deps.now ?? (() => Date.now());
  const setTimeoutFn = deps.setTimeout ?? globalThis.setTimeout;
  const clearTimeoutFn = deps.clearTimeout ?? globalThis.clearTimeout;
  const pid = deps.pid ?? process.pid;

  const state = { armed: false, sessionID: null, nudgeCount: 0, timer: null, armTime: 0, cooldownUntil: 0, gen: 0 };
  const assistantMessages = new Set();
  const MAX_TRACKED_ASSISTANT_MESSAGES = 500;
  let handlingStall = false;

  const ts = () => new Date(now()).toISOString();

  await log(
    `[${ts()}] stall-nudge armed enabled=true stateDir=${config.stateDir} idleTimeoutMs=${config.idleTimeoutMs} maxNudges=${config.maxNudges} onStall=${config.onStall} dedupWindowMs=${config.dedupWindowMs}`,
  );

  const isDone = async () => {
    try {
      const content = await readFile(join(base, config.stateDir, "status.txt"), "utf8");
      return content.trim() === "DONE";
    } catch {
      return false;
    }
  };

  const isWaitingForHuman = async () => {
    try {
      const content = await readFile(join(base, config.stateDir, "state.md"), "utf8");
      return content.includes("WAITING_FOR_HUMAN");
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
    state.cooldownUntil = 0;
    state.gen += 1;
    clearTimer();
  };

  const readRecentNudge = async () => {
    try {
      const [tsPart, markerPid] = (await readFile(markerPath, "utf8")).trim().split(/\s+/);
      const markerTs = Number(tsPart);
      if (!Number.isFinite(markerTs)) return null;
      if (String(markerPid) === String(pid)) return null;
      return markerTs;
    } catch {
      return null;
    }
  };

  const writeNudgeMarker = async () => {
    try {
      await mkdir(dirname(markerPath), { recursive: true });
      await writeFile(markerPath, `${now()} ${pid}\n`, "utf8");
    } catch {
      return;
    }
  };

  const processStall = async () => {
    const ageS = Math.round((now() - state.armTime) / 1000);
    const base = `[${ts()}] STALL detected (age=${ageS}s)`;

    if (await isDone()) {
      await log(`${base} → skipped (DONE)`);
      disarm();
      return;
    }

    if (await isWaitingForHuman()) {
      await log(`${base} → skipped (WAITING_FOR_HUMAN)`);
      disarm();
      return;
    }

    if (now() < state.cooldownUntil) {
      await log(`${base} → skipped (cooldown)`);
      return;
    }

    const otherNudgeTs = await readRecentNudge();
    if (otherNudgeTs != null && now() - otherNudgeTs < config.dedupWindowMs) {
      await log(`${base} → skipped (recent nudge by another instance)`);
      arm();
      return;
    }

    const wantsNudge = config.onStall !== "alert";
    const wantsAlert = config.onStall !== "nudge";
    const budgetLeft = state.nudgeCount < config.maxNudges;

    if (wantsNudge && budgetLeft) {
      state.nudgeCount += 1;
      const nudgeNumber = state.nudgeCount;
      state.cooldownUntil = now() + config.idleTimeoutMs;
      await writeNudgeMarker();
      const genBeforePrompt = state.gen;
      await client.session.prompt({
        path: { id: state.sessionID },
        body: { parts: [{ type: "text", text: config.nudgePrompt }] },
      });
      await log(`${base} → nudge #${nudgeNumber}`);
      if (wantsAlert) {
        await client.tui.showToast({
          body: { message: `STALL detected → nudge #${nudgeNumber}`, variant: "warning" },
        });
      }
      if (state.gen === genBeforePrompt) arm();
      return;
    }

    state.cooldownUntil = now() + config.idleTimeoutMs;
    const genBeforeToast = state.gen;
    await client.tui.showToast({
      body: { message: "STALL detected: session stalled", variant: "warning" },
    });
    await log(`${base} → alert (no nudge)`);
    if (state.gen === genBeforeToast) arm();
  };

  const handleStall = async () => {
    if (handlingStall) return;
    handlingStall = true;
    try {
      await processStall();
    } catch (error) {
      await log(`[${ts()}] stall-nudge error: ${error?.message ?? String(error)}`);
      arm();
    } finally {
      handlingStall = false;
    }
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
        case "message.updated":
          if (event.properties?.info?.role === "assistant") {
            const id = event.properties.info.id;
            if (!assistantMessages.has(id) && assistantMessages.size >= MAX_TRACKED_ASSISTANT_MESSAGES) {
              assistantMessages.delete(assistantMessages.values().next().value);
            }
            assistantMessages.add(id);
          }
          break;
        case "message.part.updated":
          if (isAssistantText(event, assistantMessages)) disarm();
          break;
        case "session.idle":
          state.sessionID = event.properties?.sessionID ?? state.sessionID;
          if (state.armed) await handleStall();
          break;
      }
    },
  };
};

function isAssistantText(event, assistantMessages) {
  const part = event.properties?.part ?? {};
  if (part.type !== "text") return false;
  if (!(part.text ?? "").trim()) return false;
  return assistantMessages.has(part.messageID);
}

function readConfig(options) {
  const c = options ?? {};
  return {
    enabled: c.enabled ?? DEFAULTS.enabled,
    stateDir: c.stateDir ?? DEFAULTS.stateDir,
    idleTimeoutMs: c.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
    maxNudges: c.maxNudges ?? DEFAULTS.maxNudges,
    onStall: c.onStall ?? DEFAULTS.onStall,
    dedupWindowMs: c.dedupWindowMs ?? DEFAULTS.dedupWindowMs,
    nudgePrompt: c.nudgePrompt ?? DEFAULTS.nudgePrompt,
  };
}

async function appendLog(logPath, line) {
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, line + "\n", "utf8");
  } catch {}
}

export { StallNudge };
export default { id: "stall-nudge", server: StallNudge };
