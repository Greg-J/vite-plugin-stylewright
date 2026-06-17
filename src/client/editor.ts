// Assembles the CodeMirror 6 editor used for a component's <style>. Keeps the
// editor minimal but real: CSS language + highlighting, our inline color swatches
// and wheel-scrub, and a debounced change callback that drives save-to-source.

import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { colorSwatches } from './color.js';
import { installScrub } from './scrub.js';

export interface EditorHandle {
	view: EditorView;
	getValue(): string;
	destroy(): void;
}

const theme = EditorView.theme(
	{
		'&': { fontSize: '12px', backgroundColor: '#fff', color: '#15202b' },
		'.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', padding: '8px 0' },
		'.cm-gutters': { backgroundColor: '#fafafa', color: '#b4bcc0', border: 'none' },
		'.cm-activeLine': { backgroundColor: 'rgba(255,62,0,.05)' },
		'.cm-activeLineGutter': { backgroundColor: 'transparent' },
		'.cm-scroller': { overflow: 'auto', maxHeight: '320px' },
		'&.cm-focused': { outline: 'none' }
	},
	{ dark: false }
);

/**
 * Mount a CodeMirror editor for the given CSS into `parent`. `root` is the shadow
 * root the parent lives in (so CodeMirror injects its styles + tracks selection
 * there). `onChange` fires debounced with the full editor text.
 */
export function createEditor(
	parent: HTMLElement,
	root: ShadowRoot,
	doc: string,
	onChange: (value: string) => void
): EditorHandle {
	let timer: ReturnType<typeof setTimeout> | undefined;

	const view = new EditorView({
		parent,
		root,
		state: EditorState.create({
			doc,
			extensions: [
				lineNumbers(),
				history(),
				keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
				css(),
				syntaxHighlighting(defaultHighlightStyle),
				bracketMatching(),
				colorSwatches,
				theme,
				EditorView.updateListener.of((u) => {
					if (!u.docChanged) return;
					clearTimeout(timer);
					timer = setTimeout(() => onChange(u.state.doc.toString()), 300);
				})
			]
		})
	});

	// Wheel-scrub needs a non-passive listener, so it's attached after construction.
	installScrub(view);

	return {
		view,
		getValue: () => view.state.doc.toString(),
		destroy: () => {
			clearTimeout(timer);
			view.destroy();
		}
	};
}
