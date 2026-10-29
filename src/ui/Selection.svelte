<script lang="ts">
  import { phrase } from "./lib/format";
  import { gateway } from "./state.svelte";

  const total = $derived(
    gateway.selection.pass + gateway.selection.reject + gateway.selection.error + gateway.selection.no_candidates,
  );
  const share = $derived(total ? Math.round((gateway.selection.pass / total) * 100) : 0);
  const mine = $derived(gateway.threadDecisions);
  const latest = $derived(mine[0] ?? null);
  const summary = $derived.by(() => {
    if (!gateway.threadDecisions[0]) return "";
    const row = gateway.threadDecisions[0];
    const outcome = row.skill
      ? `${row.skill} was injected`
      : row.status === "error"
        ? "the gate got no answer, so nothing was injected"
        : "no skill was injected";
    const why = row.reason ? ` — ${row.reason}${row.failure ? ` (${row.failure})` : ""}` : "";
    const gate = row.probability === null ? "" : ` (p ${probability(row.probability)})`;
    const took = row.latency_ms === null ? "" : `, ${latency(row.latency_ms)}`;
    return `Last turn at ${time(row.timestamp)}: ${outcome}${why}${gate}${took}.`;
  });

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
  {#if gateway.thread}
    <h1>This thread</h1>
    <p class="sub">
      {#if latest}
        {summary}
        {phrase(mine.length, "decision", "decisions")} in this thread so far.
      {:else}
        No selection recorded for this thread yet. One row is written per turn, so the next message you send appears here.
      {/if}
    </p>

    {#if mine.length}
      <table class="sheet">
        <thead>
          <tr><th>Time</th><th>Outcome</th><th>Skill</th><th>Reason</th><th>p</th><th>Latency</th></tr>
        </thead>
        <tbody>
          {#each mine as row, index (`thread-${row.timestamp}-${index}`)}
            <tr>
              <td>{time(row.timestamp)}</td>
              <td>{row.status}</td>
              <td class="clip">{row.skill ?? "—"}</td>
              <td class="clip">{row.reason ?? "—"}{row.failure ? ` (${row.failure})` : ""}</td>
              <td>{probability(row.probability)}</td>
              <td>{latency(row.latency_ms)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {/if}
  <h1>{gateway.thread ? "Everything" : "Selection"}</h1>
  <p class="sub">
    {#if total}
      {phrase(total, "decision", "decisions")} across {phrase(gateway.selectionSessions, "session", "sessions")}. {share}% injected a skill; the rest declined or failed before injection.{#if gateway.selectionTruncated} Showing the newest {gateway.decisions.length} of {gateway.selectionTotal}.{/if}
    {:else if gateway.problem}
      These counts load from the gateway's data server, which is not answering right now.
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
            <td class="clip">{row.reason ?? "—"}{row.failure ? ` (${row.failure})` : ""}</td>
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
