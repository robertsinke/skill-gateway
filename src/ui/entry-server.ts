import { render } from "svelte/server";
import App from "./App.svelte";

export function renderApp(): { head: string; body: string } {
  return render(App);
}
