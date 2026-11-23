import {
	Component,
	ItemView,
	Keymap,
	MarkdownRenderer,
	Menu,
	Notice,
	Platform,
	Scope,
	TAbstractFile,
	TFile,
	WorkspaceLeaf,
	normalizePath,
	setIcon,
} from "obsidian";
import { DECK_CONFIG_FILENAME } from "./deckConfig";
import type SwipeTriagePlugin from "./main";
import {
	AiPromptModal,
	CreateTriageFolderModal,
	TrashEmptyFilesModal,
} from "./modals";
import { sortCards } from "./parser";
import {
	StaleDeckError,
	type DeckConfig,
	type DirectionColor,
	type SessionStats,
	type SortMode,
	type SwipeDirection,
	type TriageCard,
	type UndoEntry,
} from "./types";

export const VIEW_TYPE_SWIPE_TRIAGE = "swipe-triage-view";

const DIRECTION_ICON: Record<SwipeDirection, string> = {
	left: "x",
	down: "minus",
	up: "check",
	right: "star",
};

const DIRECTION_ARROW: Record<SwipeDirection, string> = {
	left: "←",
	down: "↓",
	up: "↑",
	right: "→",
};

const DIRECTION_KEY: Record<SwipeDirection, string> = {
	left: "A",
	down: "S",
	up: "W",
	right: "D",
};

const SORT_MODES: [SortMode, string][] = [
	["newest", "Newest"],
	["score", "Top score"],
];

function isEditableTarget(target: EventTarget | null): boolean {
	// Duck-typed on purpose: `instanceof HTMLElement` is false for elements in pop-out windows
	const el = target as Partial<HTMLElement> | null;
	const tag = el?.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
		return true;
	}
	return Boolean(el?.isContentEditable);
}

export class SwipeTriageView extends ItemView {
	private plugin: SwipeTriagePlugin;
	private decks: DeckConfig[] = [];
	private activeDeck: DeckConfig | null = null;
	private folderExists = true;
	private queue: TriageCard[] = [];
	private zeroCardFiles: TFile[] = [];
	private sortMode: SortMode = "newest";
	private undoStack: UndoEntry[] = [];
	private sessionStats: SessionStats = { left: 0, down: 0, right: 0, up: 0 };
	private isLoading = false;
	private isAnimating = false;
	private writeQueue: Promise<void> = Promise.resolve();
	private pointerCleanup: (() => void) | null = null;
	private activeCardEl: HTMLElement | null = null;
	private nextCardEl: HTMLElement | null = null;
	private markdownRenderChild: Component | null = null;
	private selfWriteCount = 0;
	private suppressAutoRefreshUntil = 0;
	private autoRefreshTimer: number | null = null;
	private isPointerDragging = false;
	private lastPatternWarningKey = "";

	constructor(leaf: WorkspaceLeaf, plugin: SwipeTriagePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_SWIPE_TRIAGE;
	}

	getDisplayText(): string {
		return "Swipe Triage";
	}

	getIcon(): string {
		return "layers";
	}

	async onOpen(): Promise<void> {
		this.registerKeyboardShortcuts();
		this.registerVaultWatchers();
		await this.reloadDeck();
	}

	async onClose(): Promise<void> {
		if (this.autoRefreshTimer !== null) {
			window.clearTimeout(this.autoRefreshTimer);
			this.autoRefreshTimer = null;
		}
		this.cleanupPointerHandlers();
		this.cleanupMarkdownChild();
		await this.writeQueue;
	}

	private registerVaultWatchers(): void {
		const isRelevantPath = (filePath: string): boolean => {
			if (
				this.plugin.settings.autoDiscoverDeckFiles &&
				(filePath === DECK_CONFIG_FILENAME ||
					filePath.endsWith(`/${DECK_CONFIG_FILENAME}`))
			) {
				return true;
			}
			if (!this.activeDeck) return false;
			const folder = normalizePath(this.activeDeck.folderPath.trim());
			if (!folder || folder === "/") {
				return !filePath.includes("/");
			}
			return filePath.startsWith(`${folder}/`);
		};

		const scheduleRefresh = (file: TAbstractFile, oldPath?: string) => {
			// Ignore the echo of this view's own writes; external changes that land
			// mid-swipe are kept and retried by reloadDeck once the swipe settles.
			if (
				this.selfWriteCount > 0 ||
				Date.now() < this.suppressAutoRefreshUntil
			) {
				return;
			}
			if (!isRelevantPath(file.path) && !(oldPath && isRelevantPath(oldPath))) {
				return;
			}
			this.queueAutoRefresh();
		};

		this.registerEvent(this.app.vault.on("create", (f) => scheduleRefresh(f)));
		this.registerEvent(this.app.vault.on("modify", (f) => scheduleRefresh(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => scheduleRefresh(f)));
		this.registerEvent(
			this.app.vault.on("rename", (f, oldPath) => scheduleRefresh(f, oldPath))
		);
		this.registerEvent(
			this.app.metadataCache.on("changed", (f) => scheduleRefresh(f))
		);
	}

	/** Debounced background rescan; `reloadDeck` re-queues it while a swipe is landing. */
	private queueAutoRefresh(): void {
		if (this.autoRefreshTimer !== null) {
			window.clearTimeout(this.autoRefreshTimer);
		}
		this.autoRefreshTimer = window.setTimeout(() => {
			this.autoRefreshTimer = null;
			void this.reloadDeck(true);
		}, 500);
	}

	private isMidSwipe(): boolean {
		return (
			this.isAnimating || this.isPointerDragging || this.selfWriteCount > 0
		);
	}

	/** Everything `render()` draws from, with the queue in canonical order. */
	private renderSignature(queue: TriageCard[]): string {
		return JSON.stringify([
			this.decks,
			this.activeDeck?.id,
			this.folderExists,
			this.zeroCardFiles.map((f) => f.path),
			sortCards(queue, this.sortMode),
		]);
	}

	getActiveDeck(): DeckConfig | null {
		return this.activeDeck;
	}

	private registerKeyboardShortcuts(): void {
		if (!this.scope) {
			this.scope = new Scope(this.app.scope);
		}

		this.scope.register(["Mod"], "z", (evt) => {
			if (evt.repeat || isEditableTarget(evt.target)) {
				return;
			}
			void this.undoLastAction();
			return false;
		});

		this.scope.register([], null, (evt) => {
			if (
				evt.repeat ||
				evt.ctrlKey ||
				evt.metaKey ||
				evt.altKey ||
				isEditableTarget(evt.target)
			) {
				return;
			}

			const key = evt.key;
			const lower = key.length === 1 ? key.toLowerCase() : key;

			if (key === "ArrowLeft" || lower === "a") {
				void this.triggerSwipe("left");
				return false;
			}
			if (key === "ArrowDown" || lower === "s") {
				void this.triggerSwipe("down");
				return false;
			}
			if (key === "ArrowRight" || lower === "d") {
				void this.triggerSwipe("right");
				return false;
			}
			if (key === "ArrowUp" || lower === "w") {
				void this.triggerSwipe("up");
				return false;
			}
			if (key === " " || evt.code === "Space") {
				this.skipCurrentCard();
				return false;
			}
			if (lower === "o") {
				void this.openCurrentSourceNote();
				return false;
			}
		});
	}

	async selectDeckById(deckId: string): Promise<void> {
		this.plugin.settings.activeDeckId = deckId;
		await this.plugin.saveSettings();
		this.undoStack = [];
		this.sessionStats = { left: 0, down: 0, right: 0, up: 0 };
		await this.reloadDeck();
	}

	async reloadDeck(silent = false): Promise<void> {
		if (!silent) {
			this.isLoading = true;
			this.render();
		}

		let skipRender = false;
		try {
			await this.writeQueue;
			const before = silent ? this.renderSignature(this.queue) : null;
			const decks = this.plugin.vaultService.getAllDecks(this.plugin.settings);
			const targetId = this.plugin.settings.activeDeckId;
			const activeDeck =
				decks.find((d) => d.id === targetId) ?? decks[0] ?? null;
			const scan = activeDeck
				? await this.plugin.vaultService.scanDeck(activeDeck)
				: null;

			if (silent && this.isMidSwipe()) {
				// The scan predates a swipe that is still landing: applying it would
				// resurrect that card or redraw the deck under the user's finger.
				skipRender = true;
				this.queueAutoRefresh();
				return;
			}

			if (activeDeck && activeDeck.id !== this.activeDeck?.id) {
				this.sortMode = activeDeck.defaultSort;
				this.lastPatternWarningKey = "";
			}
			this.decks = decks;
			this.activeDeck = activeDeck;

			if (!activeDeck || !scan) {
				this.queue = [];
				this.zeroCardFiles = [];
				this.folderExists = false;
				return;
			}

			this.folderExists = scan.folderExists;
			this.zeroCardFiles = scan.zeroCardFiles;
			const nextQueue = sortCards(scan.pendingCards, this.sortMode);

			// A background rescan that found nothing new keeps the current queue and
			// DOM, so the reader's scroll position and skip order survive it.
			skipRender =
				before !== null && before === this.renderSignature(nextQueue);
			if (!skipRender) {
				this.queue = nextQueue;
			}

			if (scan.patternErrors.length > 0) {
				const warningKey = `${activeDeck.id}:${scan.patternErrors.join("|")}`;
				if (warningKey !== this.lastPatternWarningKey) {
					this.lastPatternWarningKey = warningKey;
					new Notice(`Swipe Triage: ${scan.patternErrors[0]}`, 6000);
				}
			}
		} catch (err) {
			console.error("Swipe Triage: failed to scan deck", err);
			if (!silent) {
				new Notice("Could not scan deck folder. Check console for details.");
			}
			this.queue = [];
			this.zeroCardFiles = [];
		} finally {
			this.isLoading = false;
			if (!skipRender) {
				this.render();
			}
		}
	}

	private setSortMode(mode: SortMode): void {
		if (this.sortMode === mode) return;
		this.sortMode = mode;
		this.queue = sortCards(this.queue, this.sortMode);
		this.render();
	}

	private getSessionTotalTriaged(): number {
		return (
			this.sessionStats.left +
			this.sessionStats.down +
			this.sessionStats.right +
			this.sessionStats.up
		);
	}

	private async triggerSwipe(direction: SwipeDirection): Promise<void> {
		if (
			this.isLoading ||
			this.isAnimating ||
			!this.activeDeck ||
			this.queue.length === 0
		) {
			return;
		}

		const deck = this.activeDeck;
		const card = this.queue[0];
		const dirConfig = deck.directions[direction];
		this.isAnimating = true;

		if (this.activeCardEl) {
			this.activeCardEl.removeClass("is-dragging");
			this.activeCardEl.addClass("is-exiting");
			this.activeCardEl.addClass(`is-exiting--${direction}`);
			this.activeCardEl.dataset.swipeDir = direction;
			this.activeCardEl.dataset.swipeColor = dirConfig.color;
			this.activeCardEl.setCssProps({
				"--st-swipe-progress": "1",
				transform: "",
			});

			if (this.nextCardEl) {
				this.nextCardEl.setCssProps({ transform: "", opacity: "" });
				this.nextCardEl.addClass("is-promoting");
			}

			await new Promise((resolve) => window.setTimeout(resolve, 210));
		}

		// By identity, not position: a background refresh may have reordered the queue mid-animation
		this.queue = this.queue.filter((c) => c.id !== card.id);
		this.sessionStats[direction]++;

		const pendingUndo: UndoEntry = {
			kind: "swipe",
			deck,
			direction,
			directionConfig: dirConfig,
			card,
			previousVerdict: card.verdict,
			hadPreviousVerdictProp: true,
			movedToPath: null,
			appendedSinkNotePath: null,
			appendedSinkHeading: null,
			appendedSinkLine: null,
			createdSinkSection: false,
			changedFileStatus: false,
			hadPreviousFileStatus: false,
			previousFileStatus: null,
			trashed: dirConfig.action === "trash" && deck.mode === "notes",
		};
		this.undoStack.push(pendingUndo);

		this.isAnimating = false;
		this.render();

		this.selfWriteCount++;
		this.writeQueue = this.writeQueue
			.then(async () => {
				const completedUndo = await this.plugin.vaultService.applySwipe(
					deck,
					card,
					direction
				);
				const idx = this.undoStack.indexOf(pendingUndo);
				if (idx !== -1) {
					this.undoStack[idx] = completedUndo;
				}
			})
			.catch((err) => {
				const idx = this.undoStack.indexOf(pendingUndo);
				if (idx !== -1) {
					this.undoStack.splice(idx, 1);
				}
				this.sessionStats[direction] = Math.max(
					0,
					this.sessionStats[direction] - 1
				);

				if (err instanceof StaleDeckError) {
					new Notice(
						`"${card.title}" changed or was removed externally. Refreshing deck.`
					);
					void this.reloadDeck(true);
					return;
				}

				console.error("Swipe Triage: failed to apply swipe", err);
				new Notice(`Failed to update "${card.title}". Restoring card.`);
				this.queue.unshift(card);
				this.render();
			})
			.finally(() => {
				this.selfWriteCount = Math.max(0, this.selfWriteCount - 1);
				this.suppressAutoRefreshUntil = Date.now() + 700;
			});
	}

	private skipCurrentCard(): void {
		if (this.isLoading || this.isAnimating || this.queue.length === 0) {
			return;
		}
		if (this.queue.length === 1) {
			new Notice("Only one pending item left.");
			return;
		}
		const card = this.queue.shift();
		if (!card) return;
		this.queue.push(card);
		this.undoStack.push({ kind: "skip", card });
		this.render();
	}

	private async undoLastAction(): Promise<void> {
		if (this.isLoading || this.isAnimating || this.undoStack.length === 0) {
			return;
		}
		this.isAnimating = true;

		try {
			await this.writeQueue;
			const entry = this.undoStack.pop();
			if (!entry) return;

			if (entry.kind === "skip") {
				const idx = this.queue.findIndex((c) => c.id === entry.card.id);
				if (idx !== -1) {
					this.queue.splice(idx, 1);
				}
				this.queue.unshift(entry.card);
				new Notice("Restored skipped item.");
				return;
			}

			if (entry.trashed) {
				new Notice(
					`"${entry.card.title}" was moved to trash. Restore it manually from your trash folder.`
				);
				return;
			}

			this.selfWriteCount++;
			try {
				await this.plugin.vaultService.undoSwipe(entry);
			} finally {
				this.selfWriteCount = Math.max(0, this.selfWriteCount - 1);
				this.suppressAutoRefreshUntil = Date.now() + 700;
			}
			this.sessionStats[entry.direction] = Math.max(
				0,
				this.sessionStats[entry.direction] - 1
			);
			this.queue.unshift(entry.card);

			const extras: string[] = [];
			if (entry.movedToPath) extras.push("moved back");
			if (entry.appendedSinkLine) extras.push("removed from saved note");
			const suffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
			new Notice(`Undid "${entry.directionConfig.label}"${suffix}.`);
		} catch (err) {
			if (err instanceof StaleDeckError) {
				new Notice(
					"Could not undo because the source note or card changed externally. Refreshing deck."
				);
				void this.reloadDeck(true);
				return;
			}
			console.error("Swipe Triage: undo failed", err);
			new Notice("Failed to undo last action. Check console for details.");
		} finally {
			this.isAnimating = false;
			this.render();
		}
	}

	private async openCurrentSourceNote(): Promise<void> {
		if (this.queue.length === 0) return;
		try {
			await this.plugin.vaultService.openCardSourceNote(this.queue[0]);
		} catch (err) {
			if (err instanceof StaleDeckError) {
				new Notice("Source note no longer exists. Refreshing deck.");
				void this.reloadDeck(true);
				return;
			}
			console.error("Swipe Triage: could not open note", err);
			new Notice("Could not open source note.");
		}
	}

	private openCreateFolderModal(): void {
		new CreateTriageFolderModal(
			this.app,
			this.plugin.vaultService,
			(deck) => {
				void this.selectDeckById(deck.id);
			}
		).open();
	}

	private openAiPromptModal(): void {
		if (!this.activeDeck) {
			new Notice("Select or create a deck first.");
			return;
		}
		new AiPromptModal(this.app, this.activeDeck).open();
	}

	private openTrashEmptyModal(): void {
		new TrashEmptyFilesModal(
			this.app,
			this.zeroCardFiles,
			this.plugin.vaultService,
			() => {
				void this.reloadDeck();
			}
		).open();
	}

	private cleanupPointerHandlers(): void {
		// The card being dragged is about to be replaced, so its pointerup will never arrive
		this.isPointerDragging = false;
		if (this.pointerCleanup) {
			this.pointerCleanup();
			this.pointerCleanup = null;
		}
	}

	private cleanupMarkdownChild(): void {
		if (this.markdownRenderChild) {
			this.removeChild(this.markdownRenderChild);
			this.markdownRenderChild = null;
		}
	}

	private render(): void {
		this.cleanupPointerHandlers();
		this.cleanupMarkdownChild();
		this.activeCardEl = null;
		this.nextCardEl = null;

		const container = this.contentEl;
		container.empty();
		container.addClass("st-view-root");

		const shell = container.createDiv({ cls: "st-shell" });
		this.renderToolbar(shell);

		const stage = shell.createDiv({ cls: "st-stage" });

		if (this.isLoading) {
			const loadingEl = stage.createDiv({ cls: "st-empty-state" });
			loadingEl.createDiv({
				cls: "st-empty-title",
				text: "Loading triage deck...",
			});
			return;
		}

		if (!this.activeDeck || !this.folderExists) {
			this.renderSetupEmptyState(stage);
			return;
		}

		if (this.queue.length === 0) {
			this.renderCaughtUpState(stage);
			return;
		}

		this.renderDeck(stage);
		this.renderActionBar(shell, this.activeDeck);
	}

	private renderToolbar(parent: HTMLElement): void {
		const bar = parent.createDiv({ cls: "st-toolbar" });

		// Left: deck selector + progress badge
		const leftGroup = bar.createDiv({ cls: "st-toolbar-left" });

		if (this.decks.length > 0) {
			const select = leftGroup.createEl("select", {
				cls: "st-deck-select dropdown",
				attr: { "aria-label": "Active triage deck" },
			});
			for (const deck of this.decks) {
				const opt = select.createEl("option", {
					value: deck.id,
					text: deck.name,
				});
				if (this.activeDeck && deck.id === this.activeDeck.id) {
					opt.selected = true;
				}
			}
			select.addEventListener("change", () => {
				void this.selectDeckById(select.value);
			});
		}

		const pendingCount = this.queue.length;
		const triaged = this.getSessionTotalTriaged();
		if (this.activeDeck) {
			leftGroup.createSpan({
				cls: "st-progress-pill",
				text: `${pendingCount} left`,
			});
		}
		if (triaged > 0) {
			leftGroup.createSpan({
				cls: "st-session-pill",
				text: `${triaged} done`,
			});
		}

		const rightGroup = bar.createDiv({ cls: "st-toolbar-right" });

		if (this.hasScoredCards()) {
			// Hidden in the compact layout, where the More menu carries the same choice
			const sortGroup = rightGroup.createDiv({
				cls: "st-sort-toggle",
				attr: { role: "group", "aria-label": "Sort items" },
			});
			for (const [mode, text] of SORT_MODES) {
				const active = this.sortMode === mode;
				const btn = sortGroup.createEl("button", {
					cls: `st-sort-btn${active ? " is-active" : ""}`,
					text,
					attr: { "aria-pressed": String(active) },
				});
				btn.addEventListener("click", () => this.setSortMode(mode));
			}
		}

		const openNoteBtn = rightGroup.createEl("button", {
			cls: "st-icon-btn",
			attr: { "aria-label": "Open source note (O)" },
		});
		setIcon(openNoteBtn, "file-text");
		openNoteBtn.disabled = this.queue.length === 0;
		openNoteBtn.addEventListener("click", () => void this.openCurrentSourceNote());

		const moreBtn = rightGroup.createEl("button", {
			cls: "st-icon-btn",
			attr: { "aria-label": "More actions", "aria-haspopup": "menu" },
		});
		setIcon(moreBtn, "more-horizontal");
		moreBtn.addEventListener("click", () => this.openMoreMenu(moreBtn));

		const total = triaged + pendingCount;
		if (this.activeDeck && total > 0) {
			const track = bar.createDiv({
				cls: "st-progress",
				attr: {
					role: "progressbar",
					"aria-label": "Session progress",
					"aria-valuemin": "0",
					"aria-valuemax": String(total),
					"aria-valuenow": String(triaged),
				},
			});
			track.createDiv({ cls: "st-progress-fill" }).setCssProps({
				"--st-progress": `${((triaged / total) * 100).toFixed(1)}%`,
			});
		}
	}

	/** Sorting by score only means something when a card carries one. */
	private hasScoredCards(): boolean {
		return this.queue.some((c) => c.score !== null);
	}

	private openMoreMenu(anchor: HTMLElement): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Copy AI prompt")
				.setIcon("bot")
				.setDisabled(!this.activeDeck)
				.onClick(() => this.openAiPromptModal())
		);
		menu.addItem((item) =>
			item
				.setTitle("New triage folder")
				.setIcon("folder-plus")
				.onClick(() => this.openCreateFolderModal())
		);
		menu.addItem((item) =>
			item
				.setTitle("Refresh deck")
				.setIcon("refresh-cw")
				.onClick(() => void this.reloadDeck())
		);
		if (this.hasScoredCards()) {
			menu.addSeparator();
			for (const [mode, text] of SORT_MODES) {
				menu.addItem((item) =>
					item
						.setTitle(`Sort by ${text.toLowerCase()}`)
						.setChecked(this.sortMode === mode)
						.onClick(() => this.setSortMode(mode))
				);
			}
		}
		const emptyCount = this.zeroCardFiles.length;
		if (this.activeDeck?.mode === "cards" && emptyCount > 0) {
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle(`Trash ${emptyCount} empty digest notes`)
					.setIcon("trash-2")
					.setWarning(true)
					.onClick(() => this.openTrashEmptyModal())
			);
		}
		const rect = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
	}

	private renderDeck(stage: HTMLElement): void {
		if (!this.activeDeck) return;
		const stack = stage.createDiv({ cls: "st-card-stack" });

		this.markdownRenderChild = new Component();
		this.addChild(this.markdownRenderChild);

		if (this.queue.length > 1) {
			this.nextCardEl = this.createCardElement(
				this.queue[1],
				this.activeDeck,
				false
			);
			stack.appendChild(this.nextCardEl);
		}

		this.activeCardEl = this.createCardElement(
			this.queue[0],
			this.activeDeck,
			true
		);
		stack.appendChild(this.activeCardEl);

		this.attachPointerHandlers(this.activeCardEl, this.activeDeck);
	}

	private createCardElement(
		card: TriageCard,
		deck: DeckConfig,
		isActive: boolean
	): HTMLElement {
		const cardEl = createDiv({
			cls: `st-card ${isActive ? "st-card--active" : "st-card--next"}`,
		});

		if (isActive) {
			const dirs: SwipeDirection[] = ["right", "left", "down", "up"];
			for (const dir of dirs) {
				const cfg = deck.directions[dir];
				cardEl.createDiv({
					cls: `st-stamp st-stamp--${dir} st-color--${cfg.color}`,
					text: cfg.label.toUpperCase(),
				});
			}
		}

		// Top metadata bar
		const metaRow = cardEl.createDiv({ cls: "st-card-meta" });

		if (card.date) {
			const dateBadge = metaRow.createSpan({ cls: "st-badge st-badge--date" });
			const iconEl = dateBadge.createSpan({ cls: "st-badge-icon" });
			setIcon(iconEl, "calendar");
			dateBadge.createSpan({ text: card.date });
		}

		if (card.score !== null) {
			const highClass = card.score >= 9 ? " st-badge--score-high" : "";
			const scoreBadge = metaRow.createSpan({
				cls: `st-badge st-badge--score${highClass}`,
			});
			const iconEl = scoreBadge.createSpan({ cls: "st-badge-icon" });
			setIcon(iconEl, "sparkles");
			scoreBadge.createSpan({ text: card.score.toFixed(1) });
		}

		if (card.seenInMultipleSources) {
			metaRow.createSpan({
				cls: "st-badge st-badge--multi",
				text: "Multi-source",
			});
		}

		if (card.effort) {
			const effortBadge = metaRow.createSpan({
				cls: "st-badge st-badge--effort",
			});
			const iconEl = effortBadge.createSpan({ cls: "st-badge-icon" });
			setIcon(iconEl, "clock");
			effortBadge.createSpan({ text: card.effort });
		}

		if (card.unverifiedQuote || card.warningText) {
			const warnBadge = metaRow.createSpan({
				cls: "st-badge st-badge--warning",
				attr: {
					"aria-label":
						card.warningText ||
						"Source quote could not be verified — treat details with extra caution",
				},
			});
			const iconEl = warnBadge.createSpan({ cls: "st-badge-icon" });
			setIcon(iconEl, "alert-triangle");
			warnBadge.createSpan({ text: card.warningText || "Unverified quote" });
		}

		for (const tag of card.tags.slice(0, 4)) {
			metaRow.createSpan({
				cls: "st-badge st-badge--tag",
				text: `#${tag}`,
			});
		}

		// Card body
		const body = cardEl.createDiv({ cls: "st-card-body" });

		body.createEl("h2", {
			cls: "st-card-title",
			text: card.title,
		});

		if (card.whatItIs) {
			const sec = body.createDiv({ cls: "st-section" });
			sec.createDiv({
				cls: "st-section-label",
				text: card.mode === "notes" ? "Summary" : "What it is",
			});
			sec.createEl("p", { cls: "st-section-text", text: card.whatItIs });
		}

		if (card.whyItMatters) {
			const whySec = body.createDiv({ cls: "st-section st-section--why" });
			whySec.createDiv({
				cls: "st-section-label",
				text: "Why it matters",
			});
			whySec.createEl("p", {
				cls: "st-section-text",
				text: card.whyItMatters,
			});
		}

		if (card.sourceQuote) {
			body.createEl("blockquote", {
				cls: "st-quote",
				text: card.sourceQuote,
			});
		}

		if (card.howToTrySteps.length > 0) {
			const details = body.createEl("details", { cls: "st-how-details" });
			const summary = details.createEl("summary", { cls: "st-how-summary" });
			const chev = summary.createSpan({ cls: "st-how-chevron" });
			setIcon(chev, "chevron-right");
			const stepCount = card.howToTrySteps.length;
			summary.createSpan({
				text:
					stepCount > 1
						? `How to try it (${stepCount} steps)`
						: "How to try it",
			});

			if (stepCount === 1) {
				details.createEl("p", {
					cls: "st-how-single",
					text: card.howToTrySteps[0],
				});
			} else {
				const ol = details.createEl("ol", { cls: "st-how-list" });
				for (const step of card.howToTrySteps) {
					ol.createEl("li", { text: step });
				}
			}
		}

		// Render note body (notes mode) or free-form extra markdown (cards mode)
		if (card.extraMarkdown && isActive && this.markdownRenderChild) {
			const mdEl = body.createDiv({ cls: "st-markdown-body" });
			void MarkdownRenderer.render(
				this.app,
				card.extraMarkdown,
				mdEl,
				card.filePath,
				this.markdownRenderChild
			);
			// Rendered wikilinks are inert outside a Markdown view; open them in a new tab
			mdEl.addEventListener("click", (evt) => {
				const link = (evt.target as HTMLElement).closest("a.internal-link");
				const href =
					link?.getAttribute("data-href") ?? link?.getAttribute("href");
				if (!href) return;
				evt.preventDefault();
				void this.app.workspace.openLinkText(
					href,
					card.filePath,
					Keymap.isModEvent(evt) || "tab"
				);
			});
		} else if (card.extraMarkdown && !isActive) {
			body.createEl("p", {
				cls: "st-section-text st-next-preview",
				text: card.extraMarkdown.slice(0, 180),
			});
		}

		// Card footer
		const footer = cardEl.createDiv({ cls: "st-card-footer" });
		if (card.sourceUrl) {
			const link = footer.createEl("a", {
				cls: "st-source-link",
				href: card.sourceUrl,
				attr: {
					target: "_blank",
					rel: "noopener noreferrer",
					title: card.sourceUrl,
				},
			});
			const linkIcon = link.createSpan({ cls: "st-source-icon" });
			setIcon(linkIcon, "external-link");
			link.createSpan({
				cls: "st-source-label",
				text: card.sourceLabel || card.sourceUrl,
			});
		} else if (card.sourceLabel) {
			footer.createSpan({
				cls: "st-source-fallback",
				text: card.sourceLabel,
			});
		} else {
			footer.createSpan({
				cls: "st-source-fallback",
				text: card.fileName,
			});
		}

		if (card.sourceVia) {
			footer.createSpan({
				cls: "st-source-via",
				text: `via ${card.sourceVia}`,
			});
		}

		return cardEl;
	}

	private renderActionBar(parent: HTMLElement, deck: DeckConfig): void {
		const bar = parent.createDiv({ cls: "st-action-bar" });

		const makeBtn = (opts: {
			cls: string;
			color?: DirectionColor;
			icon: string;
			label: string;
			/** Swipe direction glyph; stays visible in the compact layout. */
			arrow?: string;
			hotkey: string;
			disabled?: boolean;
			onClick: () => void;
		}) => {
			const colorClass = opts.color ? ` st-color--${opts.color}` : "";
			const btn = bar.createEl("button", {
				cls: `st-action-btn ${opts.cls}${colorClass}`,
				attr: {
					"aria-label": `${opts.label} (${[opts.arrow, opts.hotkey]
						.filter(Boolean)
						.join(" / ")})`,
				},
			});
			btn.disabled = Boolean(opts.disabled);
			const iconWrap = btn.createSpan({ cls: "st-action-icon" });
			setIcon(iconWrap, opts.icon);
			btn.createSpan({ cls: "st-action-label", text: opts.label });
			const hint = btn.createSpan({ cls: "st-action-hotkey" });
			if (opts.arrow) {
				hint.createSpan({ cls: "st-action-arrow", text: opts.arrow });
			}
			hint.createSpan({
				cls: "st-action-key",
				text: opts.arrow ? ` / ${opts.hotkey}` : opts.hotkey,
			});
			btn.addEventListener("click", opts.onClick);
			return btn;
		};

		makeBtn({
			cls: "st-action-btn--minor",
			icon: "undo-2",
			label: "Undo",
			hotkey: Platform.isMacOS ? "⌘Z" : "Ctrl+Z",
			disabled: this.undoStack.length === 0,
			onClick: () => void this.undoLastAction(),
		});

		const leftCfg = deck.directions.left;
		makeBtn({
			cls: "st-action-btn--dir",
			color: leftCfg.color,
			icon: leftCfg.action === "trash" ? "trash-2" : DIRECTION_ICON.left,
			label: leftCfg.label,
			arrow: DIRECTION_ARROW.left,
			hotkey: DIRECTION_KEY.left,
			onClick: () => void this.triggerSwipe("left"),
		});

		const downCfg = deck.directions.down;
		makeBtn({
			cls: "st-action-btn--dir",
			color: downCfg.color,
			icon: DIRECTION_ICON.down,
			label: downCfg.label,
			arrow: DIRECTION_ARROW.down,
			hotkey: DIRECTION_KEY.down,
			onClick: () => void this.triggerSwipe("down"),
		});

		makeBtn({
			cls: "st-action-btn--minor",
			icon: "skip-forward",
			label: "Skip",
			hotkey: "Space",
			onClick: () => this.skipCurrentCard(),
		});

		const upCfg = deck.directions.up;
		makeBtn({
			cls: "st-action-btn--dir",
			color: upCfg.color,
			icon: DIRECTION_ICON.up,
			label: upCfg.label,
			arrow: DIRECTION_ARROW.up,
			hotkey: DIRECTION_KEY.up,
			onClick: () => void this.triggerSwipe("up"),
		});

		const rightCfg = deck.directions.right;
		makeBtn({
			cls: "st-action-btn--dir",
			color: rightCfg.color,
			icon: DIRECTION_ICON.right,
			label: rightCfg.label,
			arrow: DIRECTION_ARROW.right,
			hotkey: DIRECTION_KEY.right,
			onClick: () => void this.triggerSwipe("right"),
		});
	}

	private renderSetupEmptyState(stage: HTMLElement): void {
		const box = stage.createDiv({ cls: "st-empty-state" });
		const iconEl = box.createDiv({ cls: "st-empty-icon" });
		setIcon(iconEl, "folder-plus");

		box.createEl("h2", {
			cls: "st-empty-title",
			text: this.activeDeck
				? `Folder "${this.activeDeck.folderPath || "/"}" not found`
				: "No triage decks configured",
		});

		box.createEl("p", {
			cls: "st-empty-subtitle",
			text: "Create a plug-and-play triage folder with _deck.md and starter cards, or point a deck to an existing folder in plugin settings.",
		});

		const actions = box.createDiv({ cls: "st-empty-actions" });
		const createBtn = actions.createEl("button", {
			cls: "mod-cta",
			text: "Create triage folder",
		});
		createBtn.addEventListener("click", () => this.openCreateFolderModal());

		const refreshBtn = actions.createEl("button", { text: "Refresh" });
		refreshBtn.addEventListener("click", () => void this.reloadDeck());
	}

	private renderCaughtUpState(stage: HTMLElement): void {
		const deck = this.activeDeck;
		const box = stage.createDiv({ cls: "st-empty-state" });

		const iconEl = box.createDiv({ cls: "st-empty-icon" });
		setIcon(iconEl, "sparkles");

		box.createEl("h2", {
			cls: "st-empty-title",
			text: "All caught up",
		});

		const triaged = this.getSessionTotalTriaged();
		box.createEl("p", {
			cls: "st-empty-subtitle",
			text:
				triaged > 0
					? `No pending items left in "${deck?.folderPath || "/"}". You triaged ${triaged} item${
							triaged === 1 ? "" : "s"
					  } this session.`
					: `No pending items found in "${deck?.folderPath || "/"}". Drop notes here or feed cards from an AI agent.`,
		});

		if (triaged > 0 && deck) {
			const statsRow = box.createDiv({ cls: "st-empty-stats" });
			const dirs: SwipeDirection[] = ["right", "up", "down", "left"];
			for (const d of dirs) {
				const cfg = deck.directions[d];
				statsRow.createSpan({
					cls: `st-stat-chip st-color--${cfg.color}`,
					text: `${cfg.label}: ${this.sessionStats[d]}`,
				});
			}
		}

		const actions = box.createDiv({ cls: "st-empty-actions" });

		if (this.undoStack.length > 0) {
			const undoBtn = actions.createEl("button", { text: "Undo last swipe" });
			undoBtn.addEventListener("click", () => void this.undoLastAction());
		}

		const promptBtn = actions.createEl("button", { text: "Copy AI prompt" });
		promptBtn.addEventListener("click", () => this.openAiPromptModal());

		const refreshBtn = actions.createEl("button", {
			cls: "mod-cta",
			text: "Refresh deck",
		});
		refreshBtn.addEventListener("click", () => void this.reloadDeck());

		if (deck?.mode === "cards" && this.zeroCardFiles.length > 0) {
			const trashBtn = actions.createEl("button", {
				text: `Trash ${this.zeroCardFiles.length} empty digest notes`,
			});
			trashBtn.addEventListener("click", () => this.openTrashEmptyModal());
		}
	}

	private attachPointerHandlers(cardEl: HTMLElement, deck: DeckConfig): void {
		let pointerId: number | null = null;
		let startX = 0;
		let startY = 0;
		let lastY = 0;
		let startTime = 0;
		let dx = 0;
		let dy = 0;
		let mode: "undecided" | "swipe" | "scroll" = "undecided";
		let startedInBody = false;
		let lastDirection: SwipeDirection | null = null;

		const resetVisuals = () => {
			cardEl.removeClass("is-dragging");
			cardEl.setCssProps({
				transform: "",
				opacity: "",
				"--st-swipe-progress": "",
			});
			delete cardEl.dataset.swipeDir;
			delete cardEl.dataset.swipeColor;
			if (this.nextCardEl) {
				this.nextCardEl.setCssProps({
					transform: "",
					opacity: "",
				});
			}
		};

		const onPointerDown = (evt: PointerEvent) => {
			if (this.isAnimating || evt.button !== 0) return;

			const target = evt.target as HTMLElement | null;
			if (target?.closest("a, button, summary, input, textarea, select")) {
				return;
			}

			pointerId = evt.pointerId;
			startX = evt.clientX;
			startY = evt.clientY;
			lastY = evt.clientY;
			startTime = performance.now();
			dx = 0;
			dy = 0;
			mode = "undecided";
			startedInBody = Boolean(target?.closest(".st-card-body"));
			lastDirection = null;
		};

		const onPointerMove = (evt: PointerEvent) => {
			if (pointerId === null || evt.pointerId !== pointerId) return;

			dx = evt.clientX - startX;
			dy = evt.clientY - startY;

			if (mode === "undecided") {
				if (Math.hypot(dx, dy) < 10) return;

				const isVertical = Math.abs(dy) > Math.abs(dx) * 1.15;
				if (isVertical && startedInBody && evt.pointerType === "touch") {
					const body = cardEl.querySelector<HTMLElement>(".st-card-body");
					if (body && body.scrollHeight > body.clientHeight + 2) {
						const atTop = body.scrollTop <= 2;
						const atBottom =
							body.scrollTop + body.clientHeight >= body.scrollHeight - 2;
						if ((dy > 0 && !atTop) || (dy < 0 && !atBottom)) {
							mode = "scroll";
							lastY = evt.clientY;
							try {
								cardEl.setPointerCapture(pointerId);
							} catch {
								// Ignore unsupported pointer capture
							}
							evt.preventDefault();
							return;
						}
					}
				}

				mode = "swipe";
				this.isPointerDragging = true;
				cardEl.addClass("is-dragging");
				try {
					cardEl.setPointerCapture(pointerId);
				} catch {
					// Ignore unsupported pointer capture
				}
			}

			if (mode === "scroll") {
				const body = cardEl.querySelector<HTMLElement>(".st-card-body");
				if (body) {
					body.scrollTop -= evt.clientY - lastY;
				}
				lastY = evt.clientY;
				evt.preventDefault();
				return;
			}

			evt.preventDefault();

			const rect = cardEl.getBoundingClientRect();
			const horizThreshold = Math.min(115, Math.max(72, rect.width * 0.27));
			const vertThreshold = Math.min(95, Math.max(64, rect.height * 0.2));

			const isHorizontal = Math.abs(dx) >= Math.abs(dy) * 0.85;
			let direction: SwipeDirection;
			let progress: number;

			if (isHorizontal) {
				direction = dx >= 0 ? "right" : "left";
				progress = Math.min(1, Math.abs(dx) / horizThreshold);
			} else {
				direction = dy >= 0 ? "down" : "up";
				progress = Math.min(1, Math.abs(dy) / vertThreshold);
			}

			lastDirection = direction;
			const rot = Math.max(-16, Math.min(16, dx * 0.045));
			cardEl.dataset.swipeDir = direction;
			cardEl.dataset.swipeColor = deck.directions[direction].color;
			cardEl.setCssProps({
				transform: `translate3d(${dx}px, ${dy}px, 0) rotate(${rot}deg)`,
				"--st-swipe-progress": progress.toFixed(3),
			});

			if (this.nextCardEl) {
				const scale = 0.95 + 0.045 * progress;
				const offsetY = 10 - 8 * progress;
				const opacity = 0.55 + 0.4 * progress;
				this.nextCardEl.setCssProps({
					transform: `scale(${scale.toFixed(3)}) translateY(${offsetY.toFixed(
						1
					)}px)`,
					opacity: opacity.toFixed(3),
				});
			}
		};

		const finishPointer = (evt: PointerEvent, cancelled: boolean) => {
			if (pointerId === null || evt.pointerId !== pointerId) return;

			const activeId = pointerId;
			const finishedMode = mode;
			pointerId = null;
			mode = "undecided";
			this.isPointerDragging = false;

			try {
				if (cardEl.hasPointerCapture(activeId)) {
					cardEl.releasePointerCapture(activeId);
				}
			} catch {
				// Ignore
			}

			if (finishedMode !== "swipe") return;

			if (cancelled || !lastDirection) {
				resetVisuals();
				return;
			}

			const rect = cardEl.getBoundingClientRect();
			const horizThreshold = Math.min(115, Math.max(72, rect.width * 0.27));
			const vertThreshold = Math.min(95, Math.max(64, rect.height * 0.2));
			const elapsed = Math.max(1, performance.now() - startTime);

			const isHorizontal = lastDirection === "left" || lastDirection === "right";
			const dist = isHorizontal ? Math.abs(dx) : Math.abs(dy);
			const threshold = isHorizontal ? horizThreshold : vertThreshold;
			const velocity = dist / elapsed;

			const committed = dist >= threshold || (dist >= 44 && velocity >= 0.55);

			if (committed) {
				void this.triggerSwipe(lastDirection);
			} else {
				resetVisuals();
			}
		};

		const onPointerUp = (evt: PointerEvent) => finishPointer(evt, false);
		const onPointerCancel = (evt: PointerEvent) => finishPointer(evt, true);

		cardEl.addEventListener("pointerdown", onPointerDown);
		cardEl.addEventListener("pointermove", onPointerMove);
		cardEl.addEventListener("pointerup", onPointerUp);
		cardEl.addEventListener("pointercancel", onPointerCancel);

		this.pointerCleanup = () => {
			cardEl.removeEventListener("pointerdown", onPointerDown);
			cardEl.removeEventListener("pointermove", onPointerMove);
			cardEl.removeEventListener("pointerup", onPointerUp);
			cardEl.removeEventListener("pointercancel", onPointerCancel);
		};
	}
}
