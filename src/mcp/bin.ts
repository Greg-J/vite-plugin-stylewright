#!/usr/bin/env node
// `npx vite-plugin-stylewright mcp` — the MCP server an agent registers.
//
//   claude mcp add stylewright -- npx vite-plugin-stylewright mcp
//
// stdout is the JSON-RPC channel and must carry nothing else, so every
// diagnostic goes to stderr.
//
// `... proxy` runs Stylewright in front of an app that is not Svelte + Vite.
// It lives in its own bundle (dist/proxy.js), loaded only for that command, so
// the MCP server stays dependency-free.

import { runStdio } from './server.js';

const argv = process.argv.slice(2);
const cmd = argv[0];

if (cmd === 'proxy') {
	// A computed specifier, so the bundler leaves it as a runtime import of the
	// sibling bundle instead of pulling the proxy (and postcss) into this file.
	const mod = await import(new URL('./proxy.js', import.meta.url).href);
	await mod.runProxyCli(argv.slice(1));
} else if (cmd === '--help' || cmd === '-h' || (!cmd && process.stdin.isTTY)) {
	process.stderr.write(
		'vite-plugin-stylewright — MCP server\n\n' +
		'Usage:\n' +
		'  npx vite-plugin-stylewright mcp     Run the MCP server on stdio.\n' +
		'  npx vite-plugin-stylewright proxy   Run Stylewright in front of an app that is not\n' +
		'                                      Svelte + Vite (see `proxy --help`).\n\n' +
		'Register with Claude Code:\n' +
		'  claude mcp add stylewright -- npx vite-plugin-stylewright mcp\n\n' +
		'Cline: add the same command as an MCP server in Cline’s MCP settings.\n\n' +
		'Environment:\n' +
		'  STYLEWRIGHT_SESSION_NAME  Name shown in the overlay (default: the folder name).\n' +
		'  STYLEWRIGHT_URL/_TOKEN    Point at a dev server explicitly (containers, remote ports).\n'
	);
	process.exit(cmd ? 0 : 1);
} else if (cmd && cmd !== 'mcp') {
	process.stderr.write(`Unknown command: ${cmd}\nRun with --help for usage.\n`);
	process.exit(1);
} else {
	runStdio().catch((err) => {
		process.stderr.write(`[stylewright] fatal: ${String(err)}\n`);
		process.exit(1);
	});
}
