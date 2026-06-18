import { describe, it, expect } from 'vitest';
import { History, type HistState } from '../src/client/history.js';

/** Build a state: a single rule whose color value is `val`, meta = file. */
function st(file: string, val: string): HistState<string> {
	return { file, meta: file, rules: [{ sel: '.x', decls: [{ p: 'color', v: val }] }] };
}
const val = (s: HistState<string> | null): string | undefined => s?.rules[0].decls[0].v;

describe('History: load baseline + edit', () => {
	it('a load alone is not undoable; the first edit is', () => {
		const h = new History<string>();
		h.record(st('A', 'red'), 0); // load A → staged baseline
		expect(h.canUndo()).toBe(false);
		h.record(st('A', 'blue'), 10); // edit
		expect(h.canUndo()).toBe(true);
		expect(val(h.undo())).toBe('red'); // back to loaded baseline
		expect(h.canUndo()).toBe(false);
		expect(val(h.redo())).toBe('blue');
	});

	it('ignores no-op records (same file + rules)', () => {
		const h = new History<string>();
		h.record(st('A', 'red'), 0);
		h.record(st('A', 'blue'), 10);
		h.record(st('A', 'blue'), 11); // identical → ignored
		expect(val(h.undo())).toBe('red');
		expect(h.undo()).toBe(null);
	});
});

describe('History: navigation does not pollute the stack', () => {
	it('picking other elements without editing adds no steps', () => {
		const h = new History<string>();
		h.record(st('A', 'red'), 0); // load A
		h.record(st('A', 'blue'), 10); // edit A
		h.record(st('B', 'green'), 20); // just looking at B
		h.record(st('C', 'yellow'), 30); // just looking at C
		const u = h.undo(); // undoes the only real edit (A), switching to A
		expect(u?.file).toBe('A');
		expect(val(u)).toBe('red');
		expect(h.canUndo()).toBe(false);
	});
});

describe('History: global timeline across files', () => {
	it('undo walks edits across elements and switches files', () => {
		const h = new History<string>();
		h.record(st('A', 'red'), 0); // load A
		h.record(st('A', 'blue'), 100); // edit A
		h.record(st('B', 'green'), 200); // load B
		h.record(st('B', 'lime'), 300); // edit B
		let u = h.undo(); expect(u?.file).toBe('B'); expect(val(u)).toBe('green'); // revert B edit
		u = h.undo(); expect(u?.file).toBe('A'); expect(val(u)).toBe('blue'); // switch to A (its edited state)
		u = h.undo(); expect(u?.file).toBe('A'); expect(val(u)).toBe('red'); // revert A edit
		expect(h.undo()).toBe(null);
		// redo all the way forward through the shared timeline
		expect(val(h.redo())).toBe('blue'); // A edit
		const r = h.redo(); expect(r?.file).toBe('B'); expect(val(r)).toBe('green'); // hops to B baseline
		expect(val(h.redo())).toBe('lime'); // B edit
	});
});

describe('History: coalescing + branch truncation', () => {
	it('collapses rapid edits, keeps distinct ones', () => {
		const h = new History<string>();
		h.record(st('A', 'red'), 0); // baseline
		h.record(st('A', 'b1'), 10); // edit (new step)
		h.record(st('A', 'b2'), 20); // within 350ms → coalesced into b1's step
		h.record(st('A', 'b3'), 500); // distinct step
		expect(val(h.undo())).toBe('b2'); // b1 was replaced by b2
		expect(val(h.undo())).toBe('red'); // baseline
		expect(h.canUndo()).toBe(false);
	});

	it('a new edit after undo truncates the redo branch', () => {
		const h = new History<string>();
		h.record(st('A', 'red'), 0);
		h.record(st('A', 'blue'), 100);
		h.record(st('A', 'green'), 500);
		expect(val(h.undo())).toBe('blue'); // back one
		h.record(st('A', 'orange'), 1000); // new edit from here
		expect(h.canRedo()).toBe(false); // 'green' branch gone
		expect(val(h.undo())).toBe('blue');
		expect(val(h.undo())).toBe('red');
	});
});
