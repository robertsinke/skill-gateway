import type { InjectionDecision, SkillRelevanceLabel } from "./skill-usage-feedback-record.ts";

export type FeedbackWidgetAction = "edit";
type MouseEvent = { type: string; button: string; x: number; y: number; width: number };
type FeedbackWidget = {
  render(width: number): string[];
  handleMouse(event: MouseEvent): { handled: boolean; render: boolean } | undefined;
  invalidate(): void;
};

type FeedbackState = {
  injected_skill_names: string[];
  agent_loaded_skill_names: string[];
  agent_reads_pending: boolean;
  injection_decision: InjectionDecision | null;
  user_skill_feedback: SkillRelevanceLabel[];
};

export function createFeedbackWidget(state: FeedbackState, onAction: (action: FeedbackWidgetAction) => void): FeedbackWidget {
  const button = state.injection_decision !== null || state.user_skill_feedback.length
    ? "[Edit skill feedback]"
    : state.injected_skill_names.length ? "[Rate injected skills]" : "[Rate skill injection]";
  const loaded = state.agent_loaded_skill_names.length
    ? `${state.agent_loaded_skill_names.join(", ")} (proxy${state.agent_reads_pending ? "; so far" : ""})`
    : state.agent_reads_pending ? "pending (proxy)" : "none observed (proxy)";
  const labels = new Set(state.user_skill_feedback.map((item) => item.skill_name));
  const injected = state.injected_skill_names.length ? state.injected_skill_names.join(", ") : "none";
  const summary = `Should inject any: ${state.injection_decision ?? "not labeled"}; injected: ${injected}; agent read: ${loaded}; labels: ${labels.size}/${state.injected_skill_names.length}`;
  const line = `${button}  ${summary}`;
  return {
    render(width) {
      return [line.slice(0, Math.max(0, width))];
    },
    handleMouse(event) {
      if (event.type !== "click" || event.button !== "left" || event.y !== 0) return undefined;
      if (event.width < button.length || event.x < 0 || event.x >= button.length || event.x >= event.width) return undefined;
      onAction("edit");
      return { handled: true, render: true };
    },
    invalidate() {},
  };
}
