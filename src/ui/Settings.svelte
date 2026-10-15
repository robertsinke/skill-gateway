<script lang="ts">
  import { onMount } from "svelte";

  let key = $state("");
  let keyConfigured = $state(false);
  let keyUnlocked = $state(false);
  let keyUpdated = $state<string | null>(null);
  let keyMessage = $state("");

  onMount(() => {
    void loadSettings();
  });

  async function loadSettings(): Promise<void> {
    const response = await fetch("/api/settings");
    const body = (await response.json()) as { typesafe?: { configured?: boolean; unlocked?: boolean; updated_at?: string | null } };
    keyConfigured = body.typesafe?.configured === true;
    keyUnlocked = body.typesafe?.unlocked === true;
    keyUpdated = body.typesafe?.updated_at ?? null;
  }

  async function saveKey(): Promise<void> {
    keyMessage = "Saving…";
    const response = await fetch("/api/settings/typesafe-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
    const body = (await response.json()) as { error?: string; typesafe?: { configured?: boolean; unlocked?: boolean; updated_at?: string | null } };
    if (!response.ok) {
      keyMessage = body.error ?? "Could not save the key.";
      return;
    }
    key = "";
    keyConfigured = body.typesafe?.configured === true;
    keyUnlocked = body.typesafe?.unlocked === true;
    keyUpdated = body.typesafe?.updated_at ?? null;
    keyMessage = "Saved securely on this Mac.";
  }

  async function removeKey(): Promise<void> {
    const response = await fetch("/api/settings/typesafe-key", { method: "DELETE" });
    if (response.ok) {
      keyConfigured = false;
      keyUnlocked = false;
      keyUpdated = null;
      keyMessage = "Removed.";
    }
  }

</script>

<section>
  <div class="head">
    <div>
      <h1>Settings</h1>
      <p class="sub">Credentials for optional semantic reranking.</p>
    </div>
  </div>

  <section class="settings-section">
    <h2>TypeSafe connection</h2>
    <p class="sub">Stored securely on this Mac. You only paste the key once; no passphrase or unlock step is needed.</p>
    <div class="setting-status" class:configured={keyConfigured} class:unlocked={keyUnlocked}>
      <span class="status-dot" aria-hidden="true"></span>
      <span>{keyConfigured ? `Configured${keyUpdated ? ` · ${new Date(keyUpdated).toLocaleString()}` : ""}` : "Not configured"}</span>
    </div>
    <div class="field">
      <input id="typesafe-key" type="password" placeholder="Paste a TypeSafe API key" bind:value={key} autocomplete="off" />
      <label for="typesafe-key">API key</label>
    </div>
    <button class="action" type="button" onclick={() => void saveKey()}>Save key</button>
    {#if keyConfigured}<button class="action quiet" type="button" onclick={() => void removeKey()}>Remove key</button>{/if}
    <p class="sub setting-message">{keyMessage}</p>
  </section>

</section>
