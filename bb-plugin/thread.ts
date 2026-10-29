import { useBbContext } from "@get-bb/plugin-sdk/app";

const KEY = "skill-gateway:last-thread";

/**
 * The thread a surface should describe. The SDK documents `threadId` from the
 * route, but a plugin panel lives on its own route, so opening it would lose
 * the thread that was just in view. The overlay therefore remembers the last
 * thread it saw, and the panel falls back to that.
 */
export function useThreadId(): string | null {
  const { threadId } = useBbContext();
  return threadId ?? rememberedThreadId();
}

export function rememberThreadId(threadId: string): void {
  try {
    localStorage.setItem(KEY, threadId);
  } catch {
    // Storage can be unavailable; the panel then simply shows no "this thread".
  }
}

export function rememberedThreadId(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
