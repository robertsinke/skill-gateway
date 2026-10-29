// The panel iframe cannot inherit CSS, so the host reads its own theme tokens
// and posts them in. Re-read on every theme change: BB swaps tokens on <html>.
import { useEffect, useRef } from "react";

const TOKENS = [
  "--canvas",
  "--background",
  "--ink",
  "--foreground",
  "--primary",
  "--primary-foreground",
  "--muted-foreground",
  "--subtle-foreground",
  "--border",
  "--accent",
  "--secondary",
  "--muted",
  "--font-sans",
  "--font-mono",
  "--success",
  "--destructive",
] as const;

type ThemeMessage = { type: "skill-gateway-theme"; dark: boolean; tokens: Record<string, string> };

function readTheme(): ThemeMessage {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const tokens: Record<string, string> = {};
  for (const token of TOKENS) {
    const value = style.getPropertyValue(token).trim();
    if (value) tokens[token] = value;
  }
  const dark =
    root.classList.contains("dark") ||
    root.dataset.theme === "dark" ||
    (root.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  return { type: "skill-gateway-theme", dark, tokens };
}

export function ThemedDashboard({ src }: { src: string }) {
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const send = () => frame.current?.contentWindow?.postMessage(readTheme(), "*");
    send();
    const observer = new MutationObserver(send);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", send);
    frame.current?.addEventListener("load", send);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", send);
    };
  }, []);

  return (
    <iframe
      ref={frame}
      src={src}
      title="Skill Gateway"
      onLoad={() => frame.current?.contentWindow?.postMessage(readTheme(), "*")}
      style={{ border: 0, width: "100%", height: "100%", display: "block", background: "transparent" }}
    />
  );
}
