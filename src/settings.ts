import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type SwipeTriagePlugin from "./main";
import { AiPromptModal, CreateTriageFolderModal } from "./modals";
import { PRESET_LIST, createDeckFromPreset } from "./presets";
import type {
	DeckConfig,
	DeckMode,
	DirectionActionType,
	DirectionColor,
	PresetId,
	SortMode,
	SwipeDirection,
} from "./types";

const DIRECTION_LABELS: Record<SwipeDirection, string> = {
	right: "Right swipe (→ / D)",
	left: "Left swipe (← / A)",
	up: "Up swipe (↑ / W)",
	down: "Down swipe (↓ / S)",
};

export class SwipeTriageSettingTab extends PluginSettingTab {
	plugin: SwipeTriagePlugin;
	private selectedDeckId: string;

	constructor(app: App, plugin: SwipeTriagePlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.selectedDeckId = plugin.settings.activeDeckId;
	}

	hide(): void {
		// Text fields save per keystroke without touching open decks; catch them up on close
		this.plugin.refreshOpenViews();
		super.hide();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Auto-discover _deck.md folders")
			.setDesc(
				"Automatically include any folder in your vault containing a _deck.md note with swipe-triage: true in its properties."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoDiscoverDeckFiles)
					.onChange(async (value) => {
						this.plugin.settings.autoDiscoverDeckFiles = value;
						await this.plugin.saveSettings();
						this.plugin.refreshOpenViews();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Create plug-and-play triage folder")
			.setDesc(
				"Scaffold a new folder with _deck.md, destination folders or saved note, and starter sample items."
			)
			.addButton((btn) =>
				btn
					.setButtonText("Create folder...")
					.setCta()
					.onClick(() => {
						new CreateTriageFolderModal(
							this.app,
							this.plugin.vaultService,
							(deck) => {
								this.plugin.settings.activeDeckId = deck.id;
								this.selectedDeckId = deck.id;
								void this.plugin.saveSettings().then(() => {
									this.plugin.refreshOpenViews();
									this.display();
								});
							}
						).open();
					})
			);

		const allDecks = this.plugin.vaultService.getAllDecks(this.plugin.settings);
		if (
			allDecks.length > 0 &&
			!allDecks.some((d) => d.id === this.selectedDeckId)
		) {
			this.selectedDeckId = allDecks[0].id;
		}

		new Setting(containerEl).setName("Decks").setHeading();

		const deckSelector = new Setting(containerEl)
			.setName("Deck to configure")
			.setDesc(
				"Choose a settings deck to edit, or pick an auto-discovered _deck.md deck to view its AI prompt and file."
			);

		if (allDecks.length > 0) {
			deckSelector.addDropdown((dd) => {
				for (const d of allDecks) {
					const suffix = d.source === "deck-file" ? " (_deck.md)" : "";
					dd.addOption(d.id, `${d.name} — ${d.folderPath || "/"}${suffix}`);
				}
				dd.setValue(this.selectedDeckId).onChange((value) => {
					this.selectedDeckId = value;
					this.display();
				});
			});
		}

		deckSelector.addButton((btn) =>
			btn.setButtonText("Add deck").onClick(async () => {
				const uniqueId = `deck-${Date.now()}`;
				const newDeck = createDeckFromPreset(
					"inbox",
					"New-Triage",
					"New deck",
					uniqueId
				);
				this.plugin.settings.decks.push(newDeck);
				this.selectedDeckId = newDeck.id;
				await this.plugin.saveSettings();
				this.plugin.refreshOpenViews();
				this.display();
			})
		);

		const selected = allDecks.find((d) => d.id === this.selectedDeckId);
		if (!selected) return;

		// Quick actions for any selected deck (AI prompt + _deck.md export/open)
		const toolsSetting = new Setting(containerEl)
			.setName("AI & folder config")
			.setDesc(
				selected.source === "deck-file"
					? `Configured via ${selected.deckFilePath}. Edit that note directly in Obsidian or with an AI agent.`
					: "Copy a tailored AI producer prompt or export this deck into a folder-level _deck.md note."
			)
			.addButton((btn) =>
				btn.setButtonText("Copy AI prompt").onClick(() => {
					new AiPromptModal(this.app, selected).open();
				})
			);

		if (selected.source === "deck-file" && selected.deckFilePath) {
			const deckFilePath = selected.deckFilePath;
			toolsSetting.addButton((btn) =>
				btn.setButtonText("Open _deck.md").onClick(() => {
					void this.plugin.vaultService
						.openFileByPath(deckFilePath)
						.catch(() => new Notice("Could not open _deck.md."));
				})
			);
			return;
		}

		const settingsDeck = this.plugin.settings.decks.find(
			(d) => d.id === selected.id
		);
		if (!settingsDeck) return;

		toolsSetting.addButton((btn) =>
			btn.setButtonText("Write _deck.md").onClick(async () => {
				try {
					const file = await this.plugin.vaultService.writeDeckFile(
						settingsDeck
					);
					new Notice(`Wrote ${file.path}.`);
					this.plugin.refreshOpenViews();
					this.display();
				} catch (err) {
					console.error("Swipe Triage: failed to write _deck.md", err);
					new Notice("Could not write _deck.md.");
				}
			})
		);

		this.renderSettingsDeckEditor(containerEl, settingsDeck);
	}

	private renderSettingsDeckEditor(
		containerEl: HTMLElement,
		deck: DeckConfig
	): void {
		new Setting(containerEl)
			.setName("Apply starter preset")
			.setDesc(
				"Replace this deck's mode and swipe actions with a built-in template."
			)
			.addDropdown((dd) => {
				dd.addOption("", "Choose a preset...");
				for (const p of PRESET_LIST) {
					dd.addOption(p.id, p.name);
				}
				dd.onChange(async (val) => {
					if (!val) return;
					const templated = createDeckFromPreset(
						val as PresetId,
						deck.folderPath,
						deck.name,
						deck.id
					);
					Object.assign(deck, templated);
					await this.plugin.saveSettings();
					this.plugin.refreshOpenViews();
					this.display();
				});
			});

		new Setting(containerEl)
			.setName("Deck name")
			.addText((text) =>
				text.setValue(deck.name).onChange(async (value) => {
					deck.name = value.trim() || "Untitled deck";
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Folder path")
			.setDesc("Vault folder to scan for pending items.")
			.addText((text) =>
				text
					.setPlaceholder("Triage-Inbox")
					.setValue(deck.folderPath)
					.onChange(async (value) => {
						deck.folderPath = value.trim().replace(/^\/+|\/+$/g, "");
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Deck mode")
			.setDesc(
				"One note per card sorts standalone files; multi-card digest parses heading sections inside batch notes."
			)
			.addDropdown((dd) =>
				dd
					.addOption("notes", "One note per card")
					.addOption("cards", "Multi-card digest")
					.setValue(deck.mode)
					.onChange(async (value) => {
						deck.mode = value as DeckMode;
						if (deck.mode === "cards" && deck.verdictField === "verdict") {
							deck.verdictField = "Verdict";
						} else if (
							deck.mode === "notes" &&
							deck.verdictField === "Verdict"
						) {
							deck.verdictField = "verdict";
						}
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Verdict field")
			.setDesc(
				deck.mode === "cards"
					? "Bold marker line inside each card, e.g. Verdict matches **Verdict:** pending."
					: "Frontmatter property name used to track decisions, e.g. verdict."
			)
			.addText((text) =>
				text.setValue(deck.verdictField).onChange(async (value) => {
					deck.verdictField = value.trim() || "Verdict";
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Pending value")
			.setDesc("Value that marks an item as waiting to be triaged.")
			.addText((text) =>
				text
					.setPlaceholder("pending")
					.setValue(deck.pendingValue)
					.onChange(async (value) => {
						deck.pendingValue = value.trim() || "pending";
						await this.plugin.saveSettings();
					})
			);

		if (deck.mode === "cards") {
			new Setting(containerEl)
				.setName("Card heading level")
				.setDesc("Markdown heading level that starts each card in a digest.")
				.addDropdown((dd) =>
					dd
						.addOption("2", "Heading 2 (##)")
						.addOption("3", "Heading 3 (###)")
						.setValue(String(deck.headingLevel))
						.onChange(async (value) => {
							deck.headingLevel = value === "3" ? 3 : 2;
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName("Completed note status")
				.setDesc(
					"Frontmatter status written when the last pending card in a digest is triaged (leave blank to skip)."
				)
				.addText((text) =>
					text
						.setPlaceholder("reviewed")
						.setValue(deck.reviewedStatus)
						.onChange(async (value) => {
							deck.reviewedStatus = value.trim();
							await this.plugin.saveSettings();
						})
				);
		}

		new Setting(containerEl)
			.setName("Default sort order")
			.addDropdown((dd) =>
				dd
					.addOption("newest", "Newest first")
					.addOption("score", "Highest score first")
					.setValue(deck.defaultSort)
					.onChange(async (value) => {
						deck.defaultSort = value as SortMode;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Filename include pattern")
			.setDesc(
				"Optional regular expression to match filenames (leave blank to include all Markdown files)."
			)
			.addText((text) =>
				text
					.setPlaceholder("Optional regex")
					.setValue(deck.filePattern)
					.onChange(async (value) => {
						deck.filePattern = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Filename exclude pattern")
			.setDesc("Optional regular expression for filenames to skip.")
			.addText((text) =>
				text
					.setPlaceholder("(?:^_index\\.md$|week-)")
					.setValue(deck.excludePattern)
					.onChange(async (value) => {
						deck.excludePattern = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Swipe directions").setHeading();

		const directions: SwipeDirection[] = ["right", "up", "down", "left"];
		for (const dir of directions) {
			const cfg = deck.directions[dir];

			new Setting(containerEl).setName(DIRECTION_LABELS[dir]).setHeading();

			new Setting(containerEl)
				.setName("Label and verdict")
				.setDesc("Stamp text on the card and value written when swiped.")
				.addText((text) =>
					text
						.setPlaceholder("Label")
						.setValue(cfg.label)
						.onChange(async (value) => {
							cfg.label = value.trim() || dir;
							await this.plugin.saveSettings();
						})
				)
				.addText((text) =>
					text
						.setPlaceholder("Verdict value")
						.setValue(cfg.verdict)
						.onChange(async (value) => {
							cfg.verdict = value.trim();
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName("Color and action")
				.addDropdown((dd) =>
					dd
						.addOption("green", "Green")
						.addOption("red", "Red")
						.addOption("orange", "Orange")
						.addOption("blue", "Blue")
						.addOption("purple", "Purple")
						.addOption("muted", "Neutral")
						.setValue(cfg.color)
						.onChange(async (value) => {
							cfg.color = value as DirectionColor;
							await this.plugin.saveSettings();
						})
				)
				.addDropdown((dd) => {
					dd.addOption("verdict", "Update verdict in place");
					dd.addOption("append-note", "Update verdict & append to note");
					if (deck.mode === "notes") {
						dd.addOption("move", "Move note to folder");
						dd.addOption("trash", "Move note to trash");
					}
					dd.setValue(cfg.action).onChange(async (value) => {
						cfg.action = value as DirectionActionType;
						await this.plugin.saveSettings();
						this.display();
					});
				});

			if (cfg.action === "move" && deck.mode === "notes") {
				new Setting(containerEl)
					.setName("Destination folder")
					.addText((text) =>
						text
							.setPlaceholder(`${deck.folderPath || "Triage"}/${cfg.label}`)
							.setValue(cfg.targetFolder ?? "")
							.onChange(async (value) => {
								cfg.targetFolder = value.trim().replace(/^\/+|\/+$/g, "");
								await this.plugin.saveSettings();
							})
					);
			}

			if (cfg.action === "append-note") {
				new Setting(containerEl)
					.setName("Target note and section heading")
					.addText((text) =>
						text
							.setPlaceholder(`${deck.folderPath || "Triage"}/saved.md`)
							.setValue(cfg.targetNote ?? "")
							.onChange(async (value) => {
								cfg.targetNote = value.trim();
								await this.plugin.saveSettings();
							})
					)
					.addText((text) =>
						text
							.setPlaceholder("## Saved items")
							.setValue(cfg.targetHeading ?? "## Saved items")
							.onChange(async (value) => {
								cfg.targetHeading = value.trim() || "## Saved items";
								await this.plugin.saveSettings();
							})
					);
			}
		}

		if (this.plugin.settings.decks.length > 1) {
			new Setting(containerEl)
				.setName("Remove deck")
				.setDesc(
					"Removes this deck from plugin settings without deleting any vault files."
				)
				.addButton((btn) => {
					btn.setButtonText("Remove deck");
					btn.buttonEl.addClass("mod-warning");
					btn.onClick(async () => {
						this.plugin.settings.decks = this.plugin.settings.decks.filter(
							(d) => d.id !== deck.id
						);
						this.selectedDeckId = this.plugin.settings.decks[0]?.id ?? "";
						if (this.plugin.settings.activeDeckId === deck.id) {
							this.plugin.settings.activeDeckId = this.selectedDeckId;
						}
						await this.plugin.saveSettings();
						this.plugin.refreshOpenViews();
						this.display();
					});
				});
		}
	}
}
