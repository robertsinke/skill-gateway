import { apiFetch } from "./api";
import { asSearch, asSkill } from "./lib/format";
import type { Decision, RemovableCopy, ScanPlace, ScanReport, SearchRow, SelectionReport, Skill, View } from "./lib/types";

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function object(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

class Gateway {
  view = $state<View>("skills");
  folded = $state(false);
  skills = $state<Skill[]>([]);
  queries = $state(0);
  sessions = $state(0);
  searches = $state<SearchRow[]>([]);
  decisions = $state<Decision[]>([]);
  selection = $state<SelectionReport["counts"]>({ pass: 0, reject: 0, error: 0, no_candidates: 0 });
  selectionSessions = $state(0);
  selectionTotal = $state(0);
  selectionTruncated = $state(false);
  /** The thread the host panel is showing, empty when the dashboard runs standalone. */
  thread = $state("");
  /** One entry per endpoint that could not be read; the shell renders them. */
  problems = $state<Record<string, string>>({});
  selectedName = $state("");

  get problem(): string | null {
    const messages = Object.values(this.problems);
    return messages.length ? [...new Set(messages)].join(" · ") : null;
  }

  /** Decisions recorded for the thread the host is showing, newest first. */
  get threadDecisions(): Decision[] {
    if (!this.thread) return [];
    return this.decisions.filter((row) => row.thread === this.thread);
  }

  /** Reads one endpoint, recording why it failed instead of pretending it was empty. */
  private async read(path: string, init: RequestInit = {}): Promise<unknown> {
    try {
      const response = await apiFetch(path, init);
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
        throw new Error(detail?.message || detail?.error || `${path} failed (${response.status})`);
      }
      const body: unknown = await response.json();
      delete this.problems[path];
      return body;
    } catch (error) {
      this.problems[path] = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  show(view: View): void {
    this.view = view;
  }

  select(name: string): void {
    this.selectedName = name;
    this.view = "router";
  }

  toggleFold(): void {
    this.folded = !this.folded;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("skill-gateway-sidebar", this.folded ? "folded" : "open");
    }
  }

  restoreFold(): void {
    if (typeof localStorage !== "undefined" && localStorage.getItem("skill-gateway-sidebar") === "folded") {
      this.folded = true;
    }
  }

  skill(): Skill | undefined {
    return this.skills.find((skill) => skill.name === this.selectedName);
  }

  async load(): Promise<void> {
    const body = await this.read("/api/skills").catch(() => undefined);
    if (body === undefined) return;
    const inventory = object(body);
    this.skills = list(inventory?.skills).flatMap((item) => {
      const skill = asSkill(item);
      return skill ? [skill] : [];
    });
    this.queries = typeof inventory?.queries === "number" ? inventory.queries : 0;
    this.sessions = typeof inventory?.sessions === "number" ? inventory.sessions : 0;
    const first = this.skills[0];
    if (!this.selectedName && first) this.selectedName = first.name;
  }

  async loadSearches(): Promise<void> {
    const body = await this.read("/api/queries").catch(() => undefined);
    if (body === undefined) return;
    this.searches = list(body).flatMap((item) => {
      const row = asSearch(item);
      return row ? [row] : [];
    });
  }

  async loadSelection(): Promise<void> {
    const body = await this.read("/api/selection").catch(() => undefined);
    if (body === undefined) return;
    const report = object(body);
    this.decisions = list(report?.decisions).flatMap((item) => {
      const row = object(item);
      if (!row || typeof row.status !== "string") return [];
      const decision: Decision = {
        timestamp: typeof row.timestamp === "string" ? row.timestamp : "",
        platform: typeof row.platform === "string" ? row.platform : "unknown",
        status: row.status,
        skill: typeof row.skill === "string" ? row.skill : null,
        reason: typeof row.reason === "string" ? row.reason : null,
        probability: typeof row.probability === "number" ? row.probability : null,
        latency_ms: typeof row.latency_ms === "number" ? row.latency_ms : null,
        candidates: typeof row.candidates === "number" ? row.candidates : 0,
        session_id: typeof row.session_id === "string" ? row.session_id : null,
        thread: typeof row.thread === "string" ? row.thread : null,
        failure: typeof row.failure === "string" ? row.failure : null,
        runtime_policy: typeof row.runtime_policy === "string" ? row.runtime_policy : null,
      };
      return [decision];
    });
    const counts = object(report?.counts);
    this.selection = {
      pass: typeof counts?.pass === "number" ? counts.pass : 0,
      reject: typeof counts?.reject === "number" ? counts.reject : 0,
      error: typeof counts?.error === "number" ? counts.error : 0,
      no_candidates: typeof counts?.no_candidates === "number" ? counts.no_candidates : 0,
    };
    this.selectionSessions = typeof report?.sessions === "number" ? report.sessions : 0;
    this.selectionTotal = typeof report?.total === "number" ? report.total : 0;
    this.selectionTruncated = report?.truncated === true;
  }

  async places(): Promise<ScanPlace[]> {
    const body = await this.read("/api/scan/places").catch(() => undefined);
    if (body === undefined) return [];
    return list(body).flatMap((item) => {
      const row = object(item);
      if (!row || typeof row.place !== "string" || typeof row.relative !== "string") return [];
      return [{ place: row.place, relative: row.relative }];
    });
  }

  async scanPlace(relative: string): Promise<ScanReport | null> {
    const response = await apiFetch("/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relative }),
    });
    const body: unknown = await response.json();
    const report = object(body);
    const source = object(report?.source);
    if (!source || typeof source.place !== "string") return null;
    const removable = list(report?.removable).flatMap((item): RemovableCopy[] => {
      const row = object(item);
      if (!row || typeof row.path !== "string" || typeof row.place !== "string") return [];
      return [{ name: typeof row.name === "string" ? row.name : "", path: row.path, place: row.place }];
    });
    return {
      source: {
        place: source.place,
        relative: typeof source.relative === "string" ? source.relative : "",
        found: typeof source.found === "number" ? source.found : 0,
        added: typeof source.added === "number" ? source.added : 0,
        duplicates: typeof source.duplicates === "number" ? source.duplicates : 0,
        removable: typeof source.removable === "number" ? source.removable : 0,
      },
      removable,
    };
  }

  async remove(paths: string[]): Promise<string[]> {
    const response = await apiFetch("/api/scan/remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths }),
    });
    const body: unknown = await response.json();
    const report = object(body);
    return list(report?.removed).filter((item): item is string => typeof item === "string");
  }
}

export const gateway = new Gateway();
