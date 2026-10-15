import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFeedbackWidget } from "../src/pi-feedback-widget.ts";

describe("Pi skill-search feedback widget", () => {
  it("renders rating and note actions and dispatches exact clicks", () => {
    const actions: string[] = [];
    const widget = createFeedbackWidget("helpful", true, (action) => actions.push(action));
    const line = widget.render(80)[0]!;
    assert.match(line, /\[Helpful \*\]/);
    assert.match(line, /\[Edit note\]/);

    const helpfulX = line.indexOf("[Helpful");
    const noteX = line.indexOf("[Edit note]");
    assert.equal(widget.handleMouse({ type: "click", button: "left", x: helpfulX, y: 0, width: 80 })?.handled, true);
    assert.equal(widget.handleMouse({ type: "click", button: "left", x: noteX, y: 0, width: 80 })?.handled, true);
    assert.deepEqual(actions, ["helpful", "note"]);
    assert.equal(widget.handleMouse({ type: "click", button: "left", x: 0, y: 0, width: 80 }), undefined);
    assert.equal(widget.handleMouse({ type: "click", button: "right", x: helpfulX, y: 0, width: 80 }), undefined);
  });

  it("clips to narrow terminals and does not activate hidden controls", () => {
    const actions: string[] = [];
    const widget = createFeedbackWidget(null, false, (action) => actions.push(action));
    assert.equal(widget.render(8)[0]?.length, 8);
    assert.equal(widget.handleMouse({ type: "click", button: "left", x: 7, y: 0, width: 8 }), undefined);
    assert.deepEqual(actions, []);
  });
});
