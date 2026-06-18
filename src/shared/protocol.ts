// Wire types shared between the browser overlay (client) and the dev-server
// middleware (server). Kept dependency-free so both bundles can import them.

/** A single CSS declaration within a rule. */
export interface SwDecl {
	prop: string;
	value: string;
}

/** One rule from a component's <style>, expressed in SOURCE terms (no scope hash). */
export interface SwRule {
	selector: string;
	decls: SwDecl[];
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
