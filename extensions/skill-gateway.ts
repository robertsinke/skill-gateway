import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultRoots, search, searchRoots } from "../src/search.ts";
import { buildSkillGateRequest, SKILL_GATE_THRESHOLD, type GateCandidate } from "../src/skill-gate.ts";
import { record, userId } from "../src/query-log.ts";
import { verifiedSkillNames } from "../src/skill-load-hook.ts";
import { appendUsageEvent, DEFAULT_USAGE_EVENTS, promptDigest } from "../src/usage-events.ts";
import { findLatestGateEvent, formatGateDetails, formatGateFooter, sumRecordedGateCosts } from "../src/pi-gate-telemetry.ts";
import { createFeedbackWidget } from "../src/pi-feedback-widget.ts";
import { searchSkillUsageTurns, updateSkillUsageFeedback } from "../src/skill-usage-feedback.ts";
import { findActiveSkillCompletion, nativeSkillCommand, parseSkillSelection, skillCompletions } from "../src/picker-contract.ts";

type SuggestionPayload = {
  results: { name: string; description: string }[];
};

const endpoint = process.env.SKILL_GATEWAY_MCP_URL || "http://127.0.0.1:8742/mcp";
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/g;
const autocompleteItemCount = 20;
const nonSelectablePrefix = "__skill_gateway_padding__";

function parseSuggestions(result: unknown): SuggestionPayload {
  if (!result || typeof result !== "object") throw new Error("gateway returned an invalid suggestion response");
  const response = result as { isError?: unknown; content?: unknown; structuredContent?: unknown };
  if (response.isError) {
    const details = Array.isArray(response.content)
      ? response.content.map((item: unknown) => item && typeof item === "object" && "text" in item && typeof item.text === "string" ? item.text : "").filter(Boolean).join("\n")
      : "";
    throw new Error(details || "gateway rejected skill suggestions");
  }
  const data = response.structuredContent as Partial<SuggestionPayload> | undefined;
  if (!data || !Array.isArray(data.results)) throw new Error("gateway returned an invalid suggestion response");
  const results = data.results.filter((item): item is { name: string; description: string } =>
    Boolean(item) && typeof item.name === "string" && typeof item.description === "string",
  );
  return { results };
}

function failureMessage(error: unknown): string {
  const details = error instanceof Error ? error.message : String(error);
  return `Skill Gateway unavailable at ${endpoint}: ${details}`;
}

export function fixedHeightAutocompleteItems(items: { value: string; label: string; description?: string }[]) {
  const result = items.slice(0, autocompleteItemCount);
  if (result.length === 0) {
    result.push({ value: `${nonSelectablePrefix}empty`, label: "No matching skills" });
  }
  while (result.length < autocompleteItemCount) {
    result.push({ value: `${nonSelectablePrefix}${result.length}`, label: " " });
  }
  return result;
}

type GateDebug = {
  prompt: string;
  promptSha256: string;
  candidates: GateCandidate[];
  event?: Record<string, unknown>;
  candidatesMatch?: boolean;
};

function gateCandidates(prompt: string): GateCandidate[] {
  const root = process.env.SKILL_GATEWAY_ROOT?.trim();
  const hits = root ? search(root, prompt, 5) : searchRoots(defaultRoots(), prompt, 5);
  return hits.slice(0, 5).map(({ name, description }) => ({ name, description }));
}

function readRecentUsageEvents(path: string, maxBytes = 1_000_000): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    if (length > 0) readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function currentGateEvent(sessionId: string, promptSha256: string): Record<string, unknown> | null {
  const path = process.env.SKILL_GATEWAY_EVENTS ?? DEFAULT_USAGE_EVENTS;
  if (!path || path === "-") return null;
  try {
    return findLatestGateEvent(readRecentUsageEvents(path), sessionId, promptSha256);
  } catch {
    return null;
  }
}

function cumulativeGateCost(): { total: number; includes_estimates: boolean } | null {
  const path = process.env.SKILL_GATEWAY_EVENTS ?? DEFAULT_USAGE_EVENTS;
  if (!path || path === "-") return null;
  try {
    return sumRecordedGateCosts(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function recordedCandidateNames(event: Record<string, unknown>): string[] {
  return Array.isArray(event.candidate_names) ? event.candidate_names.filter((name): name is string => typeof name === "string") : [];
}

type FeedbackIdentity = { user_id: string | null; session_id: string; turn_id: string };
type PendingQueuedInput = {
  prompt: string;
  deliveredText: string;
  behavior: "steer" | "followUp";
  identity: FeedbackIdentity;
};
type PendingSkillRead = {
  identity: FeedbackIdentity;
  turn_id_source: string;
  tool_name: string;
  skill_names: string[];
};

function userMessageText(message: unknown): string {
  if (!message || typeof message !== "object" || !("content" in message)) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => item && typeof item === "object" && "type" in item && item.type === "text"
    && "text" in item && typeof item.text === "string" ? [item.text] : []).join("");
}

function exactQueuedInputIndex(queue: PendingQueuedInput[], text: string): number {
  const matching = queue.map((item, index) => ({ item, index })).filter(({ item }) => item.deliveredText === text);
  return (matching.find(({ item }) => item.behavior === "steer") ?? matching[0])?.index ?? -1;
}

function takeQueuedInput(queue: PendingQueuedInput[], text: string, allowOrderedFallback = false): PendingQueuedInput | undefined {
  const exactIndex = exactQueuedInputIndex(queue, text);
  const index = exactIndex >= 0 ? exactIndex : (allowOrderedFallback && queue.length > 0 ? 0 : -1);
  if (index < 0) return undefined;
  const queued = queue.splice(index, 1)[0];
  return queued ? { ...queued, prompt: text } : undefined;
}

function queuedPromptDebug(prompt: string, identity: FeedbackIdentity): GateDebug {
  const reason = "queued_prompt_not_gated";
  const event: Record<string, unknown> = {
    event_type: "gate_decision",
    user_id: identity.user_id,
    session_id: identity.session_id,
    turn_id: identity.turn_id,
    turn_id_source: "pi_queued_input",
    platform: "pi",
    prompt_sha256: promptDigest(prompt),
    candidate_names: [],
    candidate_rankings: [],
    gate_status: "not_evaluated",
    gate_model: null,
    probability: null,
    threshold: SKILL_GATE_THRESHOLD,
    injected_skill_names: [],
    request_attempted: false,
    input_tokens_source: "not_sent",
    jev_list_cost_usd: null,
    cost_basis: "not_sent",
    latency_ms: 0,
    reason,
  };
  return { prompt, promptSha256: promptDigest(prompt), candidates: [], event, candidatesMatch: true };
}

function recordQueuedPrompt(prompt: string, identity: FeedbackIdentity, event: Record<string, unknown>): void {
  const audit = { status: "not_evaluated" as const, model: null, probability: null, candidates: [], reason: "queued_prompt_not_gated" };
  record({ ...identity, agent: "pi" }, prompt, [], process.env, audit);
  appendUsageEvent(event);
}

function feedbackIdentity(event: Record<string, unknown> | undefined): FeedbackIdentity | null {
  if (!event || typeof event.session_id !== "string" || !event.session_id.trim() || typeof event.turn_id !== "string" || !event.turn_id.trim()) return null;
  if (event.user_id !== undefined && event.user_id !== null && typeof event.user_id !== "string") return null;
  return {
    user_id: typeof event.user_id === "string" ? event.user_id : null,
    session_id: event.session_id,
    turn_id: event.turn_id,
  };
}

function currentTurn(identity: FeedbackIdentity) {
  return searchSkillUsageTurns({ ...identity, limit: 1 }).results[0] ?? null;
}

function recordedInjectedNames(event: Record<string, unknown> | undefined): string[] {
  return Array.isArray(event?.injected_skill_names)
    ? [...new Set(event.injected_skill_names.filter((name): name is string => typeof name === "string" && name.length > 0))]
    : [];
}

function isSkillReadTool(toolName: string, args: unknown): boolean {
  const normalized = toolName.toLowerCase().split("__").at(-1)?.trim() ?? "";
  if (["skill", "skills_read_skill", "read_skill", "load_skill", "skills.load", "skill_read"].includes(normalized)
    || normalized.includes("read_skill") || normalized.includes("load_skill")) return true;
  if (normalized !== "read" && normalized !== "read_file") return false;
  const input = typeof args === "string" ? (() => {
    try { return JSON.parse(args) as unknown; } catch { return null; }
  })() : args;
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  return Object.entries(input).some(([key, value]) =>
    /(?:path|file)$/i.test(key)
      && typeof value === "string"
      && /(?:^|[\\/])(?:library|skills)[\\/][A-Za-z0-9_.-]+[\\/]SKILL\.md$/i.test(value),
  );
}

function showFeedbackWidget(
  ctx: ExtensionContext,
  debug: GateDebug,
  agentReadsPending = false,
  widgetName = "skill-gateway-feedback",
  onComplete?: () => void,
): void {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  const identity = feedbackIdentity(debug.event);
  const injectedNames = recordedInjectedNames(debug.event);
  if (!identity) {
    ctx.ui.setWidget(widgetName, undefined);
    return;
  }
  const turn = currentTurn(identity);
  const state = {
    injected_skill_names: injectedNames,
    agent_loaded_skill_names: turn?.loaded_injected_skill_names ?? [],
    agent_reads_pending: agentReadsPending,
    injection_decision: turn?.feedback?.injection_decision ?? null,
    user_skill_feedback: turn?.feedback?.user_skill_feedback ?? [],
  };
  ctx.ui.setWidget(widgetName, (_tui: unknown, _theme: unknown) => createFeedbackWidget(
    state,
    () => void collectSkillFeedback(
      ctx,
      identity,
      debug,
      () => showFeedbackWidget(ctx, debug, agentReadsPending, widgetName, onComplete),
      onComplete,
    ),
  ), { placement: "aboveEditor" });
}

async function collectSkillFeedback(
  ctx: ExtensionContext,
  identity: FeedbackIdentity,
  debug: GateDebug,
  refresh: () => void,
  onComplete?: () => void,
): Promise<void> {
  const injectedNames = recordedInjectedNames(debug.event);
  try {
    const turn = currentTurn(identity);
    const previousDecision = turn?.feedback?.injection_decision ?? null;
    let injectionDecision = previousDecision;
    const decisionOptions = ["Yes", "No", "Unsure", "Skip"];
    if (previousDecision !== null) decisionOptions.push("Clear prior answer");
    const decisionChoice = await ctx.ui.select("Should any skills have been injected for this turn?", decisionOptions);
    if (!decisionChoice) return;
    if (decisionChoice === "Yes") injectionDecision = "yes";
    else if (decisionChoice === "No") injectionDecision = "no";
    else if (decisionChoice === "Unsure") injectionDecision = "unsure";
    else if (decisionChoice === "Clear prior answer") injectionDecision = null;

    const previous = turn?.feedback?.user_skill_feedback ?? [];
    const labels = new Map(previous.map((item) => [item.skill_name, item.relevance]));
    const agentLoaded = new Set(turn?.loaded_injected_skill_names ?? []);
    for (const skillName of injectedNames) {
      const options = ["Relevant", "Not relevant", "Unsure", "Skip"];
      if (labels.has(skillName)) options.push("Clear prior label");
      const choice = await ctx.ui.select(
        `Was ${skillName} relevant? Agent explicitly read it: ${agentLoaded.has(skillName) ? "yes" : "no"} (behavior proxy only).`,
        options,
      );
      if (!choice) return;
      if (choice === "Relevant") labels.set(skillName, "relevant");
      else if (choice === "Not relevant") labels.set(skillName, "not_relevant");
      else if (choice === "Unsure") labels.set(skillName, "unsure");
      else if (choice === "Clear prior label") labels.delete(skillName);
    }
    const userSkillFeedback = injectedNames.flatMap((skill_name) => {
      const relevance = labels.get(skill_name);
      return relevance ? [{ skill_name, relevance }] : [];
    });
    if (previousDecision === injectionDecision && JSON.stringify(previous) === JSON.stringify(userSkillFeedback)) {
      ctx.ui.notify("No skill feedback changed.", "info");
      refresh();
      onComplete?.();
      return;
    }
    const result = updateSkillUsageFeedback({ ...identity, injection_decision: injectionDecision, user_skill_feedback: userSkillFeedback });
    ctx.ui.notify(result.status === "unchanged" ? "Skill feedback is already saved." : "Saved injection and per-skill feedback locally.", "info");
    refresh();
    onComplete?.();
  } catch (error) {
    ctx.ui.notify(`Could not save per-skill feedback: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

function showSkillFeedbackCommand(
  pi: ExtensionAPI,
  getDebug: () => GateDebug | undefined,
  onComplete: (identity: FeedbackIdentity) => void = () => {},
): void {
  pi.registerCommand("skill-feedback", {
    description: "Rate whether any skills should have been injected, then rate each injected skill against verified agent reads",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const debug = getDebug();
      const identity = feedbackIdentity(debug?.event);
      if (!debug || !identity) {
        ctx.ui.notify("No exactly linked skill-gate decision is available for this turn.", "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("Skill feedback requires interactive Pi UI mode.", "warning");
        return;
      }
      await collectSkillFeedback(ctx, identity, debug, () => showFeedbackWidget(ctx, debug), () => onComplete(identity));
    },
  });
}

function showGateDetails(pi: ExtensionAPI, getDebug: () => GateDebug | undefined): void {
  pi.registerCommand("skill-gate", {
    description: "Inspect this turn's skill-gate request and retrieval scores",
    handler: async (_args, ctx) => {
      const debug = getDebug();
      if (!debug?.event) {
        ctx.ui.notify("No matching skill-gate event for the current Pi turn.", "warning");
        return;
      }
      const event = debug.event;
      const body = debug.candidatesMatch && event.gate_status !== "no_candidates" && event.gate_status !== "bypassed" && event.gate_status !== "not_evaluated"
        ? buildSkillGateRequest(debug.prompt, debug.candidates)
        : null;
      const cumulative = cumulativeGateCost();
      const details = formatGateDetails(event, body, Boolean(debug.candidatesMatch), cumulative);
      if (ctx.hasUI && ctx.mode === "tui") ctx.ui.setStatus("skill-gateway-gate", formatGateFooter(event, cumulative));
      if (!ctx.hasUI) {
        ctx.ui.notify("The skill-gate details view requires interactive Pi TUI mode.", "warning");
        return;
      }
      let tuiComponents;
      try {
        tuiComponents = await import("@earendil-works/pi-tui");
      } catch {
        ctx.ui.notify(details.slice(0, 3_000), "warning");
        return;
      }
      const { Key, Text, matchesKey } = tuiComponents;
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const content = new Text(details, 1, 1);
        let scrollTop = 0;
        let renderedLineCount = 0;
        const pageSize = 14;
        return {
          render(width: number): string[] {
            const lines = content.render(Math.max(10, width - 2));
            renderedLineCount = lines.length;
            scrollTop = Math.min(scrollTop, Math.max(0, renderedLineCount - pageSize));
            const end = Math.min(scrollTop + pageSize, renderedLineCount);
            return [
              theme.fg("accent", "Skill Gateway · ↑/↓ scroll · Esc/Enter close"),
              ...lines.slice(scrollTop, end),
              theme.fg("dim", `${scrollTop + 1}-${end} / ${renderedLineCount}`),
            ];
          },
          handleInput(data: string): void {
            if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, "q")) {
              done();
              return;
            }
            if (matchesKey(data, Key.up)) scrollTop = Math.max(0, scrollTop - 1);
            else if (matchesKey(data, Key.down)) scrollTop = Math.min(Math.max(0, renderedLineCount - pageSize), scrollTop + 1);
            else if (matchesKey(data, Key.pageUp)) scrollTop = Math.max(0, scrollTop - pageSize);
            else if (matchesKey(data, Key.pageDown)) scrollTop = Math.min(Math.max(0, renderedLineCount - pageSize), scrollTop + pageSize);
            else return;
            tui.requestRender();
          },
          invalidate(): void {
            content.invalidate();
          },
        };
      });
    },
  });
}

export function applyBackslashCompletion(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  item: { value: string },
  prefix: string,
) {
  const line = lines[cursorLine] ?? "";
  const active = findActiveSkillCompletion(line, cursorCol);
  if (!active || active.prefix !== prefix) return { lines, cursorLine, cursorCol };
  const suffix = line.slice(active.replaceEnd);
  const hasTrailingWhitespace = /^\s/.test(suffix);
  const insertion = `${item.value}${hasTrailingWhitespace ? "" : " "}`;
  const newLines = [...lines];
  newLines[cursorLine] = `${line.slice(0, active.start)}${insertion}${suffix}`;
  return {
    lines: newLines,
    cursorLine,
    cursorCol: active.start + insertion.length + (hasTrailingWhitespace ? 1 : 0),
  };
}

export default function (pi: ExtensionAPI): void {
  pi.registerMcpServer("skill_gateway", { url: endpoint, timeout: 5_000 });
  let gateDebug: GateDebug | undefined;
  let gatedStartingMessagePending = false;
  const completedFeedbackTurns = new Set<string>();
  const pendingFeedbackWidgets = new Map<string, string>();
  const clearPendingFeedbackWidgets = (ctx: ExtensionContext): void => {
    if (ctx.hasUI && ctx.mode === "tui") {
      for (const widgetName of pendingFeedbackWidgets.values()) ctx.ui.setWidget(widgetName, undefined);
    }
    pendingFeedbackWidgets.clear();
  };
  const markFeedbackComplete = (identity: FeedbackIdentity): void => { completedFeedbackTurns.add(identity.turn_id); };
  const showCurrentFeedback = (ctx: ExtensionContext, debug: GateDebug, agentReadsPending = false): void => {
    const identity = feedbackIdentity(debug.event);
    showFeedbackWidget(ctx, debug, agentReadsPending, "skill-gateway-feedback", identity ? () => markFeedbackComplete(identity) : undefined);
  };
  const preserveFeedback = (ctx: ExtensionContext, debug: GateDebug): void => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    const identity = feedbackIdentity(debug.event);
    if (!identity || completedFeedbackTurns.has(identity.turn_id) || pendingFeedbackWidgets.has(identity.turn_id)) return;
    try {
      const turn = currentTurn(identity);
      const decision = turn?.feedback?.injection_decision;
      const labels = new Set((turn?.feedback?.user_skill_feedback ?? []).map(({ skill_name }) => skill_name));
      if (decision !== null && decision !== undefined && recordedInjectedNames(debug.event).every((name) => labels.has(name))) {
        completedFeedbackTurns.add(identity.turn_id);
        return;
      }
    } catch {
      // Keep the form accessible if reading prior feedback fails.
    }
    const widgetName = `skill-gateway-feedback-pending-${identity.turn_id}`;
    pendingFeedbackWidgets.set(identity.turn_id, widgetName);
    showFeedbackWidget(ctx, debug, false, widgetName, () => {
      markFeedbackComplete(identity);
      pendingFeedbackWidgets.delete(identity.turn_id);
      ctx.ui.setWidget(widgetName, undefined);
    });
  };
  const pendingQueuedInputs: PendingQueuedInput[] = [];
  const pendingSkillReads = new Map<string, PendingSkillRead>();
  const queueInput = (prompt: string, deliveredText: string, behavior: "steer" | "followUp", ctx: ExtensionContext): void => {
    const session_id = ctx.sessionManager.getSessionId();
    if (!session_id || !prompt.trim()) return;
    pendingQueuedInputs.push({
      prompt: prompt.trim(),
      deliveredText,
      behavior,
      identity: { user_id: userId({}, process.env), session_id, turn_id: randomUUID() },
    });
  };
  showSkillFeedbackCommand(pi, () => gateDebug, markFeedbackComplete);

  pi.on("before_agent_start", (event, ctx) => {
    clearPendingFeedbackWidgets(ctx);
    completedFeedbackTurns.clear();
    if (ctx.hasUI && ctx.mode === "tui") ctx.ui.setWidget("skill-gateway-feedback", undefined);
    const rawPrompt = "prompt" in event && typeof event.prompt === "string" ? event.prompt : "";
    if (!rawPrompt.trim()) {
      gateDebug = undefined;
      gatedStartingMessagePending = false;
      if (ctx.hasUI) ctx.ui.setStatus("skill-gateway-gate", undefined);
      return;
    }
    gatedStartingMessagePending = true;
    if (ctx.hasUI) ctx.ui.setStatus("skill-gateway-gate", "SG evaluating…");
    const prompt = rawPrompt.trim();
    try {
      gateDebug = { prompt, promptSha256: promptDigest(prompt), candidates: gateCandidates(rawPrompt) };
    } catch {
      gateDebug = { prompt, promptSha256: promptDigest(prompt), candidates: [] };
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!gateDebug) return;
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) {
      if (ctx.hasUI) ctx.ui.setStatus("skill-gateway-gate", "SG gate event unavailable");
      return;
    }
    const event = currentGateEvent(sessionId, gateDebug.promptSha256);
    if (!event) {
      gateDebug = undefined;
      if (ctx.hasUI) ctx.ui.setStatus("skill-gateway-gate", "SG gate event unavailable");
      return;
    }
    const localNames = gateDebug.candidates.map(({ name }) => name);
    const eventNames = recordedCandidateNames(event);
    gateDebug = { ...gateDebug, event, candidatesMatch: JSON.stringify(localNames) === JSON.stringify(eventNames) };
    if (ctx.hasUI && ctx.mode === "tui") {
      ctx.ui.setStatus("skill-gateway-gate", formatGateFooter(event, cumulativeGateCost()));
      showCurrentFeedback(ctx, gateDebug, true);
    }
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "user") return;
    const deliveredText = userMessageText(event.message);
    if (gatedStartingMessagePending) {
      gatedStartingMessagePending = false;
      const startingMirrorIndex = exactQueuedInputIndex(pendingQueuedInputs, deliveredText);
      takeQueuedInput(pendingQueuedInputs, deliveredText);
      if (startingMirrorIndex < 0) pendingQueuedInputs.length = 0;
      else pendingQueuedInputs.splice(0, startingMirrorIndex);
      return;
    }
    const queued = takeQueuedInput(pendingQueuedInputs, deliveredText, true);
    if (!queued) return;
    if (gateDebug?.event) preserveFeedback(ctx, gateDebug);
    gateDebug = queuedPromptDebug(queued.prompt, queued.identity);
    try {
      recordQueuedPrompt(queued.prompt, queued.identity, gateDebug.event!);
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`Could not record queued prompt feedback: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
    if (ctx.hasUI && ctx.mode === "tui") {
      ctx.ui.setStatus("skill-gateway-gate", formatGateFooter(gateDebug.event!, cumulativeGateCost()));
      showCurrentFeedback(ctx, gateDebug, true);
    }
  });

  pi.on("tool_execution_start", (event) => {
    const identity = feedbackIdentity(gateDebug?.event);
    if (!identity) return;
    const skill_names = verifiedSkillNames(event.toolName, event.args);
    if (!skill_names.length) return;
    const eventTurnIdSource = typeof gateDebug?.event?.turn_id_source === "string" ? gateDebug.event.turn_id_source : "pi_extension_event";
    pendingSkillReads.set(event.toolCallId, { identity, turn_id_source: eventTurnIdSource, tool_name: event.toolName, skill_names });
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const read = pendingSkillReads.get(event.toolCallId);
    pendingSkillReads.delete(event.toolCallId);
    if (read && !event.isError) {
      for (const skill_name of read.skill_names) {
        try {
          appendUsageEvent({
            event_type: "skill_load",
            ...read.identity,
            turn_id_source: read.turn_id_source,
            platform: "pi",
            tool_name: read.tool_name,
            tool_call_id: event.toolCallId,
            skill_name,
            source: "pi_extension_tool_execution",
          });
        } catch {
          // A failed telemetry write must not affect the completed tool call.
        }
      }
    }
    if (gateDebug?.event && (read || isSkillReadTool(event.toolName, undefined))) {
      showCurrentFeedback(ctx, gateDebug, true);
    }
  });

  showGateDetails(pi, () => gateDebug);


  let clientPromise: Promise<Client> | undefined;
  let notify: ((message: string) => void) | undefined;
  let failureShown = false;

  const getClient = (): Promise<Client> => {
    clientPromise ??= (async () => {
      const client = new Client({ name: "skill-gateway-pi-picker", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(endpoint));
      await client.connect(transport);
      return client;
    })();
    return clientPromise;
  };

  const showFailure = (error: unknown): void => {
    if (failureShown) return;
    failureShown = true;
    notify?.(failureMessage(error));
  };

  const suggest = async (query: string, signal?: AbortSignal): Promise<SuggestionPayload["results"]> => {
    const client = await getClient();
    const result = await client.callTool({
      name: "skills_suggest_library",
      arguments: { query, limit: 20 },
    }, undefined, { signal, timeout: 5_000 });
    return parseSuggestions(result).results;
  };

  pi.on("turn_end", (_event, ctx) => {
    if (gateDebug?.event) showCurrentFeedback(ctx, gateDebug, false);
  });

  pi.on("resources_discover", () => ({
    skillPaths: process.env.SKILL_GATEWAY_ROOT?.trim()
      ? [process.env.SKILL_GATEWAY_ROOT.trim()]
      : defaultRoots(),
  }));

  pi.on("session_start", (_event, ctx) => {
    failureShown = false;
    gateDebug = undefined;
    gatedStartingMessagePending = false;
    pendingQueuedInputs.length = 0;
    pendingSkillReads.clear();
    completedFeedbackTurns.clear();
    clearPendingFeedbackWidgets(ctx);
    if (ctx.hasUI && ctx.mode === "tui") ctx.ui.setWidget("skill-gateway-feedback", undefined);
    if (ctx.hasUI) ctx.ui.setStatus("skill-gateway-gate", undefined);
    notify = ctx.hasUI ? (message) => ctx.ui.notify(message, "error") : undefined;
    if (ctx.hasUI) {
      ctx.ui.addAutocompleteProvider((current) => ({
        triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "\\"])],
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          const active = findActiveSkillCompletion(lines[cursorLine] ?? "", cursorCol);
          if (!active) return current.getSuggestions(lines, cursorLine, cursorCol, options);

          const prefix = active.prefix;
          const query = active.query.trim();
          if (query.length > 4_000) return null;

          try {
            const suggestions = await suggest(query, options.signal);
            if (options.signal.aborted) return null;
            const items = skillCompletions(suggestions).map((item) => ({
              ...item,
              value: `\\${item.value}`,
              label: item.label.replace(controlCharacters, " "),
              description: item.description?.replace(controlCharacters, " "),
            }));
            return { items: fixedHeightAutocompleteItems(items), prefix };
          } catch (error) {
            if (!options.signal.aborted) ctx.ui.notify(failureMessage(error), "error");
            return null;
          }
        },
        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
          if (item.value.startsWith(nonSelectablePrefix)) {
            return { lines, cursorLine, cursorCol };
          }
          if (!prefix.startsWith("\\")) {
            return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
          }
          return applyBackslashCompletion(lines, cursorLine, cursorCol, item, prefix);
        },
        shouldTriggerFileCompletion: current.shouldTriggerFileCompletion
          ? (lines, cursorLine, cursorCol) => current.shouldTriggerFileCompletion!(lines, cursorLine, cursorCol)
          : undefined,
      }));
    }
    void getClient().catch(showFailure);
  });

  pi.on("input", async (event, ctx) => {
    const text = event.text;
    const behavior = event.streamingBehavior;
    const selection = parseSkillSelection(text);
    if (!selection) {
      if (behavior) queueInput(text, text, behavior, ctx);
      return { action: "continue" };
    }

    const leadingSelection = text.slice(0, selection.start).trim().length === 0;
    const { name: query } = selection;
    if (!query) {
      if (leadingSelection) {
        if (ctx.hasUI) ctx.ui.notify("Type after \\\\ and choose a skill suggestion.", "warning");
        return { action: "handled" };
      }
      if (behavior) queueInput(text, text, behavior, ctx);
      return { action: "continue" };
    }
    if (query.length > 4_000) {
      if (ctx.hasUI) ctx.ui.notify("Skill names must be 4000 characters or fewer.", "error");
      return { action: "handled" };
    }

    try {
      const suggestions = await suggest(query);
      const exact = suggestions.find(({ name }) => name.toLowerCase() === query.toLowerCase());
      if (!exact) {
        if (ctx.hasUI) {
          ctx.ui.notify(suggestions.length ? "Choose a matching skill from the inline suggestions." : "No matching private skills found.", "warning");
        }
        if (!leadingSelection) {
          if (behavior) queueInput(text, text, behavior, ctx);
          return { action: "continue" };
        }
        return { action: "handled" };
      }
      if (exact.name.length > 200) {
        if (ctx.hasUI) ctx.ui.notify("Skill names must be 200 characters or fewer.", "error");
        return { action: "handled" };
      }
      const transformedText = nativeSkillCommand(text, selection, exact.name);
      if (!transformedText) {
        if (ctx.hasUI) ctx.ui.notify(`Pi's native skill command cannot load the skill name ${JSON.stringify(exact.name)}; names must be lowercase letters, numbers, and single hyphens (max 64 characters).`, "error");
        return { action: "handled" };
      }
      if (behavior) queueInput(text, transformedText, behavior, ctx);
      return { action: "transform", text: transformedText, images: event.images };
    } catch (error) {
      showFailure(error);
      if (!leadingSelection) {
        if (behavior) queueInput(text, text, behavior, ctx);
        return { action: "continue" };
      }
      return { action: "handled" };
    }
  });
}
