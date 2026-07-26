// The AI path's copy deck — every user-visible string in one place so the
// "every shipped string is in the deck" rule is testable rather than aspirational.
//
// House style: curly apostrophes (U+2019). No exclamation marks. No "Oops", no
// "Sorry", no "Error:" prefixes. Setup is not failure, so nothing in the empty
// state is red.

export const AI_COPY = {
	// Short on purpose: these share a 300px header with six other controls.
	tabs: { styles: 'CSS', ai: 'AI' },

	chip: {
		offlineSuffix: ' · offline',
		titleNone: 'No session linked — click to link one',
		/** {name} */
		titleBound: 'Sending to {name} · click to change',
		titleIdle: '{name} is linked but not watching yet — click for details',
		titleOffline: 'Bound session {name} is no longer reachable — click to re-link'
	},

	composer: {
		placeholder: 'Describe the change — e.g. make this a primary button with a loading spinner',
		hint: 'Enter to send · ⇧Enter for a new line',
		to: 'to',
		destNone: 'no session linked',
		reselect: 'Re-select',
		send: 'Send'
	},

	pop: {
		title: 'AGENT SESSIONS',
		link: 'Link',
		linked: 'Linked',
		refresh: 'Refresh list',
		clear: 'Clear binding',
		/** Always present, so the setup instructions never become unreachable. */
		setup: 'Set up an agent',
		/** The dropdown with nothing to list. */
		none: 'No agent sessions yet. Set one up, then Refresh.',
		close: 'Close',
		watching: 'watching',
		notWatching: 'not watching',
		otherProject: 'different project'
	},

	// The one-time setup deck. It lives in Settings now — there is no second
	// floating copy of it to keep in step.
	empty: {
		/** The thing nobody guesses: this is not per-project config. */
		oneEntry: 'One entry covers every project — it finds whichever dev server is running.',
		// Every step is something you can DO. The original step 3 — "Make sure the
		// stylewright MCP server is connected" — described a state to verify with no
		// hint of how, and the command that answers it sat behind a collapsed
		// disclosure. This is the one screen a first-timer cannot get past.
		//
		// Steps 1 and 2 branch by tool. Claude Code registers an MCP
		// server with a CLI command; Cline and OpenCode have no equivalent — they
		// are configured by file. Showing a `claude` command to a Cline user is not
		// a footnote-sized problem, it is the wrong instruction. Which branch, and
		// where the file lives, comes from src/shared/vendors.ts — this deck holds
		// only the wording that is the same for every tool.
		step1: 'Register the MCP server — run this once:',
		/** {tool} — for vendors configured by file rather than a command. */
		step1Json: 'Add the MCP server in {tool}:',
		/** {tool} */
		step2: 'Start {tool} in this project',
		step3: 'Tell it: watch for Stylewright edits',
		step4: 'Come back here and click Refresh',
		/** Shown under step 3 — the reason that step exists at all. */
		step3Why: 'Nothing is pushed to an agent; it has to ask for work. Once per session is enough.',

		blocked: 'Nothing was sent. Your prompt is saved — link a session and press Send again.',
		/** {n} */
		checkedFound: 'Found {n} just now',
		checkedNone: 'Nothing found — checked just now',
		checking: 'Checking…',
		setupLocal: 'Absolute path because this copy isn’t installed from npm — it will be `npx vite-plugin-stylewright mcp` once it is.',
		setupNoBin: 'The MCP server hasn’t been built yet. Run `npm run build` in the plugin, then reopen this.',
		copy: 'Copy to clipboard',
		copied: 'Copied',
		copyFailed: 'Press ⌘C'
	},

	/**
	 * The arming nudge. An MCP server cannot make an idle agent start working, so
	 * a linked-but-not-watching session is a real state the user has to resolve —
	 * and the one thing the original design had no screen for. We say it plainly
	 * at the moment it blocks them rather than letting a request sit in a queue
	 * nobody will ever claim.
	 */
	arm: {
		/** {name} */
		title: '{name} isn’t watching yet',
		/**
		 * NOT "once per session is enough" — that was only ever true of Claude Code,
		 * which backgrounds a long tool call. Cline kills one at its configured
		 * timeout, and every lapse ends the agent's turn and makes you retype this.
		 * So the panel quotes the real figure the session reported. {for} is a
		 * duration like "58 minutes".
		 */
		body: 'Ask that session to watch for edits. One watch lasts {for} here.',
		bodyUnknown: 'Ask that session to watch for edits.',
		say: 'In that session, say:',
		cmd: 'watch for Stylewright edits',
		/** Shown when the window is short enough to be a nuisance. */
		short: 'That is short because Cline caps tool calls at its `timeout` setting — raise it to 3600 and re-add the server to get an hour.',
		dismiss: 'Got it'
	},

	settings: {
		title: 'SETTINGS',
		/** Breadcrumb form — sentence case, because it is a place, not a heading. */
		crumb: 'Settings',
		agents: 'Agents',
		/** Heading over the live sessions inside the Agents section. */
		sessions: 'Connected sessions',
		/** The tools list, under the sessions. */
		installed: 'Tools',
		agentsHint: 'Switch off a tool you do not use to keep its setup out of the way. This does not change what can connect — any MCP client can.',
		setupFor: 'Setup',
		layout: 'Layout',
		layoutHint: 'Where the panel sits. Docked to the bottom, the AI tab goes side by side.',
		dockLeft: 'Left',
		dockBottom: 'Bottom',
		dockRight: 'Right',
		dockFloat: 'Float',
		autoPick: 'Click to select',
		autoPickHint: 'Clicking any element on the page targets it. Off means arming the crosshair for one pick at a time.',
		domTree: 'DOM tree',
		domTreeHint: 'Show the element tree beside the CSS. Off by default because building it is the slow part of a render.',
		focusPick: 'Focus the selection',
		focusPickHint: 'Show only the rules that style what you picked, rather than the whole stylesheet.'
	},

	/** The running task log that replaced the dismissable status screen. */
	log: {
		empty: 'Your requests will appear here. Select an element, describe the change, press Enter.',
		clear: 'Clear history'
	},

	offline: {
		body: 'That session closed. Your prompt is still here — link a session and send again.',
		/** {name} */
		relink: 'Re-link {name}',
		other: 'Choose another'
	},

	status: {
		/** {name} */
		sending: 'Sending to {name}…',
		sendingSub: 'Handing over the element, its source file, and your instruction.',
		sendingNote: 'handoff in progress',

		queued: 'Queued for {name}',
		queuedSub: 'It will start as soon as that session is watching. Nothing is lost if you wait.',
		queuedNote: 'waiting to be claimed',

		working: '{name} is working',
		workingSub: 'Follow the run in that session. This panel updates when it lands.',
		workingNote: 'running in {name}',

		needs: 'Agent is asking a question',
		needsSub: 'Open the {name} session to answer — nothing here is blocked.',
		needsNote: 'waiting on you in {name}',

		done: 'Change applied',
		doneSub: 'Vite HMR repainted the component from source.',
		/** {n} */
		doneNote: '{n} files written · HMR ok',

		error: 'Couldn’t reach {name}',
		errorSub: 'The session stopped responding. Re-link it, then send again.',
		errorNote: 'nothing was written',

		back: 'Back to prompt',
		again: 'Send another',
		retry: 'Try again',
		cancel: 'Cancel',
		/** Leaves the agent's run alone — we cannot recall claimed work, only stop
		 *  showing it. Saying "Cancel" here would be a lie. */
		dismiss: 'Stop showing this'
	},

	/** Refusals the broker can return that the overlay has to explain. */
	reason: {
		queue_full: 'Too many requests waiting. Let the current one finish first.',
		busy: 'That session is already working on a request.',
		bad_file: 'That element’s source file is outside the project.',
		empty_prompt: 'Type an instruction first.'
	}
} as const;

/** `fill('Sending to {name}…', {name:'visual'})` */
export function fill(template: string, vars: Record<string, string | number>): string {
	return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}
