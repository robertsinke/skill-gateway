<script lang="ts">
  import { onMount } from "svelte";
  import Analytics from "./Analytics.svelte";
  import Home from "./Home.svelte";
  import Router from "./Router.svelte";
  import Selection from "./Selection.svelte";
  import Skills from "./Skills.svelte";
  import Settings from "./Settings.svelte";
  import { gateway } from "./state.svelte";
  import type { View } from "./lib/types";

  const views: { view: View; label: string }[] = [
    { view: "home", label: "Home" },
    { view: "skills", label: "Skills" },
    { view: "selection", label: "Selection" },
    { view: "router", label: "Router" },
    { view: "analytics", label: "Analytics" },
    { view: "settings", label: "Settings" },
  ];

  onMount(() => {
    gateway.restoreFold();
    // Embedded in BB: the host panel owns chrome and navigation, so the
    // dashboard renders one view without its own sidebar.
    const params = new URLSearchParams(location.search);
    embedded = params.get("embedded") === "1";
    const requested = params.get("view");
    if (requested && views.some((item) => item.view === requested)) gateway.show(requested as View);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      event.preventDefault();
      gateway.show("skills");
      document.querySelector<HTMLInputElement>("#skill-search")?.focus();
    };
    document.addEventListener("keydown", onKey);
    void gateway.load();
    void gateway.loadSearches();
    void gateway.loadSelection();
    return () => document.removeEventListener("keydown", onKey);
  });

  let embedded = $state(false);

  function count(view: View): string {
    if (view === "skills") return String(gateway.skills.length);
    if (view === "analytics") return String(gateway.queries);
    return "";
  }
</script>

<div class="app" class:folded={gateway.folded} class:embedded>
  {#if !embedded}
  <aside class="sidebar">
    <div class="profile">
      <span class="avatar" aria-hidden="true">P</span>
      <div>
        <strong>Personal</strong>
        <span>On this Mac</span>
      </div>
    </div>
    <nav>
      {#each views as item (item.view)}
        <button
          class="nav-item"
          class:active={gateway.view === item.view}
          type="button"
          data-view={item.view}
          title={item.label}
          aria-current={gateway.view === item.view ? "page" : undefined}
          onclick={() => gateway.show(item.view)}
        >
          {#if item.view === "home"}
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 7.5L8 3l5 4.5V13H10V9.5H6V13H3z" /></svg>
          {:else if item.view === "skills"}
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8.5 2L4 9h3.2L6.8 14 12 7H8.8z" /></svg>
          {:else if item.view === "router"}
            <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="4" r="1.5" /><circle cx="12" cy="8" r="1.5" /><circle cx="4" cy="12" r="1.5" /><path d="M5.5 4.5L10.5 7.5M10.5 8.5L5.5 11.5" /></svg>
          {:else if item.view === "analytics"}
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 12V8M7 12V4M11 12V6M14 13H2" /></svg>
          {:else}
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5l1 1.9 2.1.3-1.5 1.5.4 2.1L8 7.3 6 8.3l.4-2.1L4.9 4.7 7 4.4zM3.5 10.5h9M3.5 13h9" /></svg>
          {/if}
          <span>{item.label}</span>
          {#if count(item.view)}
            <span class="count">{count(item.view)}</span>
          {/if}
        </button>
      {/each}
    </nav>
    <button
      id="fold"
      class="fold"
      type="button"
      aria-expanded={gateway.folded ? "false" : "true"}
      aria-label={gateway.folded ? "Expand sidebar" : "Collapse sidebar"}
      onclick={() => gateway.toggleFold()}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5" /></svg>
    </button>
  </aside>
  {/if}
  <main class="main">
    <div data-panel="home" hidden={gateway.view !== "home"}><Home /></div>
    <div data-panel="skills" hidden={gateway.view !== "skills"}><Skills /></div>
    <div data-panel="selection" hidden={gateway.view !== "selection"}><Selection /></div>
    <div data-panel="router" hidden={gateway.view !== "router"}><Router /></div>
    <div data-panel="analytics" hidden={gateway.view !== "analytics"}><Analytics /></div>
    <div data-panel="settings" hidden={gateway.view !== "settings"}><Settings /></div>
  </main>
</div>
