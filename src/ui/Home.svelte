<script lang="ts">
  import { gateway } from "./state.svelte";

  const ranked = $derived(
    gateway.skills
      .filter((skill) => skill.uses > 0)
      .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name))
      .slice(0, 8),
  );
  const recent = $derived(gateway.searches.slice(0, 5));
</script>

<section>
  <h1>Home</h1>
  <div class="stats">
    <div><strong>{gateway.skills.length}</strong><span>Skills</span></div>
    <div><strong>{gateway.queries}</strong><span>Searches</span></div>
  </div>
  <h2>Most returned<span class="caption">Skills a search sent back</span></h2>
  <div class="list">
    {#if ranked.length}
      {#each ranked as skill (skill.name)}
        <button type="button" onclick={() => gateway.select(skill.name)}>
          <span>{skill.name}</span>
          <span class="meta">{skill.uses}</span>
        </button>
      {/each}
    {:else}
      <p class="empty">No skill has been returned by a search yet.</p>
    {/if}
  </div>
  <h2>Recent searches<span class="caption">Messages that were ranked</span></h2>
  <div class="list">
    {#if recent.length}
      {#each recent as row, index (`${row.query}-${index}`)}
        <button type="button" onclick={() => gateway.show("analytics")}>
          <span>{row.query}</span>
          <span class="meta">{row.skills.slice(0, 2).join(", ")}</span>
        </button>
      {/each}
    {:else}
      <p class="empty">No searches yet.</p>
    {/if}
  </div>
</section>
