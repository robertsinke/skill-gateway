import { readFileSync, writeFileSync } from "node:fs";

const server = new URL("../dist/ui-server/entry-server.js", import.meta.url).href;
const { renderApp } = await import(server);
const shellPath = new URL("../dist/ui/index.html", import.meta.url);
const shell = readFileSync(shellPath, "utf8");
const { head, body } = renderApp();
const page = shell.replace("</head>", `${head}</head>`).replace('<div id="app"></div>', `<div id="app">${body}</div>`);
writeFileSync(shellPath, page);
