<script lang="ts">
  import { gateway } from "./state.svelte";

  const ranked = $derived(
    gateway.skills
      .filter((skill) => skill.uses > 0)
      .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name))
      .slice(0, 8),
  );
  const injected = $derived(
    gateway.decisions.filter((row) => row.status === "pass" && row.skill).slice(0, 5),
  );
  const total = $derived(
    gateway.selection.pass + gateway.selection.reject + gateway.selection.error + gateway.selection.no_candidates,
  );
</script>

<section>
  <h1>Home</h1>
  <div class="stats">
    <div><strong>{gateway.skills.length}</strong><span>Skills in library</span></div>
    <div><strong>{gateway.selection.pass}</strong><span>Skills injected</span></div>
    <div><strong>{total}</strong><span>Decisions</span></div>
  </div>
  <h2>Most returned<span class="caption">Skills an older search sent back</span></h2>
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
  <h2>Last injected<span class="caption">What the gateway chose for a message</span></h2>
  <div class="list">
    {#if injected.length}
      {#each injected as row, index (`${row.timestamp}-${index}`)}
        <button type="button" onclick={() => gateway.select(row.skill ?? "")}>
          <span>{row.skill}</span>
          <span class="meta">{row.platform} · {row.reason ?? row.status}</span>
        </button>
      {/each}
    {:else}
      <p class="empty">Nothing injected yet. Open Selection for the full decision log.</p>
    {/if}
  </div>
</section>
