export type View = "home" | "skills" | "selection" | "router" | "analytics" | "settings";

/** One recorded skill-selection decision, as the ledger reports it. */
export type Decision = {
  timestamp: string;
  platform: string;
  status: string;
  skill: string | null;
  reason: string | null;
  probability: number | null;
  latency_ms: number | null;
  candidates: number;
  session_id: string | null;
  thread: string | null;
  runtime_policy: string | null;
};

export type SelectionReport = {
  decisions: Decision[];
  counts: { pass: number; reject: number; error: number; no_candidates: number };
  sessions: number;
  truncated: boolean;
  total: number;
};

export type SortKey = "name" | "description" | "source" | "added" | "uses" | "status";

export type Skill = {
  name: string;
  description: string;
  targets: string[];
  opensToolServer: boolean;
  source: string;
  owner: string;
  location: string;
  added: string;
  addedAt: number;
  uses: number;
  status: string;
};

export type RankedHit = {
  rank: number;
  name: string;
};

export type SearchRow = {
  date: string;
  user_id: string;
  session_id: string;
  query: string;
  skills: string[];
  ranks: RankedHit[];
  followup: string | null;
  reaction: string | null;
};

export type PreviewRow = {
  target: string;
  ok: boolean;
  rank: number | null;
  above: string[];
};

export type ScanPlace = {
  place: string;
  relative: string;
};

export type ScanSource = {
  place: string;
  relative: string;
  found: number;
  added: number;
  duplicates: number;
  removable: number;
};

export type RemovableCopy = {
  name: string;
  path: string;
  place: string;
};

export type ScanReport = {
  source: ScanSource;
  removable: RemovableCopy[];
};
