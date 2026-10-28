// The panel is the existing Svelte dashboard, served by this plugin on a
// same-origin route so its /api calls relay through the plugin instead of
// crossing origins to the gateway server. The host's theme tokens are posted
// into the frame; without them the dashboard would render its own light theme.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ThemedDashboard } from "./components/themed-dashboard.tsx";

const DASHBOARD = "/api/v1/plugins/skill-gateway/http/ui/index.html";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "dashboard",
    title: "Skill Gateway",
    icon: "Search",
    path: "dashboard",
    component: () => <ThemedDashboard src={DASHBOARD} />,
  });
});
