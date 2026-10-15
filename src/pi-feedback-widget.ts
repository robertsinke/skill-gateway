import type { SkillRelevanceLabel } from "./skill-usage-feedback-record.ts";

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
  user_skill_feedback: SkillRelevanceLabel[];
};

export function createFeedbackWidget(state: FeedbackState, onAction: (action: FeedbackWidgetAction) => void): FeedbackWidget {
  const button = state.user_skill_feedback.length ? "[Edit skill labels]" : "[Rate injected skills]";
  const loaded = state.agent_loaded_skill_names.length ? state.agent_loaded_skill_names.join(", ") : "none observed";
  const labels = new Set(state.user_skill_feedback.map((item) => item.skill_name));
  const summary = `Injected: ${state.injected_skill_names.join(", ")}; agent read: ${loaded} (proxy); labels: ${labels.size}/${state.injected_skill_names.length}`;
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
