<script lang="ts">
  import type { PreviewRow } from "./lib/types";
  import { gateway } from "./state.svelte";

  let nameQuery = $state("");
  let open = $state(false);
  let description = $state("");
  let messages = $state(["", "", ""]);
  let saved = $state("");
  let rows = $state<PreviewRow[]>([]);
  let timer = 0;
  let loadedName = "";

  const browsing = $derived(!nameQuery.trim() || nameQuery.trim().toLowerCase() === gateway.selectedName.toLowerCase());
  const choices = $derived(
    browsing ? gateway.skills : gateway.skills.filter((skill) => skill.name.toLowerCase().includes(nameQuery.trim().toLowerCase())),
  );

  $effect(() => {
    const skill = gateway.skill();
    if (!skill || skill.name === loadedName) return;
    loadedName = skill.name;
    nameQuery = skill.name;
    description = skill.description;
    messages = [skill.targets[0] ?? "", skill.targets[1] ?? "", skill.targets[2] ?? ""];
    saved = "";
    schedule();
  });

  function schedule(): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void preview(), 250);
  }

  function object(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  async function preview(): Promise<void> {
    const skill = gateway.skill();
    if (!skill) return;
    const response = await fetch("/api/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: skill.name, description, targets: messages }),
    });
    const body: unknown = await response.json();
    const report = object(body);
    rows = Array.isArray(report?.rows)
      ? report.rows.flatMap((item): PreviewRow[] => {
          const row = object(item);
          if (!row || typeof row.target !== "string") return [];
          const above = Array.isArray(row.above) ? row.above.filter((entry): entry is string => typeof entry === "string") : [];
          return [{ target: row.target, ok: row.ok === true, rank: typeof row.rank === "number" ? row.rank : null, above }];
        })
      : [];
  }

  async function fill(): Promise<void> {
    const skill = gateway.skill();
    if (!skill) return;
    const response = await fetch(`/api/suggest?name=${encodeURIComponent(skill.name)}`);
    const body: unknown = await response.json();
    const report = object(body);
    const suggested = Array.isArray(report?.messages) ? report.messages.filter((item): item is string => typeof item === "string") : [];
    if (!suggested.length) {
      saved = "No queries for this skill yet.";
      return;
    }
    messages = [suggested[0] ?? "", suggested[1] ?? "", suggested[2] ?? ""];
    saved = "";
    schedule();
  }

  async function save(): Promise<void> {
    const skill = gateway.skill();
    if (!skill) return;
    const targets = messages.map((item) => item.trim());
    const response = await fetch("/api/targets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: skill.name, targets }),
    });
    const body: unknown = await response.json();
    const report = object(body);
    if (!response.ok) {
      saved = typeof report?.error === "string" ? report.error : "Could not save.";
      return;
    }
    if (Array.isArray(report?.targets)) skill.targets = report.targets.filter((item): item is string => typeof item === "string");
    saved = "Saved.";
  }

  function choose(name: string): void {
    gateway.selectedName = name;
    loadedName = "";
    open = false;
  }

  function place(row: PreviewRow): string {
    return row.rank == null ? "not in the list" : `place ${row.rank}`;
  }

  function detail(row: PreviewRow): string {
    if (row.ok) return "Would be found.";
    const above = row.above.slice(0, 5).join(", ");
    return above ? `Above it: ${above}` : "Would be missed.";
  }
</script>

<svelte:window
  onclick={(event) => {
    const target = event.target;
    if (target instanceof Node && !target.parentElement?.closest(".picker") && !(target instanceof Element && target.closest(".picker"))) open = false;
  }}
/>

<section>
  <div class="head">
    <div>
      <h1>Router</h1>
      <p class="sub">A message gets a shortlist of matching skills. The agent can ask for the next matches.</p>
    </div>
  </div>
  <div class="picker" class:open>
    <div class="field">
      <input
        type="text"
        placeholder="Skill"
        autocomplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls="library"
        aria-label="Skill"
        bind:value={nameQuery}
        onfocus={() => (open = true)}
        oninput={() => (open = true)}
        onkeydown={(event) => {
          if (event.key === "Escape") open = false;
        }}
      />
      <span class="chevron" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" /></svg></span>
    </div>
    <div class="library">
      <table>
        <tbody id="library">
          {#if choices.length}
            {#each choices as skill (skill.name)}
              <tr class="pick" aria-selected={skill.name === gateway.selectedName} onclick={() => choose(skill.name)}>
                <td>{skill.name}</td>
              </tr>
            {/each}
          {:else}
            <tr><td>No skill by that name.</td></tr>
          {/if}
        </tbody>
      </table>
    </div>
  </div>
  <div class="field">
    <textarea id="description" placeholder="What this skill is for" bind:value={description} oninput={schedule}></textarea>
    <label for="description">Description</label>
  </div>
  <div>
    {#each rows as row (`${row.target}-${row.rank ?? "x"}`)}
      <div class="row" class:ok={row.ok} class:bad={!row.ok}>
        <div class="rank">{place(row)}</div>
        <div>{row.target}</div>
        <div class="detail">{detail(row)}</div>
      </div>
    {/each}
  </div>
  <h2>Example messages</h2>
  <p class="sub">A writing check for this skill. Fill them from real queries when the skill already has a history, then save if you want to keep them.</p>
  {#each [0, 1, 2] as index (index)}
    <div class="field">
      <input
        id="message-{index + 1}"
        type="text"
        placeholder="A message that should find this skill"
        autocomplete="off"
        value={messages[index]}
        oninput={(event) => {
          const next = [...messages];
          next[index] = event.currentTarget.value;
          messages = next;
          saved = "";
          schedule();
        }}
      />
      <label for="message-{index + 1}">Message {index + 1}</label>
    </div>
  {/each}
  <button class="action quiet" type="button" onclick={() => void fill()}>
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v7M5.5 6.5L8 9l2.5-2.5" /><path d="M3 11v2h10v-2" /></svg>
    Fill from queries
  </button>
  <button class="action" type="button" onclick={() => void save()}>
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" /></svg>
    Save messages
  </button>
  <p class="sub">{saved}</p>
</section>
