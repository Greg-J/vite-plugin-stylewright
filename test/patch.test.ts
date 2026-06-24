import { describe, it, expect } from 'vitest';
import { applyEdit, readRules, applyRules, readStyle, applyStyleBlock, isCompleteCss } from '../src/server/patch.js';
import { findStyleBlock } from '../src/server/locate.js';

const SAMPLE = `<script>
  let count = 0;
</script>

<button class="btn" on:click={() => count++}>{count}</button>

<style>
  .btn {
    color: #333;
    padding: 8px 14px;
    border-radius: 4px;
  }
  .btn:hover {
    color: #000;
  }
</style>
`;

describe('findStyleBlock', () => {
	it('locates the inner CSS by exact offset', () => {
		const block = findStyleBlock(SAMPLE);
		expect(block).not.toBeNull();
		expect(SAMPLE.slice(block!.start, block!.end)).toBe(block!.css);
		expect(block!.css).toContain('.btn');
	});

	it('returns null when there is no <style>', () => {
		expect(findStyleBlock('<p>hi</p>')).toBeNull();
	});

	it('survives attributes on the style tag', () => {
		const src = '<style lang="postcss">\n.a { color: red; }\n</style>';
		const block = findStyleBlock(src);
		expect(block!.css.trim()).toBe('.a { color: red; }');
	});
});

describe('readRules', () => {
	it('lists source selectors + declarations', () => {
		const { hasStyle, rules } = readRules(SAMPLE);
		expect(hasStyle).toBe(true);
		const btn = rules.find((r) => r.selector === '.btn');
		expect(btn).toBeDefined();
		expect(btn!.decls).toContainEqual({ prop: 'color', value: '#333' });
		expect(btn!.decls).toContainEqual({ prop: 'padding', value: '8px 14px' });
	});
});

const RICH = `<div class="hero"></div>
<style>
	.hero { color: white; }
	@media (min-width: 768px) {
		.hero { color: navy; }
	}
	@keyframes spin {
		from { transform: rotate(0); }
		to { transform: rotate(360deg); }
	}
</style>
`;

describe('readRules — at-rule context', () => {
	it('tags rules with their enclosing @media (outermost first); top-level rules have none', () => {
		const { rules } = readRules(RICH);
		const top = rules.filter((r) => r.selector === '.hero' && !r.media);
		const media = rules.filter((r) => r.selector === '.hero' && r.media);
		expect(top).toHaveLength(1);
		expect(media).toHaveLength(1);
		expect(media[0].media).toEqual([{ name: 'media', params: '(min-width: 768px)' }]);
	});

	it('gives every surfaced rule a stable, ascending id and skips @keyframes steps', () => {
		const { rules } = readRules(RICH);
		// keyframe steps (from/to) are animation frames, not editable selectors
		expect(rules.some((r) => r.selector === 'from' || r.selector === 'to')).toBe(false);
		const ids = rules.map((r) => r.id as number);
		expect(ids.every((i) => typeof i === 'number')).toBe(true);
		expect(new Set(ids).size).toBe(ids.length); // unique
		expect([...ids]).toEqual([...ids].sort((a, b) => a - b)); // ascending (source order)
		// the @media override's id comes after the base rule's (walk order)
		const base = rules.find((r) => r.selector === '.hero' && !r.media)!;
		const resp = rules.find((r) => r.selector === '.hero' && r.media)!;
		expect((resp.id as number) > (base.id as number)).toBe(true);
	});
});

describe('applyEdit', () => {
	it('updates an existing declaration, touching only the <style>', () => {
		const res = applyEdit(SAMPLE, { file: 'X.svelte', selector: '.btn', prop: 'color', value: '#ff3e00' });
		expect(res.matched).toBe(true);
		expect(res.changed).toBe(true);
		expect(res.code).toContain('color: #ff3e00;');
		// surrounding markup + script left intact
		expect(res.code).toContain('let count = 0;');
		expect(res.code).toContain('<button class="btn"');
		// sibling declarations preserved
		expect(res.code).toContain('padding: 8px 14px;');
		// the :hover rule's color is untouched (first match wins on .btn)
		expect(res.code).toContain('color: #000;');
	});

	it('appends a declaration when the property is absent', () => {
		const res = applyEdit(SAMPLE, { file: 'X.svelte', selector: '.btn', prop: 'background', value: 'gold' });
		expect(res.changed).toBe(true);
		expect(res.code).toContain('background: gold');
	});

	it('reports matched:false for an unknown selector and changes nothing', () => {
		const res = applyEdit(SAMPLE, { file: 'X.svelte', selector: '.nope', prop: 'color', value: 'red' });
		expect(res.matched).toBe(false);
		expect(res.changed).toBe(false);
		expect(res.code).toBe(SAMPLE);
	});

	it('is a no-op when the value is unchanged', () => {
		const res = applyEdit(SAMPLE, { file: 'X.svelte', selector: '.btn', prop: 'color', value: '#333' });
		expect(res.changed).toBe(false);
		expect(res.matched).toBe(true);
	});

	it('handles a component with no <style>', () => {
		const res = applyEdit('<p>hi</p>', { file: 'X.svelte', selector: '.btn', prop: 'color', value: 'red' });
		expect(res.changed).toBe(false);
		expect(res.matched).toBe(false);
	});
});

describe('readStyle', () => {
	it('returns the raw inner CSS of the <style>', () => {
		const { hasStyle, css } = readStyle(SAMPLE);
		expect(hasStyle).toBe(true);
		expect(css).toBe(findStyleBlock(SAMPLE)!.css);
		expect(css).toContain('.btn {');
	});

	it('hasStyle:false when there is no <style>', () => {
		expect(readStyle('<p>x</p>').hasStyle).toBe(false);
	});
});

describe('applyStyleBlock', () => {
	it('replaces the whole <style> body, leaving markup + script intact', () => {
		const res = applyStyleBlock(SAMPLE, '\n  .btn { color: rebeccapurple; }\n');
		expect(res.changed).toBe(true);
		expect(res.code).toContain('color: rebeccapurple;');
		expect(res.code).toContain('let count = 0;');
		expect(res.code).toContain('<button class="btn"');
		// the whole block was replaced, so the old declarations are gone
		expect(res.code).not.toContain('padding: 8px 14px;');
	});

	it('is a no-op when the css is identical', () => {
		const same = findStyleBlock(SAMPLE)!.css;
		expect(applyStyleBlock(SAMPLE, same).changed).toBe(false);
	});

	it('no <style> -> no change', () => {
		expect(applyStyleBlock('<p>x</p>', '.a { color: red; }').changed).toBe(false);
	});

	it('refuses to write incomplete CSS and flags it invalid', () => {
		const res = applyStyleBlock(SAMPLE, '\n  .btn { font }\n');
		expect(res.invalid).toBe(true);
		expect(res.changed).toBe(false);
		expect(res.code).toBe(SAMPLE);
	});

	// SEC-2: this path writes css verbatim, so a literal </style> in a string/comment
	// would close the <style> block early and inject markup that runs in the dev origin.
	it('refuses a </style> breakout payload and never writes it (flags unsafe)', () => {
		for (const payload of [
			'\n  .btn { content: "</style><img src=x onerror=alert(1)>"; }\n',
			'\n  .btn { color: red; } /* </style><script>alert(1)</script> */\n',
			'\n  .btn { background: url("</STYLE>"); }\n'
		]) {
			const res = applyStyleBlock(SAMPLE, payload);
			expect(res.unsafe).toBe(true);
			expect(res.changed).toBe(false);
			expect(res.code).toBe(SAMPLE); // source byte-for-byte unchanged
			expect(res.code).not.toContain('</style><'); // the breakout never reached disk
		}
	});
});

// Regression guard for the real bug: the editor's flat whole-block model can't
// represent @media/@keyframes, so re-serializing a component that has them used
// to FLATTEN the at-rules into top-level rules on save (it ate the homepage's
// responsive overrides). applyStyleBlock must refuse such a write.
const MEDIA_SAMPLE = `<div class="hero"></div>
<style>
	.hero {
		min-height: 40vh;
	}

	@media (min-width: 768px) {
		.hero {
			min-height: 60vh;
		}
	}
</style>
`;

describe('applyStyleBlock — at-rule guard', () => {
	it('REFUSES a write that would drop a source @media (flattening), changes nothing', () => {
		// Exactly what serializeRules() emits: the @media rule promoted to top level.
		const flattened = '\n\t.hero {\n\t\tmin-height: 40vh;\n\t}\n\n\t.hero {\n\t\tmin-height: 60vh;\n\t}\n';
		const res = applyStyleBlock(MEDIA_SAMPLE, flattened);
		expect(res.droppedAtRules).toBe(true);
		expect(res.changed).toBe(false);
		expect(res.code).toBe(MEDIA_SAMPLE); // source untouched — no data loss
	});

	it('ALLOWS a write that keeps the @media wrapper (edit inside it)', () => {
		const kept = '\n\t.hero {\n\t\tmin-height: 40vh;\n\t}\n\n\t@media (min-width: 768px) {\n\t\t.hero {\n\t\t\tmin-height: 70vh;\n\t\t}\n\t}\n';
		const res = applyStyleBlock(MEDIA_SAMPLE, kept);
		expect(res.droppedAtRules).toBeFalsy();
		expect(res.changed).toBe(true);
		expect(res.code).toContain('@media (min-width: 768px)');
		expect(res.code).toContain('min-height: 70vh;');
	});

	it('does not block components that have no at-rules (flat edits still save)', () => {
		const res = applyStyleBlock(SAMPLE, '\n  .btn { color: teal; }\n');
		expect(res.droppedAtRules).toBeFalsy();
		expect(res.changed).toBe(true);
	});
});

const COMMENTED = `<div class="a"></div>
<style>
	/* brand color */
	.a {
		color: red;
		padding: 8px;
	}

	@media (min-width: 600px) {
		/* wide */
		.a { color: blue; }
	}
</style>
`;

describe('applyRules — structure-preserving save (the real fix)', () => {
	it('edits a declaration INSIDE @media without flattening the wrapper or harming keyframes', () => {
		const rules = readRules(RICH).rules;
		const media = rules.find((r) => r.selector === '.hero' && r.media)!;
		media.decls = media.decls.map((d) => (d.prop === 'color' ? { ...d, value: 'red' } : d));
		const res = applyRules(RICH, rules);
		expect(res.changed).toBe(true);
		expect(res.code).toContain('@media (min-width: 768px)'); // wrapper preserved — NOT flattened
		expect(res.code).toContain('color: red'); // the edit landed
		expect(res.code).toContain('@keyframes spin'); // keyframes preserved
		expect(res.code).toContain('rotate(0)'); // from-step intact
		expect(res.code).toContain('rotate(360deg)'); // to-step intact
		expect(res.code).toMatch(/\.hero\s*{\s*color:\s*white/); // top-level rule untouched
	});

	it('edits a top-level rule and leaves the @media override untouched', () => {
		const rules = readRules(RICH).rules;
		const top = rules.find((r) => r.selector === '.hero' && !r.media)!;
		top.decls[0] = { prop: 'color', value: 'black' };
		const res = applyRules(RICH, rules);
		expect(res.changed).toBe(true);
		expect(res.code).toContain('color: black');
		expect(res.code).toContain('@media (min-width: 768px)');
		expect(res.code).toMatch(/@media[^}]*\.hero\s*{\s*color:\s*navy/); // override still navy
	});

	it('fast path: a value-only edit changes ONLY that value, byte-for-byte otherwise', () => {
		const rules = readRules(COMMENTED).rules;
		const a = rules.find((r) => r.selector === '.a' && !r.media)!;
		a.decls = a.decls.map((d) => (d.prop === 'color' ? { ...d, value: 'green' } : d));
		const res = applyRules(COMMENTED, rules);
		expect(res.changed).toBe(true);
		expect(res.code).toBe(COMMENTED.replace('color: red', 'color: green'));
	});

	it('preserves comments and the @media block on save', () => {
		const rules = readRules(COMMENTED).rules;
		const a = rules.find((r) => r.selector === '.a' && !r.media)!;
		a.decls = a.decls.map((d) => (d.prop === 'padding' ? { ...d, value: '12px' } : d));
		const res = applyRules(COMMENTED, rules);
		expect(res.code).toContain('/* brand color */');
		expect(res.code).toContain('/* wide */');
		expect(res.code).toContain('@media (min-width: 600px)');
		expect(res.code).toContain('padding: 12px');
	});

	it('adds a declaration to a rule (slow path) without disturbing structure', () => {
		const rules = readRules(RICH).rules;
		const top = rules.find((r) => r.selector === '.hero' && !r.media)!;
		top.decls.push({ prop: 'padding', value: '8px' });
		const res = applyRules(RICH, rules);
		expect(res.changed).toBe(true);
		expect(res.code).toContain('padding: 8px');
		expect(res.code).toContain('@media (min-width: 768px)');
		expect(res.code).toContain('@keyframes spin');
	});

	it('is a no-op when nothing changed', () => {
		const { rules } = readRules(RICH);
		const res = applyRules(RICH, rules);
		expect(res.changed).toBe(false);
		expect(res.code).toBe(RICH);
	});

	it('ignores a rule whose numeric id is unknown (no patch, no create)', () => {
		const res = applyRules(RICH, [{ id: 999, selector: '.ghost', decls: [{ prop: 'color', value: 'red' }] }]);
		expect(res.changed).toBe(false);
		expect(res.code).toBe(RICH);
	});
});

describe('applyRules — Phase 4 structural ops (create / remove / rename)', () => {
	it('creates a top-level rule from an id-less entry, preserving existing structure', () => {
		const res = applyRules(RICH, [{ selector: '.ghost', decls: [{ prop: 'color', value: 'red' }] }]);
		expect(res.changed).toBe(true);
		expect(res.created).toBe(1);
		expect(res.code).toContain('.ghost');
		expect(res.code).toMatch(/color:\s*red/);
		expect(res.code).toContain('@media (min-width: 768px)'); // untouched
		expect(res.code).toContain('@keyframes spin'); // untouched
	});

	it('creates a responsive override INTO the matching @media block (reused, not duplicated)', () => {
		const { rules } = readRules(RICH);
		const newRule = { selector: '.hero', media: [{ name: 'media', params: '(min-width: 768px)' }], decls: [{ prop: 'padding', value: '20px' }] };
		const res = applyRules(RICH, [...rules, newRule]);
		expect(res.created).toBe(1);
		expect(res.code.match(/@media \(min-width: 768px\)/g)!.length).toBe(1); // still one wrapper
		expect(res.code).toMatch(/padding:\s*20px/);
		const heroResp = readRules(res.code).rules.filter((r) => r.selector === '.hero' && r.media);
		expect(heroResp.length).toBe(2); // two overrides under that breakpoint now
	});

	it('creates a NEW @media block when none matches', () => {
		const newRule = { selector: '.hero', media: [{ name: 'media', params: '(min-width: 1200px)' }], decls: [{ prop: 'color', value: 'gold' }] };
		const res = applyRules(RICH, [newRule]);
		expect(res.created).toBe(1);
		expect(res.code).toContain('(min-width: 1200px)');
		expect(res.code).toMatch(/color:\s*gold/);
	});

	it('removes a rule by id', () => {
		const { rules } = readRules(RICH);
		const top = rules.find((r) => r.selector === '.hero' && !r.media)!;
		const res = applyRules(RICH, rules, { removeIds: [top.id as number] });
		expect(res.removed).toBe(1);
		expect(res.code).not.toMatch(/\.hero\s*{\s*color:\s*white/); // top-level .hero gone
		expect(res.code).toContain('@media (min-width: 768px)'); // the override remains
	});

	it('prunes an emptied @media wrapper when its last rule is removed', () => {
		const { rules } = readRules(RICH);
		const resp = rules.find((r) => r.selector === '.hero' && r.media)!;
		const res = applyRules(RICH, rules, { removeIds: [resp.id as number] });
		expect(res.removed).toBe(1);
		expect(res.code).not.toContain('@media (min-width: 768px)'); // empty wrapper pruned
		expect(res.code).toContain('@keyframes spin'); // unrelated at-rule intact
	});

	it('renames the @media enclosing a rule id (moves the whole breakpoint)', () => {
		const { rules } = readRules(RICH);
		const resp = rules.find((r) => r.selector === '.hero' && r.media)!;
		const res = applyRules(RICH, rules, { mediaRenames: [{ id: resp.id as number, params: '(min-width: 900px)' }] });
		expect(res.renamed).toBe(1);
		expect(res.code).toContain('(min-width: 900px)');
		expect(res.code).not.toContain('(min-width: 768px)');
		expect(res.code).toMatch(/@media[^}]*\.hero\s*{\s*color:\s*navy/); // rule still inside, value unchanged
	});

	it('combines a declaration patch with a create in one call', () => {
		const { rules } = readRules(RICH);
		const top = rules.find((r) => r.selector === '.hero' && !r.media)!;
		top.decls = [{ prop: 'color', value: 'black' }];
		const newRule = { selector: '.hero', media: [{ name: 'media', params: '(min-width: 768px)' }], decls: [{ prop: 'padding', value: '4px' }] };
		const res = applyRules(RICH, [...rules, newRule]);
		expect(res.created).toBe(1);
		expect(res.code).toMatch(/color:\s*black/); // patch landed
		expect(res.code).toMatch(/padding:\s*4px/); // create landed
	});
});

describe('isCompleteCss', () => {
	it('accepts complete declarations', () => {
		expect(isCompleteCss('.a { color: red; padding: 8px 12px; }')).toBe(true);
	});

	it('rejects a bare property (mid-typing "font")', () => {
		expect(isCompleteCss('.a { font }')).toBe(false);
	});

	it('rejects an empty value ("color:")', () => {
		expect(isCompleteCss('.a { color: ; }')).toBe(false);
	});
});
