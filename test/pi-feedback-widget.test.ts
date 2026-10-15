import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFeedbackWidget } from "../src/pi-feedback-widget.ts";

describe("Pi per-skill feedback widget", () => {
  it("shows agent-read proxy separately from user relevance labels and dispatches edits", () => {
    const actions: string[] = [];
    const widget = createFeedbackWidget({
      injected_skill_names: ["calendar", "invoice-review"],
      agent_loaded_skill_names: ["calendar"],
      agent_reads_pending: false,
      injection_decision: "yes",
      user_skill_feedback: [{ skill_name: "calendar", relevance: "relevant" }],
    }, (action) => actions.push(action));
    const line = widget.render(160)[0]!;
    assert.match(line, /\[Edit skill feedback\]/);
    assert.match(line, /Should inject any: yes/);
    assert.match(line, /agent read: calendar \(proxy\)/);
    assert.match(line, /labels: 1\/2/);

    const x = line.indexOf("[Edit skill feedback]");
    assert.ok(x >= 0);
    assert.equal(widget.handleMouse({ type: "click", button: "left", x, y: 0, width: 160 })?.handled, true);
    assert.deepEqual(actions, ["edit"]);
    const outsideX = line.indexOf("Injected:");
    assert.equal(widget.handleMouse({ type: "click", button: "left", x: outsideX, y: 0, width: 160 }), undefined);
    assert.equal(widget.handleMouse({ type: "click", button: "right", x, y: 0, width: 160 }), undefined);
  });

  it("clips to narrow terminals and does not activate hidden controls", () => {
    const actions: string[] = [];
    const widget = createFeedbackWidget({
      injected_skill_names: ["calendar"],
      agent_loaded_skill_names: [],
      agent_reads_pending: true,
      injection_decision: null,
      user_skill_feedback: [],
    }, (action) => actions.push(action));
    assert.equal(widget.render(8)[0]?.length, 8);
    assert.match(widget.render(120)[0]!, /agent read: pending/);
    assert.equal(widget.handleMouse({ type: "click", button: "left", x: 7, y: 0, width: 8 }), undefined);
    assert.deepEqual(actions, []);
  });
});
