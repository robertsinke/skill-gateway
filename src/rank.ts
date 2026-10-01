import { basename } from "node:path";

/** Usual Okapi defaults. Locked by tests; do not tune against the live library. */
export const K1 = 1.5;
export const B = 0.75;

/** Name tokens count four times; description tokens count twice. */
const NAME_WEIGHT = 4;
const DESCRIPTION_WEIGHT = 2;

const URL = /https?:\/\/\S+|www\.\S+/gi;
const TICKET = /\b[A-Za-z][A-Za-z0-9]*-\d+\b|#\d+/g;
const TOKEN = /[a-z0-9]+/g;

const STOPWORDS = new Set([
  "a",
  "about",
  "after",
  "also",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "before",
  "being",
  "but",
  "by",
  "can",
  "did",
  "do",
  "does",
  "doing",
  "down",
  "for",
  "from",
  "had",
  "has",
  "have",
  "having",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "me",
  "my",
  "no",
  "not",
  "of",
  "off",
  "on",
  "or",
  "our",
  "out",
  "over",
  "so",
  "than",
  "that",
  "the",
  "their",
  "then",
  "these",
  "they",
  "this",
  "those",
  "to",
  "up",
  "was",
  "we",
  "were",
  "will",
  "with",
  "you",
  "your",
]);

export type Document = {
  name: string;
  description: string;
  path: string;
};

export type Hit = {
  document: Document;
  score: number;
};

export function tokenize(text: string): string[] {
  const stripped = text.replace(URL, " ").replace(TICKET, " ");
  const folded = fold(stripped.toLowerCase());
  const tokens: string[] = [];
  for (const raw of folded.match(TOKEN) ?? []) {
    if (STOPWORDS.has(raw)) continue;
    const word = singularize(raw);
    if (!word || STOPWORDS.has(word)) continue;
    tokens.push(word);
  }
  return tokens;
}

export function rank(query: string, documents: Document[], limit = 20): Hit[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || limit <= 0) return [];
  const corpus = documents.map(documentTokens);
  const scores = bm25(queryTokens, corpus);
  const hits: Hit[] = [];
  documents.forEach((document, index) => {
    const score = scores[index] ?? 0;
    if (score > 0) hits.push({ document, score });
  });
  hits.sort((left, right) => (left.document.name < right.document.name ? -1 : left.document.name > right.document.name ? 1 : 0));
  hits.sort((left, right) => right.score - left.score);
  return hits.slice(0, limit);
}

export function exactLookup(name: string, documents: Document[]): Document | null {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  const matches = documents.filter((document) => {
    const aliases = new Set([document.name.trim().toLowerCase(), basename(document.path).toLowerCase()]);
    return aliases.has(needle);
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function documentTokens(document: Document): string[] {
  return [...repeat(tokenize(document.name), NAME_WEIGHT), ...repeat(tokenize(document.description), DESCRIPTION_WEIGHT)];
}

function repeat(tokens: string[], times: number): string[] {
  const repeated: string[] = [];
  for (let count = 0; count < times; count += 1) repeated.push(...tokens);
  return repeated;
}

function bm25(queryTokens: string[], corpus: string[][]): number[] {
  const nDocs = corpus.length;
  if (nDocs === 0) return [];
  const lengths = corpus.map((tokens) => tokens.length);
  const avgdl = lengths.reduce((sum, length) => sum + length, 0) / nDocs;
  const docFreq = new Map<string, number>();
  const termFreqs = corpus.map((tokens) => {
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const token of counts.keys()) docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
    return counts;
  });
  return termFreqs.map((counts, index) => {
    const length = lengths[index] ?? 0;
    let score = 0;
    for (const token of queryTokens) {
      const freq = counts.get(token) ?? 0;
      if (freq === 0) continue;
      const documentsWithTerm = docFreq.get(token) ?? 0;
      const idf = Math.log(1 + (nDocs - documentsWithTerm + 0.5) / (documentsWithTerm + 0.5));
      const norm = avgdl ? 1 - B + B * (length / avgdl) : 1;
      score += (idf * (freq * (K1 + 1))) / (freq + K1 * norm);
    }
    return score;
  });
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{Mn}/gu, "");
}

function singularize(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(sses|shes|ches|xes|zes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("ss") || word.endsWith("us") || word.endsWith("is")) return word;
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}
