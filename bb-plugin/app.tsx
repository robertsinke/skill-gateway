// The panel is the existing Svelte dashboard, served by this plugin on a
// same-origin route so its /api calls relay through the plugin instead of
// crossing origins to the gateway server.
import { definePluginApp } from "@get-bb/plugin-sdk/app";

const DASHBOARD = "/api/v1/plugins/skill-gateway/http/ui/index.html";

function Dashboard() {
  return (
    <iframe
      src={DASHBOARD}
      title="Skill Gateway"
      style={{ border: 0, width: "100%", height: "100%", display: "block", background: "transparent" }}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "dashboard",
    title: "Skill Gateway",
    icon: "Search",
    path: "dashboard",
    component: Dashboard,
  });
});
