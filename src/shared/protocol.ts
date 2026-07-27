// Wire types shared between the browser overlay (client) and the dev-server
// middleware (server). Kept dependency-free so both bundles can import them.

/** A single CSS declaration within a rule. */
export interface SwDecl {
	prop: string;
	value: string;
}

/** An enclosing at-rule, e.g. { name: "media", params: "(min-width: 768px)" }. */
export interface SwAtRule {
	name: string;
	params: string;
}

/** One rule from a component's <style>, expressed in SOURCE terms (no scope hash). */
export interface SwRule {
	selector: string;
	decls: SwDecl[];
	/**
	 * Stable identity: the rule's ordinal among ALL rules in the block, in postcss
	 * walk order (including ones not surfaced, e.g. @keyframes steps). A targeted
	 * save uses this to patch the exact rule instead of "first selector wins".
	 */
	id?: number;
	/**
	 * Enclosing at-rule chain, OUTERMOST first — e.g. a rule inside
	 * `@media (min-width: 768px)` carries `[{ name: 'media', params: '(min-width: 768px)' }]`.
	 * Absent/empty for a top-level rule. Lets the overlay group + label responsive
	 * overrides and evaluate which apply at the current viewport.
	 */
	media?: SwAtRule[];
}

/** Response to `GET /__stylewright/rules?file=<path>`. */
export interface SwRulesResponse {
	file: string;
	hasStyle: boolean;
	rules: SwRule[];
	error?: string;
}

/** Body of `POST /__stylewright/edit`. */
export interface SwEditRequest {
	/** Component file (relative to project root or absolute within it). */
	file: string;
	/** Source selector of the rule to edit, e.g. ".btn". */
	selector: string;
	/** Declaration property, e.g. "color". */
	prop: string;
	/** New value, e.g. "#ff3e00". */
	value: string;
}

/** Response to `POST /__stylewright/edit`. */
export interface SwEditResponse {
	ok: boolean;
	/** True when the file was actually rewritten. */
	changed: boolean;
	/** True when a rule matching `selector` was found. */
	matched: boolean;
	error?: string;
}

/** Response to `GET /__stylewright/style?file=<path>` — the whole-<style> editor model. */
export interface SwStyleResponse {
	file: string;
	hasStyle: boolean;
	/** Raw inner CSS of the component's <style> block. */
	css: string;
	error?: string;
}

/** Body of `POST /__stylewright/style`. */
export interface SwStyleSaveRequest {
	file: string;
	css: string;
}

/** Response to `POST /__stylewright/style`. */
export interface SwStyleSaveResponse {
	ok: boolean;
	changed: boolean;
	/** True when the CSS was rejected as incomplete/invalid (not written). */
	invalid?: boolean;
	/**
	 * True when the write was refused because it would have dropped an at-rule
	 * (@media/@keyframes/@supports/@font-face) present in the source. The flat
	 * whole-block save model can't represent at-rules, so persisting would flatten
	 * a responsive override into an always-on rule — silent data loss. Guard lifts
	 * once the save model is structure-aware.
	 */
	droppedAtRules?: boolean;
	error?: string;
}

/**
 * Body of `POST /__stylewright/apply` — the STRUCTURE-PRESERVING save. The client
 * sends its edited rule model (each rule carrying the `id` from `GET /rules`); the
 * server patches only those rules' declarations back into the parsed source tree,
 * leaving @media/@keyframes/comments/untouched rules intact. Supersedes the flat
 * whole-block `/style` save for components with at-rules.
 */
export interface SwApplyRequest {
	file: string;
	rules: SwRule[];
	/**
	 * Phase 4 structural ops (all keyed by the stable `id` from GET /rules; the client
	 * re-fetches afterward because creating/removing shifts the walk-order ids):
	 * - a rule in `rules` with NO `id` is CREATED (into the @media block named by its
	 *   `media`, creating the block if absent) — the "add a responsive override" path.
	 * - `removeIds` deletes those source rules (pruning a now-empty @media wrapper).
	 * - `mediaRenames` rewrites the params of the @media enclosing each id — moving the
	 *   whole breakpoint (every rule under it).
	 */
	removeIds?: number[];
	mediaRenames?: { id: number; params: string }[];
}

/** Response to `POST /__stylewright/apply`. */
export interface SwApplyResponse {
	ok: boolean;
	changed: boolean;
	/** How many incoming rules were matched to a source rule by id (diagnostic). */
	matched?: number;
	/** Phase 4 structural-op counts (diagnostic). */
	created?: number;
	removed?: number;
	renamed?: number;
	error?: string;
}

// ---------------------------------------------------------------------------
// AI path — overlay ⇄ broker ⇄ MCP server.
//
// The overlay is an INTENT-CAPTURE surface: it never renders a conversation and
// never edits a file. It enqueues a request; a deliberately linked agent session
// claims it over MCP and does the writing under its own permission/diff flow.
// ---------------------------------------------------------------------------

/** Hard limits enforced by the broker. Shared so the client can pre-trim. */
export const SW_AI_LIMITS = {
	prompt: 2000,
	outerHTML: 4096,
	styleRules: 100,
	elementText: 200,
	queueDepth: 20
} as const;

/** One AI edit request captured from the overlay. */
export interface SwAiRequest {
	/** crypto.randomUUID() — correlation id across overlay, broker and agent. */
	id: string;
	/** Date.now() at Send. */
	createdAt: number;
	prompt: string;

	source: {
		/** Project-relative .svelte file from __svelte_meta (validated server-side). */
		file: string;
		/** Basename without extension, e.g. "Button". */
		componentName?: string;
		line?: number;
		column?: number;
	};

	element: {
		/** `<button class="btn">` — tagLabel(node). */
		tag: string;
		tagName: string;
		id?: string;
		classList: string[];
		/** Best-effort CSS path within the component, e.g. ".card > .btn". */
		selector: string;
		/** Trimmed, ≤ SW_AI_LIMITS.elementText chars. */
		text?: string;
		rect: { width: number; height: number };
	};

	context: {
		/** ≤ SW_AI_LIMITS.outerHTML, truncated on a tag boundary with a marker. */
		outerHTML: string;
		parentTag?: string;
		/**
		 * The rules Stylewright ALREADY parsed for this component — source selectors,
		 * decls and @media chain. Cheap for us, expensive for the agent to re-derive,
		 * and the single biggest accuracy win available: it removes most "the agent
		 * rewrote the wrong selector" failures.
		 */
		styleRules?: SwRule[];
		/** Only properties the overlay knows are interesting — never a full
		 *  getComputedStyle dump. */
		computed?: Record<string, string>;
	};

	page: {
		route: string;
		url: string;
		viewport: { width: number; height: number; dpr: number };
		/** Active @media min-width the overlay is previewing, if any. */
		breakpoint?: number;
		colorScheme: 'light' | 'dark';
	};
}

/**
 * `watching` — the session has an open `stylewright_watch` call, so a request is
 * delivered the moment it is queued.
 * `connected` — the MCP process is up but nothing is watching. A request will sit
 * in the queue until the agent arms a watch. We show this differently from
 * `watching` on purpose: it is the difference between "will happen" and "needs
 * one more action from you".
 * `gone` — process exited or missed its liveness window.
 */
export type SwAiSessionState = 'watching' | 'connected' | 'gone';

export interface SwAiSession {
	/** Stable for the life of the MCP process. */
	id: string;
	/** User-facing name (STYLEWRIGHT_SESSION_NAME, else <basename(cwd)>-<n>). */
	name: string;
	/** From MCP initialize clientInfo.name, normalised to a vendor label from
	 *  shared/vendors.ts, or the raw client name when nothing matches. Named
	 *  rather than enumerated here: the union drifted behind the table twice. */
	tool: string;
	/** Absolute cwd reported by the MCP process, shown tilde-shortened. */
	cwd: string;
	/** True when cwd is inside the Vite project root — foreign-project sessions are
	 *  listed last and badged, never hidden. */
	sameProject: boolean;
	state: SwAiSessionState;
	connectedAt: number;
	lastSeenAt: number;
	/** How long one `stylewright_watch` lasts in THIS client before it lapses and
	 *  the agent's turn ends. Claude Code backgrounds long calls so it is minutes;
	 *  Cline kills them at its configured timeout. The overlay quotes it rather
	 *  than making a promise that is only true for one of them. */
	watchMs?: number;
}

export type SwAiStatus = 'idle' | 'sending' | 'queued' | 'working' | 'needs_input' | 'done' | 'error';

/** A file the agent reported touching. */
export interface SwAiFileTouch {
	path: string;
	mark: 'M' | 'A' | 'D';
	note?: string;
}

/** How to register the MCP server on THIS machine. Computed by the dev server
 *  rather than hard-coded, because the published command is a 404 for anyone
 *  running from a checkout — and a 404 on the setup screen reads as "broken". */
export interface SwAiSetup {
	/** Command to run, e.g. `npx vite-plugin-stylewright mcp`. Empty when the
	 *  MCP bin has not been built. */
	command: string;
	/** True when the short published form is what we're recommending. */
	published: boolean;
	/** Absolute path to the bin, for editors that want command + args. */
	binPath: string | null;
}

/**
 * One request and everything that happened to it. The overlay keeps a running
 * log of these rather than a single dismissable status screen: a task you
 * finished is still the most useful thing on screen when you write the next one,
 * and making someone press a button to clear it is friction with no payoff.
 */
export interface SwAiTask {
	id: string;
	prompt: string;
	/** Component this was asked about, for the card's subtitle. */
	file: string;
	status: SwAiStatus;
	message?: string;
	filesTouched?: SwAiFileTouch[];
	createdAt: number;
	updatedAt: number;
}

/** How many tasks the broker remembers. Old ones fall off the top. */
export const SW_AI_HISTORY = 50;

/** The whole AI state, snapshotted to every overlay client over SSE. */
export interface SwAiState {
	sessions: SwAiSession[];
	/** How to register an agent here — see SwAiSetup. */
	setup?: SwAiSetup;
	/** Bound session id, or null. */
	boundId: string | null;
	/** True when boundId names a session that is no longer reachable. */
	offline: boolean;
	/** Oldest first. The last entry may still be running. */
	tasks?: SwAiTask[];
	current?: {
		requestId: string;
		status: SwAiStatus;
		message?: string;
		filesTouched?: SwAiFileTouch[];
		startedAt: number;
		updatedAt: number;
	};
}

/** `POST /__stylewright/ai/send` → this. */
export interface SwAiSendResponse {
	ok: boolean;
	requestId?: string;
	status?: SwAiStatus;
	/** Set when ok is false: 'no_session' | 'offline' | 'queue_full' | 'busy' | 'bad_request'. */
	reason?: string;
	error?: string;
}

// --- MCP-facing (token-gated; never reachable from a page) ---

/** `POST /__stylewright/ai/agent/hello` body. */
export interface SwAgentHello {
	clientInfo?: { name?: string; version?: string };
	cwd: string;
	/** Preferred display name (STYLEWRIGHT_SESSION_NAME). */
	name?: string;
	/** How long one watch lasts in this client. See SwAiSession.watchMs. */
	watchMs?: number;
}

/** `POST /__stylewright/ai/agent/hello` response. */
export interface SwAgentHelloResponse {
	sessionId: string;
	name: string;
	/** True when this session is the currently bound one. */
	bound: boolean;
}

/** `POST /__stylewright/ai/agent/claim` response — a request, or an idle tick. */
export type SwAgentClaimResponse =
	| { status: 'request'; request: SwAiRequest }
	| { status: 'idle' }
	| { status: 'not_bound'; boundName: string | null };

/** `POST /__stylewright/ai/agent/report` body. */
export interface SwAgentReport {
	requestId: string;
	status: 'working' | 'needs_input' | 'done' | 'error';
	message?: string;
	filesTouched?: SwAiFileTouch[];
}
