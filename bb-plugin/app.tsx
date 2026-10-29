// The panel is the existing Svelte dashboard, served by this plugin on a
// same-origin route so its /api calls relay through the plugin instead of
// crossing origins to the gateway server. The host's theme tokens are posted
// into the frame, and BB's panel header owns navigation: each view is a fixed
// tab, so the dashboard renders embedded with no sidebar of its own.
import { definePluginApp, useBbContext } from "@get-bb/plugin-sdk/app";
import type { BbIconName } from "@get-bb/plugin-sdk/app";
import { ThemedDashboard } from "./components/themed-dashboard.tsx";

const BASE = "/api/v1/plugins/skill-gateway/http/ui/index.html";

const VIEWS: { id: string; title: string; icon: BbIconName }[] = [
  { id: "skills", title: "Skills", icon: "Search" },
  { id: "selection", title: "Selection", icon: "Target" },
  { id: "router", title: "Router", icon: "GitBranch" },
  { id: "analytics", title: "Analytics", icon: "ChartColumn" },
  { id: "settings", title: "Settings", icon: "Settings" },
];

// The panel follows the thread you are looking at: selection rows are recorded
// against the thread that asked, so the dashboard can lead with this one.
const dashboard = (view: string) =>
  function Dashboard() {
    const { activeThreadId } = useBbContext();
    const thread = activeThreadId ? `&thread=${encodeURIComponent(activeThreadId)}` : "";
    return <ThemedDashboard src={`${BASE}?embedded=1&view=${view}${thread}`} />;
  };

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "dashboard",
    title: "Skill Gateway",
    icon: "Target",
    path: "dashboard",
    component: dashboard("skills"),
  });

  for (const view of VIEWS) {
    app.slots.experimental_tab({
      context: { kind: "nav-panel", panelId: "dashboard" },
      availability: "fixed",
      id: view.id,
      title: view.title,
      icon: view.icon,
      component: dashboard(view.id),
    });
  }
});
