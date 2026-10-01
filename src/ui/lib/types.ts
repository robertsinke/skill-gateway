export type View = "home" | "skills" | "router" | "analytics";

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
