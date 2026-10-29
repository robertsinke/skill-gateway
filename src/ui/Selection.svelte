<script lang="ts">
  import { phrase } from "./lib/format";
  import { gateway } from "./state.svelte";

  const total = $derived(
    gateway.selection.pass + gateway.selection.reject + gateway.selection.error + gateway.selection.no_candidates,
  );
  const share = $derived(total ? Math.round((gateway.selection.pass / total) * 100) : 0);

  function time(iso: string): string {
    if (!iso) return "—";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function probability(value: number | null): string {
    return value === null ? "—" : value.toFixed(2);
  }

  function latency(value: number | null): string {
    return value === null ? "—" : `${Math.round(value)} ms`;
  }
</script>

<section>
  <h1>Selection</h1>
  <p class="sub">
    {#if total}
      {phrase(total, "decision", "decisions")} across {phrase(gateway.selectionSessions, "session", "sessions")}. {share}% injected a skill; the rest declined or failed before injection.
    {:else}
      No selection has been recorded yet. Every host that asks for a skill writes one row here.
    {/if}
  </p>

  <div class="stats">
    <div><strong>{gateway.selection.pass}</strong><span>Injected</span></div>
    <div><strong>{gateway.selection.reject}</strong><span>Declined</span></div>
    <div><strong>{gateway.selection.error}</strong><span>Failed</span></div>
    <div><strong>{gateway.selection.no_candidates}</strong><span>No candidates</span></div>
  </div>

  <h2>Recent decisions<span class="caption">Newest first, from every host</span></h2>
  <table class="sheet">
    <colgroup>
      <col style="width:12%" /><col style="width:10%" /><col style="width:12%" /><col style="width:18%" /><col style="width:26%" /><col style="width:10%" /><col style="width:12%" />
    </colgroup>
    <thead>
      <tr>
        <th>Time</th><th>Host</th><th>Outcome</th><th>Skill</th><th>Reason</th><th>p</th><th>Latency</th>
      </tr>
    </thead>
    <tbody>
      {#if gateway.decisions.length}
        {#each gateway.decisions as row, index (`${row.timestamp}-${index}`)}
          <tr>
            <td>{time(row.timestamp)}</td>
            <td>{row.platform}</td>
            <td>{row.status}</td>
            <td class="clip">{row.skill ?? "—"}</td>
            <td class="clip">{row.reason ?? "—"}</td>
            <td>{probability(row.probability)}</td>
            <td>{latency(row.latency_ms)}</td>
          </tr>
        {/each}
      {:else}
        <tr><td colspan="7">No decisions recorded yet.</td></tr>
      {/if}
    </tbody>
  </table>
</section>
