<script lang="ts">
  import { phrase, sourceLine } from "./lib/format";
  import type { RemovableCopy, ScanReport, SortKey } from "./lib/types";
  import { gateway } from "./state.svelte";

  let query = $state("");
  let sortKey = $state<SortKey>("uses");
  let sortDescending = $state(true);
  let scanning = $state(false);
  let scanLabel = $state("Scan this machine");
  let scanOpen = $state(false);
  let reportVisible = $state(false);
  let reports = $state<ScanReport[]>([]);
  let removable = $state<RemovableCopy[]>([]);

  const visible = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    const rows = gateway.skills.filter((skill) => {
      if (!needle) return true;
      return [skill.name, skill.description, sourceLine(skill), skill.status].join(" ").toLowerCase().includes(needle);
    });
    rows.sort((a, b) => {
      const left = sortValue(a);
      const right = sortValue(b);
      const diff = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right), undefined, { sensitivity: "base" });
      if (diff) return sortDescending ? -diff : diff;
      return a.name.localeCompare(b.name);
    });
    return rows;
  });

  function sortValue(skill: (typeof gateway.skills)[number]): string | number {
    if (sortKey === "uses") return skill.uses;
    if (sortKey === "added") return skill.addedAt;
    if (sortKey === "source") return sourceLine(skill);
    return skill[sortKey];
  }

  function sortBy(key: SortKey): void {
    if (sortKey === key) sortDescending = !sortDescending;
    else {
      sortKey = key;
      sortDescending = key === "uses" || key === "added";
    }
  }

  function ariaSort(key: SortKey): "ascending" | "descending" | undefined {
    if (sortKey !== key) return undefined;
    return sortDescending ? "descending" : "ascending";
  }

  function pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function scanMachine(): Promise<void> {
    scanning = true;
    scanLabel = "Scanning";
    scanOpen = true;
    reportVisible = false;
    reports = [];
    removable = [];
    const places = await gateway.places();
    const next: ScanReport[] = [];
    for (const place of places) {
      scanLabel = `Scanning ${place.place}`;
      const report = await gateway.scanPlace(place.relative);
      if (report) next.push(report);
    }
    reportVisible = true;
    await pause(90);
    for (const report of next) {
      reports = [...reports, report];
      removable = [...removable, ...report.removable];
      await pause(170);
    }
    scanning = false;
    scanLabel = "Scan this machine";
    await gateway.load();
  }

  async function removeCopies(paths: RemovableCopy[]): Promise<void> {
    if (!paths.length) return;
    const ok = window.confirm(`Remove ${paths.length} copies from agent folders? The library copies stay. Skills Manager folders stay.`);
    if (!ok) return;
    const removed = new Set(await gateway.remove(paths.map((item) => item.path)));
    removable = removable.filter((item) => !removed.has(item.path));
  }

  const columns: { key: SortKey; label: string; numeric: boolean }[] = [
    { key: "name", label: "Skill", numeric: false },
    { key: "description", label: "Description", numeric: false },
    { key: "source", label: "Source", numeric: false },
    { key: "added", label: "Added", numeric: false },
    { key: "uses", label: "Uses", numeric: true },
    { key: "status", label: "Status", numeric: false },
  ];
</script>

<svelte:window
  onclick={(event) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (scanOpen && !target.parentElement?.closest("#scan-pop") && !target.parentElement?.closest("#scan") && !(target instanceof Element && (target.closest("#scan-pop") || target.closest("#scan")))) {
      scanOpen = false;
    }
  }}
  onkeydown={(event) => {
    if (event.key === "Escape" && scanOpen) scanOpen = false;
  }}
/>

<section>
  <div class="head">
    <div>
      <h1>Skills</h1>
      <p class="sub">You have {phrase(gateway.skills.length, "skill", "skills")}.</p>
    </div>
    <div class="head-tools">
      <label class="search">
        <input id="skill-search" type="search" placeholder="Search skills..." autocomplete="off" bind:value={query} />
        <kbd>/</kbd>
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>
      </label>
      <div class="scan-anchor">
        <button
          id="scan"
          class="action"
          class:busy={scanning}
          type="button"
          title={scanLabel}
          aria-label={scanLabel}
          aria-expanded={scanOpen}
          aria-controls="scan-pop"
          disabled={scanning}
          onclick={() => void scanMachine()}
        >
          <svg class="scan-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 8l3.2-1.6" /><circle cx="8" cy="8" r="1" /><path d="M4.2 11.6a4.8 4.8 0 1 1 7.6 0" /><path d="M5.7 10.2a2.8 2.8 0 1 1 4.6 0" /></svg>
          <svg class="loading" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5a5.5 5.5 0 1 1-4.6 2.5" /></svg>
        </button>
        <div id="scan-pop" class="scan-pop" hidden={!scanOpen}>
          <div class="report" hidden={!reportVisible}>
            <table>
              <colgroup>
                <col style="width:36%" /><col style="width:12%" /><col style="width:12%" /><col style="width:18%" /><col style="width:22%" />
              </colgroup>
              <thead><tr><th>Source</th><th>Found</th><th>Added</th><th>Duplicates</th><th></th></tr></thead>
              <tbody>
                {#each reports as report (report.source.place)}
                  <tr class="arrive">
                    <td>{report.source.place}<div class="detail">{report.source.relative}</div></td>
                    <td>{report.source.found}</td>
                    <td>{report.source.added}</td>
                    <td>{report.source.duplicates}</td>
                    <td>
                      {#if report.source.removable && removable.some((item) => item.place === report.source.place)}
                        <button class="action" type="button" onclick={() => void removeCopies(removable.filter((item) => item.place === report.source.place))}>Remove</button>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <button class="action" type="button" hidden={!removable.length} onclick={() => void removeCopies(removable)}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M6 4V3h4v1M5 4l1 9h4l1-9" /></svg>
            Remove the other copies
          </button>
        </div>
      </div>
    </div>
  </div>
  <div class="sheet-scroll">
    <table class="sheet">
      <thead>
        <tr>
          {#each columns as column (column.key)}
            <th class:num={column.numeric} aria-sort={ariaSort(column.key)}>
              <button class="sort" type="button" onclick={() => sortBy(column.key)}>
                {column.label}
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
              </button>
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#if visible.length}
          {#each visible as skill (skill.name)}
            <tr class="skill" aria-selected={skill.name === gateway.selectedName} onclick={() => gateway.select(skill.name)}>
              <td class="name clip">{skill.name}</td>
              <td class="desc"><span title={skill.description}>{skill.description}</span></td>
              <td class="source clip" title={sourceLine(skill)}>{sourceLine(skill)}</td>
              <td>{skill.added}</td>
              <td class="num">{skill.uses}</td>
              <td class="clip">{skill.status}</td>
            </tr>
          {/each}
        {:else}
          <tr><td colspan="6">No skill matches.</td></tr>
        {/if}
      </tbody>
    </table>
  </div>
</section>