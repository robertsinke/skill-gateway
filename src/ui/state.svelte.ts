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
  selectedName = $state("");

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
    const response = await apiFetch("/api/skills");
    const body: unknown = await response.json();
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
    const response = await apiFetch("/api/queries");
    const body: unknown = await response.json();
    this.searches = list(body).flatMap((item) => {
      const row = asSearch(item);
      return row ? [row] : [];
    });
  }

  async loadSelection(): Promise<void> {
    const response = await apiFetch("/api/selection");
    const body: unknown = await response.json();
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
  }

  async places(): Promise<ScanPlace[]> {
    const response = await apiFetch("/api/scan/places");
    const body: unknown = await response.json();
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
