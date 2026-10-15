export type FeedbackWidgetAction = "helpful" | "not_helpful" | "note";
export type FeedbackWidgetRating = "helpful" | "not_helpful" | null;

type MouseEvent = { type: string; button: string; x: number; y: number; width: number };

type FeedbackWidget = {
  render(width: number): string[];
  handleMouse(event: MouseEvent): { handled: boolean; render: boolean } | undefined;
  invalidate(): void;
};

export function createFeedbackWidget(
  rating: FeedbackWidgetRating,
  commentPresent: boolean,
  onAction: (action: FeedbackWidgetAction) => void,
): FeedbackWidget {
  const prefix = "Skill search: ";
  const labels = [
    { action: "helpful" as const, text: `[Helpful${rating === "helpful" ? " *" : ""}]` },
    { action: "not_helpful" as const, text: `[Not useful${rating === "not_helpful" ? " *" : ""}]` },
    { action: "note" as const, text: `[${commentPresent ? "Edit note" : "Add note"}]` },
  ];
  const spans: { action: FeedbackWidgetAction; start: number; end: number }[] = [];
  let cursor = prefix.length;
  for (const [index, item] of labels.entries()) {
    if (index > 0) cursor += 1;
    const start = cursor;
    cursor += item.text.length;
    spans.push({ action: item.action, start, end: cursor });
  }
  const line = `${prefix}${labels.map((item) => item.text).join(" ")}`;
  return {
    render(width) {
      return [line.slice(0, Math.max(0, width))];
    },
    handleMouse(event) {
      if (event.type !== "click" || event.button !== "left" || event.y !== 0) return undefined;
      const target = spans.find((span) => event.x >= span.start && event.x < span.end && event.x < event.width);
      if (!target) return undefined;
      onAction(target.action);
      return { handled: true, render: true };
    },
    invalidate() {},
  };
}
