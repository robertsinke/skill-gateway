/**
 * Pi host adapter for BB-owned skill selection.
 *
 * BB decides; this adapter only does what a harness must do itself:
 *  1. keep Pi's native skill roster out of the model's context, and
 *  2. hand the one selected skill's instructions to the agent.
 *
 * Enable with `--jev-via-bb`. The local chooser in jev-skill-suggestion.ts
 * stands down while this flag is on, so exactly one selector runs.
 */
import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ROUTE = "/api/v1/plugins/skill-gateway/http/select";
const PLUGIN_ID = "skill-gateway";
const TIMEOUT_MS = 10_000;

export type BbSelection = {
  name: string | null;
  context: string;
  reason: string;
  latency_ms: number;
};

type Options = {
  serverUrl?: string;
  token?: string | null;
  fetcher?: typeof fetch;
};

/** Resolves the BB URL and this plugin's token on the machine running Pi. */
export function resolveTarget(options: Options = {}): { url: string; token: string | null } {
  const url = (options.serverUrl ?? process.env.BB_SERVER_URL ?? "").replace(/\/+$/, "");
  let token = options.token;
  if (token === undefined) {
    try {
      token = execFileSync("bb", ["plugin", "token", PLUGIN_ID], { encoding: "utf8", timeout: 5_000 }).trim() || null;
    } catch {
      token = process.env.BB_PLUGIN_SKILL_GATEWAY_TOKEN?.trim() || null;
    }
  }
  return { url, token };
}

/** One message in, one skill or none out. Throws when BB cannot answer. */
export async function selectViaBb(
  input: { prompt: string; sessionId: string; cwd?: string },
  options: Options = {},
): Promise<BbSelection> {
  const { url, token } = resolveTarget(options);
  if (!url) throw new Error("BB_SERVER_URL is not set");
  if (!token) throw new Error(`no token for plugin ${PLUGIN_ID}`);
  const response = await (options.fetcher ?? fetch)(`${url}${ROUTE}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bb-plugin-token": token },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !body || typeof body !== "object") throw new Error(`BB selection failed (${response.status})`);
  const record = body as Record<string, unknown>;
  if (record.ok !== true) throw new Error(typeof record.message === "string" ? record.message : "BB selection failed");
  return {
    name: typeof record.name === "string" ? record.name : null,
    context: typeof record.context === "string" ? record.context : "",
    reason: typeof record.reason === "string" ? record.reason : "",
    latency_ms: typeof record.latency_ms === "number" ? record.latency_ms : 0,
  };
}

export default function jevViaBb(pi: ExtensionAPI, options: Options & { enabledByDefault?: boolean } = {}) {
  pi.registerFlag("jev-via-bb", {
    type: "boolean",
    default: options.enabledByDefault ?? false,
    description: "Let the BB skill-gateway plugin select one skill per message; Pi advertises no skill roster",
  });

  const off = (ctx: ExtensionContext) => ctx.ui.setStatus("skill-gateway-bb", "BB selection: off");

  /** Claims the session so the local chooser stands down and the legacy hook stays bypassed. */
  const claim = (ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    process.env.SKILL_GATEWAY_BB_SESSION = sessionId;
    process.env.SKILL_GATEWAY_PI_JEV_SESSION = sessionId;
  };

  pi.on("session_start", (_event, ctx) => {
    if (pi.getFlag("jev-via-bb") !== true) return off(ctx);
    claim(ctx);
    ctx.ui.setStatus("skill-gateway-bb", "BB selection: ready");
  });

  pi.on("session_shutdown", () => {
    delete process.env.SKILL_GATEWAY_BB_SESSION;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (pi.getFlag("jev-via-bb") !== true) return;
    claim(ctx);
    // The invariant holds even when selection fails: no roster reaches the model.
    event.systemPromptOptions.skills = [];
    const prompt = event.prompt.trim();
    if (event.messageType !== "user" || !prompt) return;
    if (/^\/\S/.test(prompt) || /^<skill name="[^"]+" location="/.test(prompt)) return;

    let selection: BbSelection;
    try {
      selection = await selectViaBb(
        {
          prompt: event.prompt,
          sessionId: ctx.sessionManager.getSessionId(),
          cwd: ctx.cwd,
        },
        options,
      );
    } catch (error) {
      ctx.ui.setStatus("skill-gateway-bb", `BB selection failed: ${messageOf(error)}`);
      return;
    }
    ctx.ui.setStatus(
      "skill-gateway-bb",
      selection.name ? `BB selection: ${selection.name} (${selection.latency_ms}ms)` : `BB selection: none — ${selection.reason}`,
    );
    if (!selection.context) return;
    return {
      message: {
        customType: "skill-gateway-bb",
        content: selection.context,
        display: false,
        details: { skill: selection.name, reason: selection.reason, latency_ms: selection.latency_ms },
      },
    };
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
