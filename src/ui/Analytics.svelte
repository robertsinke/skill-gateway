<script lang="ts">
  import { phrase } from "./lib/format";
  import { gateway } from "./state.svelte";

  const ranked = $derived(
    gateway.skills
      .filter((skill) => skill.uses > 0)
      .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name)),
  );
  const peak = $derived(ranked[0]?.uses ?? 0);
  const note = $derived.by(() => {
    if (!gateway.queries) {
      return "No searches yet. The next message in a session is the reaction. Which skill was opened, and whether the task finished, are still blank.";
    }
    const scope = gateway.sessions ? ` across ${phrase(gateway.sessions, "session", "sessions")}` : "";
    const shown = gateway.searches.length < gateway.queries ? ` Showing the latest ${gateway.searches.length}.` : "";
    return `${phrase(gateway.queries, "search", "searches")}${scope}.${shown} The next message is the reaction. Opened skill and finished task are still blank.`;
  });

  function rankedText(row: (typeof gateway.searches)[number]): string {
    if (row.ranks.length) return row.ranks.map((hit) => `${hit.rank}. ${hit.name}`).join(", ");
    return row.skills.join(", ");
  }
</script>

<section>
  <h1>Analytics</h1>
  <p class="sub">{note}</p>
  <h2>Returned skills</h2>
  <div class="meters">
    {#if ranked.length}
      {#each ranked.slice(0, 12) as skill (skill.name)}
        <div class="meter">
          <span class="clip">{skill.name}</span>
          <span class="track"><span class="fill" style:width="{peak ? Math.max(4, Math.round((skill.uses / peak) * 100)) : 0}%"></span></span>
          <span class="n">{skill.uses}</span>
        </div>
      {/each}
    {:else}
      <p class="empty">No skill has been returned by a search yet.</p>
    {/if}
  </div>
  <h2>Searches</h2>
  <table class="sheet">
    <colgroup>
      <col style="width:14%" /><col style="width:10%" /><col style="width:12%" /><col style="width:22%" /><col style="width:16%" /><col style="width:16%" /><col style="width:10%" />
    </colgroup>
    <thead>
      <tr>
        <th>Date</th><th>User</th><th>Session</th><th>Query</th><th>Ranked</th><th>Next message</th><th>Reaction</th>
      </tr>
    </thead>
    <tbody>
      {#if gateway.searches.length}
        {#each gateway.searches as row, index (`${row.session_id}-${index}`)}
          <tr>
            <td>{row.date}</td>
            <td>{row.user_id}</td>
            <td class="clip"><code>{row.session_id}</code></td>
            <td class="clip">{row.query}</td>
            <td class="clip">{rankedText(row)}</td>
            <td class="clip">{row.followup ?? "—"}</td>
            <td>{row.reaction ?? "—"}</td>
          </tr>
        {/each}
      {:else}
        <tr><td colspan="7">No searches yet.</td></tr>
      {/if}
    </tbody>
  </table>
</section>
