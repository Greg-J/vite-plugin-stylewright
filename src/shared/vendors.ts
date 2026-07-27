// The agent vendors Stylewright knows how to talk to.
//
// One table, shared by three places that must never disagree:
//   • the MCP process, for how long a `stylewright_watch` may block
//   • the broker, for badging a session with the right product name
//   • the overlay, for the setup instructions it prints
//
// Adding a vendor is an entry here plus nothing else. Everything downstream is
// derived, which is the whole point: the last time these lived in three places
// the overlay told Cline users to run a `claude` command.
//
// The awkward part of this table is `watchMs`. Every client kills a tool call
// eventually, and they disagree wildly about when, in what unit, and whether the
// setting can be raised at all.
// A watch that outlives its client's limit is not "patient": the call is killed,
// the agent's turn ends, and any request that arrives afterwards is handed to a
// call nobody is listening to. So each vendor carries a number we can defend.

export interface VendorRegister {
	/** A shell command to run once. */
	cli?: (command: string) => string;
	/** A config file to paste into, with a human description of where it lives. */
	json?: {
		where: string;
		file: string;
		build: (command: string, watchMs: number) => unknown;
	};
}

export interface AgentVendor {
	id: string;
	label: string;
	/** Fragments matched against MCP `clientInfo.name`, punctuation stripped and
	 *  lower-cased, because the same product spells itself several ways. */
	match: string[];
	/**
	 * How long one watch may block assuming the user did NOT take our generated
	 * config — i.e. the vendor's own default tool timeout, minus a margin.
	 */
	safeWatchMs: number;
	/** What our generated config actually enables. Written into the config as
	 *  STYLEWRIGHT_WATCH_MS so the MCP process and the config cannot drift. */
	configuredWatchMs: number;
	/** Shown when the window is short enough to be a nuisance. */
	watchNote?: string;
	register: VendorRegister;
}

const SERVER_NAME = 'stylewright';

/** `node /abs/dist/mcp.js mcp` → `['node', '/abs/dist/mcp.js', 'mcp']` */
export function splitCommand(command: string): string[] {
	return command.trim().split(/\s+/).filter(Boolean);
}

export const VENDORS: AgentVendor[] = [
	{
		id: 'claude',
		label: 'Claude Code',
		match: ['claudecode', 'claude'],
		// Moves a call still running after ~2 minutes to a background task and
		// delivers the result as a task notification, so waiting costs nothing.
		safeWatchMs: 1_500_000,
		configuredWatchMs: 1_500_000,
		register: {
			cli: (command) => `claude mcp add ${SERVER_NAME} -- ${command}`
		}
	},
	{
		id: 'cline',
		label: 'Cline',
		match: ['cline'],
		// Kills a tool call at its per-server `timeout`, which defaults to 60s.
		safeWatchMs: 50_000,
		// Our config raises that to the slider maximum (1 hour) and matches the
		// watch to it, so one arming lasts the session in practice.
		configuredWatchMs: 3_540_000,
		watchNote: 'Cline caps tool calls at its `timeout` setting — the config below raises it to an hour.',
		register: {
			json: {
				where: 'MCP Servers icon → Configure → Configure MCP Servers, then paste:',
				file: 'cline_mcp_settings.json',
				build: (command, watchMs) => {
					const [cmd, ...args] = splitCommand(command);
					return {
						mcpServers: {
							[SERVER_NAME]: {
								command: cmd, args,
								timeout: Math.ceil((watchMs + 60_000) / 1000),
								env: { STYLEWRIGHT_WATCH_MS: String(watchMs) }
							}
						}
					};
				}
			}
		}
	},
	{
		id: 'opencode',
		label: 'OpenCode',
		match: ['opencode'],
		// Measured against opencode 1.18.4, not inferred: with no `timeout` set a
		// request dies at ~30s, and a configured `timeout` is honoured well past
		// that (a 90s setting held a 70s call). It is in MILLISECONDS here, unlike
		// Cline's seconds — the single most likely thing to get wrong by hand,
		// which is why this is generated.
		safeWatchMs: 25_000,
		configuredWatchMs: 3_540_000,
		// OpenCode also passes `resetTimeoutOnProgress`, so the watch's progress
		// heartbeat restarts its timer and the configured ceiling is never reached
		// in practice. The number is still set, because a client that stops
		// resetting should degrade to "re-arms hourly", not "dies at 30 seconds".
		register: {
			json: {
				where: 'Add to opencode.json (project root, or ~/.config/opencode/opencode.json):',
				file: 'opencode.json',
				build: (command, watchMs) => ({
					$schema: 'https://opencode.ai/config.json',
					mcp: {
						[SERVER_NAME]: {
							type: 'local',
							command: splitCommand(command),
							enabled: true,
							timeout: watchMs + 60_000,
							environment: { STYLEWRIGHT_WATCH_MS: String(watchMs) }
						}
					}
				})
			}
		}
	},
	{
		id: 'kimi',
		label: 'Kimi Code',
		// `clientInfo.name` is the literal "kimi-code" (its MCP connection
		// manager), which normalises to "kimicode"; bare "kimi" also catches the
		// web client, which reports "kimi-code-web".
		match: ['kimicode', 'kimi'],
		// Read out of kimi 0.29.2, not inferred. Its MCP layer hands the SDK only
		// `{ timeout, signal }`, so an unset `toolTimeoutMs` falls through to the
		// SDK's own `?? 6e4` — a hard 60s.
		safeWatchMs: 50_000,
		configuredWatchMs: 3_540_000,
		// The trap: Kimi never passes `resetTimeoutOnProgress`, so the SDK default
		// of `false` applies and our 10s progress heartbeat does NOT restart the
		// timer the way OpenCode's does. `toolTimeoutMs` is a hard ceiling on one
		// watch rather than a soft one — Cline's semantics in OpenCode's unit,
		// which is the worst pairing of the three and the reason this is generated
		// rather than written by hand.
		watchNote: 'Kimi Code kills a tool call at 60 seconds unless `toolTimeoutMs` says otherwise — the config below raises it to an hour.',
		register: {
			json: {
				// Kimi also reads a project-root `.mcp.json` in the Claude shape,
				// but we name its own file: that one is shared with other tools, so
				// pasting into it changes what they load too.
				where: 'Add to ~/.kimi-code/mcp.json (user-global), or .kimi-code/mcp.json inside the project:',
				file: 'mcp.json',
				build: (command, watchMs) => {
					const [cmd, ...args] = splitCommand(command);
					return {
						mcpServers: {
							[SERVER_NAME]: {
								command: cmd, args,
								// Milliseconds, unlike Cline's seconds.
								toolTimeoutMs: watchMs + 60_000,
								env: { STYLEWRIGHT_WATCH_MS: String(watchMs) }
							}
						}
					};
				}
			}
		}
	}
];

export const DEFAULT_VENDOR = 'claude';

export function vendorById(id: string): AgentVendor | undefined {
	return VENDORS.find((v) => v.id === id);
}

/** Match an MCP `clientInfo.name` to a vendor. */
export function vendorForClient(clientName: string): AgentVendor | undefined {
	const k = (clientName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
	if (!k) return undefined;
	for (const v of VENDORS) {
		for (const m of v.match) if (k.includes(m)) return v;
	}
	return undefined;
}
