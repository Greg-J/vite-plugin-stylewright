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
