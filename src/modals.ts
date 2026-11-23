import { App, Modal, Notice, Setting, TFile } from "obsidian";
import { generateAiPrompt } from "./deckConfig";
import { PRESET_LIST } from "./presets";
import type { DeckConfig, PresetId } from "./types";
import type { SwipeTriageVaultService } from "./vaultService";

export class CreateTriageFolderModal extends Modal {
	private vaultService: SwipeTriageVaultService;
	private onCreated?: (deck: DeckConfig) => void;
	private preset: PresetId = "inbox";
	private folderPath = PRESET_LIST[0].defaultFolder;
	private deckName = PRESET_LIST[0].name;
	private includeSamples = true;

	constructor(
		app: App,
		vaultService: SwipeTriageVaultService,
		onCreated?: (deck: DeckConfig) => void
	) {
		super(app);
		this.vaultService = vaultService;
		this.onCreated = onCreated;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("st-modal");

		new Setting(contentEl)
			.setName("Create triage folder")
			.setHeading();

		contentEl.createEl("p", {
			cls: "st-modal-desc",
			text: "Creates a plug-and-play folder with a _deck.md config, destination folders or saved note, and starter sample items you can swipe immediately.",
		});

		let folderInputEl: HTMLInputElement | null = null;
		let nameInputEl: HTMLInputElement | null = null;
		let presetDescEl: HTMLElement | null = null;

		const presetSetting = new Setting(contentEl)
			.setName("Starter preset")
			.setDesc(PRESET_LIST[0].description)
			.addDropdown((dd) => {
				for (const item of PRESET_LIST) {
					dd.addOption(item.id, item.name);
				}
				dd.setValue(this.preset).onChange((value) => {
					const nextPreset = value as PresetId;
					const prevMeta = PRESET_LIST.find((p) => p.id === this.preset);
					const nextMeta = PRESET_LIST.find((p) => p.id === nextPreset);
					this.preset = nextPreset;

					if (nextMeta) {
						if (!prevMeta || this.folderPath === prevMeta.defaultFolder) {
							this.folderPath = nextMeta.defaultFolder;
							if (folderInputEl) folderInputEl.value = this.folderPath;
						}
						if (!prevMeta || this.deckName === prevMeta.name) {
							this.deckName = nextMeta.name;
							if (nameInputEl) nameInputEl.value = this.deckName;
						}
						if (presetDescEl) {
							presetDescEl.setText(nextMeta.description);
						}
					}
				});
			});
		presetDescEl = presetSetting.descEl;

		new Setting(contentEl)
			.setName("Folder path")
			.setDesc("Vault path where items and _deck.md will be created.")
			.addText((text) => {
				folderInputEl = text.inputEl;
				text
					.setPlaceholder("Triage-Inbox")
					.setValue(this.folderPath)
					.onChange((value) => {
						this.folderPath = value.trim();
					});
			});

		new Setting(contentEl)
			.setName("Deck name")
			.setDesc("Label shown in the deck switcher.")
			.addText((text) => {
				nameInputEl = text.inputEl;
				text
					.setPlaceholder("Inbox triage")
					.setValue(this.deckName)
					.onChange((value) => {
						this.deckName = value.trim();
					});
			});

		new Setting(contentEl)
			.setName("Include sample cards")
			.setDesc("Add sample items so you can test swiping right away.")
			.addToggle((toggle) => {
				toggle.setValue(this.includeSamples).onChange((value) => {
					this.includeSamples = value;
				});
			});

		const actions = contentEl.createDiv({ cls: "st-modal-actions" });
		const cancelBtn = actions.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		const createBtn = actions.createEl("button", {
			text: "Create folder",
			cls: "mod-cta",
		});
		createBtn.addEventListener("click", () => {
			void this.handleCreate(createBtn);
		});
	}

	private async handleCreate(btn: HTMLButtonElement): Promise<void> {
		if (!this.folderPath.trim()) {
			new Notice("Enter a folder path first.");
			return;
		}
		btn.disabled = true;
		btn.setText("Creating...");
		try {
			const deck = await this.vaultService.scaffoldTriageFolder(
				this.folderPath,
				this.preset,
				this.deckName,
				this.includeSamples
			);
			new Notice(`Created triage folder "${deck.folderPath}".`);
			this.close();
			this.onCreated?.(deck);
		} catch (err) {
			console.error("Swipe Triage: failed to scaffold folder", err);
			new Notice("Could not create triage folder. Check console for details.");
			btn.disabled = false;
			btn.setText("Create folder");
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class AiPromptModal extends Modal {
	private deck: DeckConfig;

	constructor(app: App, deck: DeckConfig) {
		super(app);
		this.deck = deck;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("st-modal");

		new Setting(contentEl)
			.setName(`AI prompt for ${this.deck.name}`)
			.setHeading();

		contentEl.createEl("p", {
			cls: "st-modal-desc",
			text: "Paste this into Claude, ChatGPT, Codex, or your own automation script so it writes cards in this deck's exact schema and learns from past verdicts.",
		});

		const prompt = generateAiPrompt(this.deck);
		const textarea = contentEl.createEl("textarea", {
			cls: "st-prompt-textarea",
		});
		textarea.value = prompt;
		textarea.readOnly = true;

		const actions = contentEl.createDiv({ cls: "st-modal-actions" });
		const closeBtn = actions.createEl("button", { text: "Close" });
		closeBtn.addEventListener("click", () => this.close());

		const copyBtn = actions.createEl("button", {
			text: "Copy prompt",
			cls: "mod-cta",
		});
		copyBtn.addEventListener("click", () => {
			void navigator.clipboard
				.writeText(prompt)
				.then(() => {
					new Notice("Copied AI prompt to clipboard.");
					this.close();
				})
				.catch(() => {
					textarea.select();
					new Notice("Select and copy the prompt text manually.");
				});
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class TrashEmptyFilesModal extends Modal {
	private files: TFile[];
	private vaultService: SwipeTriageVaultService;
	private onComplete?: (trashedCount: number) => void;

	constructor(
		app: App,
		files: TFile[],
		vaultService: SwipeTriageVaultService,
		onComplete?: (trashedCount: number) => void
	) {
		super(app);
		this.files = files;
		this.vaultService = vaultService;
		this.onComplete = onComplete;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("st-modal");

		new Setting(contentEl).setName("Trash empty digest notes").setHeading();

		if (this.files.length === 0) {
			contentEl.createEl("p", {
				text: "No 0-card digest notes were found in this deck.",
			});
			const row = contentEl.createDiv({ cls: "st-modal-actions" });
			const closeBtn = row.createEl("button", { text: "Close" });
			closeBtn.addEventListener("click", () => this.close());
			return;
		}

		contentEl.createEl("p", {
			text: `Move ${this.files.length} digest note${
				this.files.length === 1 ? "" : "s"
			} containing 0 cards to trash? Notes with cards are never touched.`,
		});

		const list = contentEl.createEl("ul", { cls: "st-trash-file-list" });
		for (const file of this.files) {
			list.createEl("li", { text: file.name });
		}

		const row = contentEl.createDiv({ cls: "st-modal-actions" });
		const cancelBtn = row.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		const confirmBtn = row.createEl("button", {
			text: `Trash ${this.files.length} file${
				this.files.length === 1 ? "" : "s"
			}`,
			cls: "mod-warning",
		});

		confirmBtn.addEventListener("click", () => {
			void this.handleTrash(confirmBtn);
		});
	}

	private async handleTrash(btn: HTMLButtonElement): Promise<void> {
		btn.disabled = true;
		btn.setText("Trashing...");
		try {
			const count = await this.vaultService.trashFiles(this.files);
			new Notice(
				`Moved ${count} empty digest note${count === 1 ? "" : "s"} to trash.`
			);
			this.close();
			this.onComplete?.(count);
		} catch (err) {
			console.error("Swipe Triage: failed to trash files", err);
			new Notice("Failed to trash some files. Check console for details.");
			btn.disabled = false;
			btn.setText("Retry");
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
