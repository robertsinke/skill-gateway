/**
 * One data entry for the dashboard, so the same build runs twice:
 * standalone from `serve.ts` (paths hit this origin), or inside BB's plugin
 * panel (paths are relayed through the plugin, which owns the port).
 */
const proxy = (globalThis as { __SKILL_GATEWAY_PROXY__?: string }).__SKILL_GATEWAY_PROXY__;

export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!proxy) return fetch(path, init);
  const separator = proxy.includes("?") ? "&" : "?";
  return fetch(`${proxy}${separator}path=${encodeURIComponent(path)}`, init);
}
