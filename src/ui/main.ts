import { hydrate, mount } from "svelte";
import App from "./App.svelte";
import "./app.css";

const target = document.getElementById("app");
if (target) {
  const start = target.childElementCount > 0 ? hydrate : mount;
  start(App, { target });
}
