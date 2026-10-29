import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { rememberThreadId, useThreadId } from "./thread.ts";

/**
 * The injected skill, stated where the conversation is. BB has no message
 * timeline slot, so the plugin states the last decision for the open thread as
 * a small chip above the composer; the dashboard's Selection tab keeps history.
 *
 * Styled from host tokens and inert to the pointer, so a background read can
 * never sit between the user and the composer.
 */
type Injection = {
  timestamp: string;
  status: string;
  skill: string | null;
  reason: string | null;
  failure: string | null;
  latency_ms: number | null;
};

/** The relay forwards one encoded `path`, so the thread travels inside it. */
const relay = (thread: string) =>
  `/api/v1/plugins/skill-gateway/http/api?path=${encodeURIComponent(`/api/injection?thread=${thread}`)}`;
const POLL_MS = 2500;

const chip: CSSProperties = {
  position: "fixed",
  right: "18px",
  bottom: "96px",
  zIndex: 30,
  display: "flex",
  alignItems: "center",
  gap: "7px",
  padding: "4px 10px",
  borderRadius: "999px",
  border: "1px solid var(--line, rgba(0,0,0,0.14))",
  background: "var(--paper, Canvas)",
  color: "var(--ink, CanvasText)",
  font: "11px/1.5 var(--font-sans, system-ui, sans-serif)",
  boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
  pointerEvents: "none",
  maxWidth: "min(420px, 60vw)",
};

const dot = (injected: boolean): CSSProperties => ({
  width: "6px",
  height: "6px",
  borderRadius: "999px",
  flex: "0 0 auto",
  background: injected ? "var(--accent, #2f7d5f)" : "var(--subtle-foreground, #9aa0a6)",
});

const label: CSSProperties = {
  color: "var(--muted-foreground, #6b7280)",
  letterSpacing: "0.02em",
  flex: "0 0 auto",
};

const skill: CSSProperties = {
  fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const time: CSSProperties = { color: "var(--subtle-foreground, #9aa0a6)", flex: "0 0 auto" };

export function InjectionChip() {
  const activeThreadId = useThreadId();
  const [injection, setInjection] = useState<Injection | null>(null);

  useEffect(() => {
    setInjection(null);
    if (!activeThreadId) return;
    rememberThreadId(activeThreadId);
    let live = true;
    const load = async () => {
      try {
        const response = await fetch(relay(activeThreadId));
        if (!response.ok) return;
        const body = (await response.json()) as Injection | null;
        if (live) setInjection(body && typeof body === "object" ? body : null);
      } catch {
        // A background read failing is not worth a visible error; the chip keeps what it has.
      }
    };
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [activeThreadId]);

  if (!injection) return null;

  const injected = injection.status === "pass" && injection.skill;
  const at = injection.timestamp?.slice(11, 16) ?? "";
  const detail = injected
    ? `Injected for this thread at ${at}${injection.latency_ms === null ? "" : ` · ${injection.latency_ms} ms`}`
    : injection.failure
      ? `The gate call failed (${injection.failure}), so nothing was injected`
      : `Nothing injected: ${injection.status.replace(/_/g, " ")}${injection.reason ? ` · ${injection.reason}` : ""}`;

  return (
    <div style={chip} title={detail} role="status">
      <span style={dot(Boolean(injected))} aria-hidden="true" />
      <span style={label}>{injected ? "Injected" : "No skill"}</span>
      {injected ? <span style={skill}>{injection.skill}</span> : null}
      <span style={time}>{at}</span>
    </div>
  );
}
