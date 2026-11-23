import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import {
	AiPromptModal,
	CreateTriageFolderModal,
	TrashEmptyFilesModal,
} from "./modals";
import { createDefaultSettings } from "./presets";
import { SwipeTriageSettingTab } from "./settings";
import type { DeckConfig, SwipeTriageSettings } from "./types";
import { SwipeTriageVaultService } from "./vaultService";
import { SwipeTriageView, VIEW_TYPE_SWIPE_TRIAGE } from "./view";

export default class SwipeTriagePlugin extends Plugin {
	settings: SwipeTriageSettings = createDefaultSettings();
	vaultService!: SwipeTriageVaultService;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.vaultService = new SwipeTriageVaultService(this.app);

		this.registerView(
			VIEW_TYPE_SWIPE_TRIAGE,
			(leaf) => new SwipeTriageView(leaf, this)
		);

		this.addRibbonIcon("layers", "Open Swipe Triage", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-swipe-deck",
			name: "Open swipe deck",
			callback: () => {
				void this.activateView();
			},
		});

		this.addCommand({
			id: "create-triage-folder",
			name: "Create triage folder",
			callback: () => {
				new CreateTriageFolderModal(
					this.app,
					this.vaultService,
					(deck) => {
						this.settings.activeDeckId = deck.id;
						void this.saveSettings().then(async () => {
							await this.activateView();
							this.refreshOpenViews();
						});
					}
				).open();
			},
		});

		this.addCommand({
			id: "copy-ai-prompt",
			name: "Copy AI prompt for active deck",
			callback: () => {
				const deck = this.resolveActiveDeck();
				if (!deck) {
					new Notice("No triage deck found. Create a triage folder first.");
					return;
				}
				new AiPromptModal(this.app, deck).open();
			},
		});

		this.addCommand({
			id: "trash-empty-digest-notes",
			name: "Trash empty digest notes",
			callback: async () => {
				const deck = this.resolveActiveDeck();
				if (!deck || deck.mode !== "cards") {
					new Notice(
						"Active deck is not a multi-card digest deck. Switch to a cards deck first."
					);
					return;
				}
				try {
					const scan = await this.vaultService.scanDeck(deck);
					new TrashEmptyFilesModal(
						this.app,
						scan.zeroCardFiles,
						this.vaultService,
						() => this.refreshOpenViews()
					).open();
				} catch (err) {
					console.error("Swipe Triage: failed scanning empty digests", err);
					new Notice("Could not scan deck folder.");
				}
			},
		});

		this.addSettingTab(new SwipeTriageSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		const defaults = createDefaultSettings();
		const loaded =
			(await this.loadData()) as Partial<SwipeTriageSettings> | null;
		if (!loaded) {
			this.settings = defaults;
			return;
		}
		this.settings = {
			activeDeckId: loaded.activeDeckId ?? defaults.activeDeckId,
			autoDiscoverDeckFiles:
				loaded.autoDiscoverDeckFiles ?? defaults.autoDiscoverDeckFiles,
			decks:
				Array.isArray(loaded.decks) && loaded.decks.length > 0
					? loaded.decks
					: defaults.decks,
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	resolveActiveDeck(): DeckConfig | null {
		const decks = this.vaultService.getAllDecks(this.settings);
		return (
			decks.find((d) => d.id === this.settings.activeDeckId) ?? decks[0] ?? null
		);
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = null;
		const existingLeaves = workspace.getLeavesOfType(VIEW_TYPE_SWIPE_TRIAGE);

		if (existingLeaves.length > 0) {
			leaf = existingLeaves[0];
		} else {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({
				type: VIEW_TYPE_SWIPE_TRIAGE,
				active: true,
			});
		}

		if (leaf) {
			await workspace.revealLeaf(leaf);
		}
	}

	refreshOpenViews(): void {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SWIPE_TRIAGE);
		for (const leaf of leaves) {
			if (leaf.view instanceof SwipeTriageView) {
				void leaf.view.reloadDeck();
			}
		}
	}
}
