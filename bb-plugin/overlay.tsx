import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { rememberThreadId, useThreadId } from "./thread.ts";

/**
 * The injected skill, stated where the conversation is. BB has no message
 * timeline slot, so the plugin states the thread's newest decision as a chip on
 * the composer's context-ring row, with the last few turns on hover; the
 * dashboard's Selection tab keeps the full history.
 */
type Decision = {
  timestamp: string;
  status: string;
  skill: string | null;
  reason: string | null;
  failure: string | null;
  latency_ms: number | null;
};

const POLL_MS = 2500;
const HISTORY = 4;
/** The context ring's own label; the chip borrows its row and its baseline. */
const ANCHOR = '[aria-label^="Context window"]';

const relay = (thread: string) =>
  `/api/v1/plugins/skill-gateway/http/api?path=${encodeURIComponent(`/api/injection?thread=${thread}&limit=${HISTORY}`)}`;

/** The context ring's row, measured; `null` when this thread has no composer. */
function useRingRow() {
  const [row, setRow] = useState<{ right: number; middle: number } | null>(null);
  useEffect(() => {
    const measure = () => {
      const target = document.querySelector(ANCHOR) ?? document.querySelector("circle[stroke-dasharray]")?.parentElement ?? null;
      const box = target?.getBoundingClientRect();
      if (!box || (!box.width && !box.height)) {
        setRow(null);
        return;
      }
      setRow({ right: window.innerWidth - box.left, middle: box.top + box.height / 2 });
    };
    measure();
    const timer = setInterval(measure, 1000);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      clearInterval(timer);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, []);
  return row;
}

const shell: CSSProperties = {
  position: "fixed",
  right: "18px",
  bottom: "96px",
  zIndex: 30,
  font: "11px/1.5 var(--font-sans, system-ui, sans-serif)",
  color: "var(--ink, CanvasText)",
  maxWidth: "min(320px, 60vw)",
};

const chip: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "7px",
  padding: "3px 9px",
  borderRadius: "999px",
  border: "1px solid var(--line, rgba(0,0,0,0.14))",
  background: "var(--paper, Canvas)",
  boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
  cursor: "default",
  height: "22px",
  boxSizing: "border-box",
};

const popover: CSSProperties = {
  position: "absolute",
  right: "0",
  // The chip rides the composer's last row, so the only room is upward.
  bottom: "calc(100% + 8px)",
  minWidth: "284px",
  padding: "6px 0",
  borderRadius: "8px",
  border: "1px solid var(--line, rgba(0,0,0,0.14))",
  background: "var(--paper, Canvas)",
  boxShadow: "0 4px 14px rgba(0,0,0,0.10)",
};

const rowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "38px minmax(0, 1fr) auto",
  alignItems: "baseline",
  gap: "8px",
  padding: "3px 10px",
};

const when: CSSProperties = { color: "var(--subtle-foreground, #9aa0a6)", fontVariantNumeric: "tabular-nums" };
const skill: CSSProperties = {
  fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const note: CSSProperties = { color: "var(--muted-foreground, #6b7280)", whiteSpace: "nowrap" };

const dot = (injected: boolean): CSSProperties => ({
  width: "6px",
  height: "6px",
  borderRadius: "999px",
  flex: "0 0 auto",
  background: injected ? "var(--accent, #2f7d5f)" : "var(--subtle-foreground, #9aa0a6)",
});

const injected = (decision: Decision) => decision.status === "pass" && Boolean(decision.skill);

const outcome = (decision: Decision) =>
  injected(decision)
    ? `${decision.skill}`
    : decision.failure
      ? "failed"
      : decision.status.replace(/_/g, " ");

const at = (decision: Decision) => decision.timestamp?.slice(11, 16) ?? "";

const detail = (decision: Decision) =>
  injected(decision)
    ? `Injected at ${at(decision)}${decision.latency_ms === null ? "" : ` · ${decision.latency_ms} ms`}`
    : decision.failure
      ? `The gate call failed (${decision.failure}), so nothing was injected`
      : `Nothing injected: ${decision.status.replace(/_/g, " ")}${decision.reason ? ` · ${decision.reason}` : ""}`;

export function InjectionChip() {
  const threadId = useThreadId();
  const row = useRingRow();
  const [recent, setRecent] = useState<Decision[]>([]);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);

  useEffect(() => {
    setRecent([]);
    if (!threadId) return;
    rememberThreadId(threadId);
    let live = true;
    const load = async () => {
      try {
        const response = await fetch(relay(threadId));
        if (!response.ok) return;
        const body = (await response.json()) as unknown;
        if (live && Array.isArray(body)) setRecent(body as Decision[]);
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
  }, [threadId]);

  const latest = recent[0];
  if (!latest) return null;

  const anchor: CSSProperties = row
    ? { right: `${row.right + 8}px`, bottom: "auto", top: `${row.middle}px`, transform: "translateY(-50%)" }
    : {};

  const show = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hide = () => {
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  };

  return (
    <div style={{ ...shell, ...anchor }} onMouseEnter={show} onMouseLeave={hide}>
      {open && recent.length > 1 ? (
        <div style={popover}>
          {recent.map((decision, index) => (
            <div key={`${decision.timestamp}-${index}`} style={rowStyle} title={detail(decision)}>
              <span style={when}>{at(decision)}</span>
              <span style={skill}>{outcome(decision)}</span>
              <span style={note}>{injected(decision) ? (decision.latency_ms === null ? "" : `${decision.latency_ms} ms`) : "—"}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div style={chip} title={detail(latest)}>
        <span style={dot(injected(latest))} aria-hidden="true" />
        <span role="status" style={note}>
          {injected(latest) ? "Injected" : "No skill"}
        </span>
        {injected(latest) ? <span style={skill}>{latest.skill}</span> : null}
        <span style={when}>{at(latest)}</span>
      </div>
    </div>
  );
}
