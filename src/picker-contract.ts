export type SkillSuggestion = { name: string; description: string };
export type SkillCompletion = { value: string; label: string; description: string };
export type SkillSelection = { name: string; start: number; end: number };
export type ActiveSkillCompletion = { start: number; end: number; replaceEnd: number; prefix: string; query: string };

export function skillCompletions(suggestions: SkillSuggestion[]): SkillCompletion[] {
  return suggestions.map(({ name, description }) => ({ value: name, label: name, description }));
}

export function parseSkillSelection(text: string): SkillSelection | null {
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "\\" || (start > 0 && !/\s/.test(text[start - 1]!)) || text[start + 1] === "\\") continue;
    let end = start + 1;
    while (end < text.length && !/\s/.test(text[end]!)) end += 1;
    return { name: text.slice(start + 1, end), start, end };
  }
  return null;
}

export function findActiveSkillCompletion(line: string, cursorCol: number): ActiveSkillCompletion | null {
  const cursor = Math.max(0, Math.min(line.length, cursorCol));
  for (let start = 0; start < cursor; start += 1) {
    if (line[start] !== "\\" || (start > 0 && !/\s/.test(line[start - 1]!)) || line[start + 1] === "\\") continue;
    let end = start + 1;
    while (end < line.length && !/\s/.test(line[end]!)) end += 1;
    const emptyTokenWithTrailingSpaces = end === start + 1 && cursor >= end && /^\s*$/.test(line.slice(end, cursor));
    if (cursor < start + 1 || (cursor > end && !emptyTokenWithTrailingSpaces)) continue;
    const prefixEnd = Math.min(cursor, end);
    const replaceEnd = emptyTokenWithTrailingSpaces ? start + 1 : prefixEnd;
    const prefix = line.slice(start, replaceEnd);
    return { start, end, replaceEnd, prefix, query: prefix.slice(1) };
  }
  return null;
}

export function replaceSkillSelection(text: string, selection: SkillSelection, replacement: string): string {
  return `${text.slice(0, selection.start)}${replacement}${text.slice(selection.end)}`;
}

export function nativeSkillCommand(text: string, selection: SkillSelection, name: string): string | null {
  if (name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return null;
  const before = text.slice(0, selection.start);
  const after = text.slice(selection.end);
  const request = `${before}${/\s$/.test(before) && /^\s/.test(after) ? after.slice(1) : after}`.trim();
  return `/skill:${name}${request ? ` ${request}` : ""}`;
}
