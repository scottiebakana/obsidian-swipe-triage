import { App, TFile, TFolder, normalizePath } from "obsidian";
import {
	DECK_CONFIG_FILENAME,
	generateDeckFileMarkdown,
	generateSampleFiles,
	parseDeckConfigFromFrontmatter,
} from "./deckConfig";
import {
	appendSinkEntry,
	formatLocalDate,
	formatSinkEntry,
	matchesDeckFileFilters,
	parseDigestFile,
	parseNoteCard,
	removeSinkEntry,
	updateCardVerdictInContent,
	validateDeckPatterns,
} from "./parser";
import { createDeckFromPreset } from "./presets";
import {
	DeckAlreadyExistsError,
	StaleDeckError,
	type DeckConfig,
	type DirectionConfig,
	type PresetId,
	type SwipeDirection,
	type SwipeTriageSettings,
	type SwipeUndoEntry,
	type TriageCard,
} from "./types";

export interface DeckScanResult {
	pendingCards: TriageCard[];
	zeroCardFiles: TFile[];
	totalCardCount: number;
	folderExists: boolean;
	patternErrors: string[];
}

/** Vault path of a sink note, with the `.md` extension Obsidian needs to list the file. */
function sinkNotePath(target: string): string {
	const path = normalizePath(target.trim());
	return /\.md$/i.test(path) ? path : `${path}.md`;
}

/**
 * Verdict written to a note's frontmatter (`notes` mode). Verdict-only actions
 * fall back to the label, because a blank verdict would leave the note pending forever.
 */
function noteVerdictValue(cfg: DirectionConfig): string {
	const verdict = cfg.verdict.trim();
	if (verdict || cfg.action === "move") return verdict;
	return cfg.label.trim().toLowerCase();
}

export class SwipeTriageVaultService {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	/**
	 * Returns all available decks, merging configured decks from settings with
	 * any auto-discovered `_deck.md` files in the vault.
	 * When a folder contains `_deck.md`, that file takes precedence for that folder.
	 */
	getAllDecks(settings: SwipeTriageSettings): DeckConfig[] {
		const discoveredByFolder = new Map<string, DeckConfig>();

		if (settings.autoDiscoverDeckFiles) {
			for (const file of this.app.vault.getMarkdownFiles()) {
				if (file.name !== DECK_CONFIG_FILENAME) continue;
				const cache = this.app.metadataCache.getFileCache(file);
				const folderPath = file.parent?.isRoot() ? "" : file.parent?.path ?? "";
				const parsed = parseDeckConfigFromFrontmatter(
					cache?.frontmatter,
					folderPath,
					file.path
				);
				if (parsed) {
					discoveredByFolder.set(normalizePath(parsed.folderPath), parsed);
				}
			}
		}

		const result: DeckConfig[] = [];
		const seenFolders = new Set<string>();

		for (const deck of settings.decks) {
			const normFolder = normalizePath(deck.folderPath.trim());
			const discovered = discoveredByFolder.get(normFolder);
			if (discovered) {
				result.push({ ...discovered, id: deck.id });
				seenFolders.add(normFolder);
			} else {
				result.push({ ...deck, source: "settings" });
				seenFolders.add(normFolder);
			}
		}

		for (const [normFolder, deck] of discoveredByFolder.entries()) {
			if (!seenFolders.has(normFolder)) {
				result.push(deck);
			}
		}

		return result;
	}

	/**
	 * Returns the existing `_deck.md` TFile for a folder path, or null if none exists.
	 */
	getExistingDeckFile(folderPath: string): TFile | null {
		const cleaned = folderPath.trim().replace(/^\/+|\/+$/g, "");
		const deckPath = cleaned
			? normalizePath(`${cleaned}/${DECK_CONFIG_FILENAME}`)
			: DECK_CONFIG_FILENAME;
		const existing = this.app.vault.getAbstractFileByPath(deckPath);
		return existing instanceof TFile ? existing : null;
	}

	/**
	 * Reads and parses an existing `_deck.md` inside `folderPath` if valid.
	 */
	getExistingDeckConfig(folderPath: string): DeckConfig | null {
		const deckFile = this.getExistingDeckFile(folderPath);
		if (!deckFile) return null;
		const cache = this.app.metadataCache.getFileCache(deckFile);
		const cleaned = folderPath.trim().replace(/^\/+|\/+$/g, "");
		return parseDeckConfigFromFrontmatter(
			cache?.frontmatter,
			cleaned,
			deckFile.path
		);
	}

	private getExcludedSinkPaths(deck: DeckConfig): Set<string> {
		const paths = new Set<string>();
		const dirs: SwipeDirection[] = ["left", "down", "right", "up"];
		for (const d of dirs) {
			const target = deck.directions[d].targetNote?.trim();
			if (target) {
				paths.add(sinkNotePath(target).toLowerCase());
			}
		}
		return paths;
	}

	/**
	 * Scans a deck's folder and returns all pending cards, 0-card digest files,
	 * and any pattern validation errors.
	 */
	async scanDeck(deck: DeckConfig): Promise<DeckScanResult> {
		const patternErrors = validateDeckPatterns(deck);
		const cleanedFolder = deck.folderPath.trim().replace(/^\/+|\/+$/g, "");
		const abstract = cleanedFolder
			? this.app.vault.getAbstractFileByPath(normalizePath(cleanedFolder))
			: this.app.vault.getRoot();

		if (!(abstract instanceof TFolder)) {
			return {
				pendingCards: [],
				zeroCardFiles: [],
				totalCardCount: 0,
				folderExists: false,
				patternErrors,
			};
		}

		const sinkPaths = this.getExcludedSinkPaths(deck);
		const candidateFiles: TFile[] = [];

		for (const child of abstract.children) {
			if (!(child instanceof TFile) || child.extension !== "md") continue;
			if (child.name === DECK_CONFIG_FILENAME) continue;
			if (sinkPaths.has(child.path.toLowerCase())) continue;
			if (!matchesDeckFileFilters(child.name, deck)) continue;
			candidateFiles.push(child);
		}

		candidateFiles.sort((a, b) => b.name.localeCompare(a.name));

		const pendingCards: TriageCard[] = [];
		const zeroCardFiles: TFile[] = [];
		let totalCardCount = 0;

		if (deck.mode === "cards") {
			for (const file of candidateFiles) {
				const content = await this.app.vault.cachedRead(file);
				const fallbackDate = formatLocalDate(file.stat.ctime);
				const parsed = parseDigestFile(
					content,
					file.path,
					file.name,
					deck,
					fallbackDate
				);
				totalCardCount += parsed.totalCount;
				if (parsed.isZeroCard) {
					zeroCardFiles.push(file);
				} else {
					pendingCards.push(...parsed.pendingCards);
				}
			}
		} else {
			for (const file of candidateFiles) {
				totalCardCount++;
				const cache = this.app.metadataCache.getFileCache(file);
				const content = await this.app.vault.cachedRead(file);
				const card = parseNoteCard(
					content,
					cache?.frontmatter,
					file.path,
					file.name,
					file.basename,
					file.stat.ctime,
					deck
				);
				if (card) {
					pendingCards.push(card);
				}
			}
		}

		return {
			pendingCards,
			zeroCardFiles,
			totalCardCount,
			folderExists: true,
			patternErrors,
		};
	}

	/**
	 * Applies a swipe direction's action to the card and returns an UndoEntry.
	 * Rolls back partial writes if a downstream destination step (move or sink append) fails.
	 */
	async applySwipe(
		deck: DeckConfig,
		card: TriageCard,
		direction: SwipeDirection
	): Promise<SwipeUndoEntry> {
		const abstract = this.app.vault.getAbstractFileByPath(card.filePath);
		if (!(abstract instanceof TFile)) {
			throw new StaleDeckError(
				"missing-file",
				`Source note no longer exists at "${card.filePath}".`
			);
		}

		if (deck.mode === "cards") {
			return this.applyDigestCardSwipe(deck, card, abstract, direction);
		}
		return this.applyNoteCardSwipe(deck, card, abstract, direction);
	}

	private async applyDigestCardSwipe(
		deck: DeckConfig,
		card: TriageCard,
		file: TFile,
		direction: SwipeDirection
	): Promise<SwipeUndoEntry> {
		const dirConfig = deck.directions[direction];
		const verdictValue =
			dirConfig.verdict.trim() || dirConfig.label.toLowerCase();

		let previousVerdict = card.verdict;
		let remainingPendingCount = 1;

		await this.app.vault.process(file, (content) => {
			const result = updateCardVerdictInContent(
				content,
				card,
				verdictValue,
				deck
			);
			previousVerdict = result.previousVerdict;
			remainingPendingCount = result.remainingPendingCount;
			return result.updatedContent;
		});

		let changedFileStatus = false;
		let hadPreviousFileStatus = false;
		let previousFileStatus: string | null = null;

		try {
			if (remainingPendingCount === 0 && deck.reviewedStatus.trim()) {
				const nextStatus = deck.reviewedStatus.trim();
				await this.app.fileManager.processFrontMatter(
					file,
					(fm: Record<string, unknown>) => {
						const hasStatus = "status" in fm && fm.status !== undefined;
						const current = fm.status;
						if (!hasStatus || current === "new" || current === "active") {
							changedFileStatus = true;
							hadPreviousFileStatus = hasStatus;
							previousFileStatus =
								typeof current === "string" ? current : null;
							fm.status = nextStatus;
						}
					}
				);
			}

			let appendedSinkNotePath: string | null = null;
			let appendedSinkHeading: string | null = null;
			let appendedSinkLine: string | null = null;
			let createdSinkSection = false;

			if (dirConfig.action === "append-note" && dirConfig.targetNote?.trim()) {
				const sinkPath = sinkNotePath(dirConfig.targetNote);
				const heading = dirConfig.targetHeading?.trim() || "## Saved items";
				const entryLine = formatSinkEntry(card);
				const res = await this.appendToSinkNote(sinkPath, heading, entryLine);
				if (!res.alreadyPresent) {
					appendedSinkNotePath = sinkPath;
					appendedSinkHeading = heading;
					appendedSinkLine = entryLine;
					createdSinkSection = res.createdSection;
				}
			}

			return {
				kind: "swipe",
				deck,
				direction,
				directionConfig: dirConfig,
				card: { ...card, verdict: previousVerdict },
				previousVerdict,
				hadPreviousVerdictProp: true,
				movedToPath: null,
				appendedSinkNotePath,
				appendedSinkHeading,
				appendedSinkLine,
				createdSinkSection,
				changedFileStatus,
				hadPreviousFileStatus,
				previousFileStatus,
				trashed: false,
			};
		} catch (err) {
			// Roll back frontmatter status and card verdict so the card stays cleanly pending
			if (changedFileStatus) {
				try {
					await this.app.fileManager.processFrontMatter(
						file,
						(fm: Record<string, unknown>) => {
							if (hadPreviousFileStatus) {
								fm.status = previousFileStatus;
							} else {
								delete fm.status;
							}
						}
					);
				} catch {
					// Best-effort rollback
				}
			}
			try {
				await this.app.vault.process(file, (content) => {
					const res = updateCardVerdictInContent(
						content,
						card,
						previousVerdict,
						deck
					);
					return res.updatedContent;
				});
			} catch {
				// Best-effort rollback
			}
			throw err;
		}
	}

	private async applyNoteCardSwipe(
		deck: DeckConfig,
		card: TriageCard,
		file: TFile,
		direction: SwipeDirection
	): Promise<SwipeUndoEntry> {
		const dirConfig = deck.directions[direction];
		const verdictField = deck.verdictField.trim() || "verdict";

		if (dirConfig.action === "trash") {
			await this.app.fileManager.trashFile(file);
			return {
				kind: "swipe",
				deck,
				direction,
				directionConfig: dirConfig,
				card,
				previousVerdict: card.verdict,
				hadPreviousVerdictProp: false,
				movedToPath: null,
				appendedSinkNotePath: null,
				appendedSinkHeading: null,
				appendedSinkLine: null,
				createdSinkSection: false,
				changedFileStatus: false,
				hadPreviousFileStatus: false,
				previousFileStatus: null,
				trashed: true,
			};
		}

		const verdictValue = noteVerdictValue(dirConfig);
		let wroteVerdict = false;
		let hadPreviousVerdictProp = false;
		let previousVerdict: string | undefined;

		if (verdictValue) {
			await this.app.fileManager.processFrontMatter(
				file,
				(fm: Record<string, unknown>) => {
					if (verdictField in fm) {
						hadPreviousVerdictProp = true;
						const prev = fm[verdictField];
						previousVerdict =
							typeof prev === "string" || typeof prev === "number"
								? String(prev)
								: undefined;
					}
					fm[verdictField] = verdictValue;
					wroteVerdict = true;
				}
			);
		}

		let appendedSinkNotePath: string | null = null;
		let appendedSinkHeading: string | null = null;
		let appendedSinkLine: string | null = null;
		let createdSinkSection = false;
		let movedToPath: string | null = null;

		try {
			if (dirConfig.action === "append-note" && dirConfig.targetNote?.trim()) {
				const sinkPath = sinkNotePath(dirConfig.targetNote);
				const heading = dirConfig.targetHeading?.trim() || "## Saved items";
				const entryLine = formatSinkEntry(card);
				const res = await this.appendToSinkNote(sinkPath, heading, entryLine);
				if (!res.alreadyPresent) {
					appendedSinkNotePath = sinkPath;
					appendedSinkHeading = heading;
					appendedSinkLine = entryLine;
					createdSinkSection = res.createdSection;
				}
			}

			if (dirConfig.action === "move" && dirConfig.targetFolder?.trim()) {
				const destFolder = normalizePath(dirConfig.targetFolder.trim());
				await this.ensureFolderExists(destFolder);
				const destPath = this.resolveUniqueFilePath(destFolder, file.name);
				if (destPath !== file.path) {
					await this.app.fileManager.renameFile(file, destPath);
					movedToPath = destPath;
				}
			}

			return {
				kind: "swipe",
				deck,
				direction,
				directionConfig: dirConfig,
				card,
				previousVerdict,
				hadPreviousVerdictProp,
				movedToPath,
				appendedSinkNotePath,
				appendedSinkHeading,
				appendedSinkLine,
				createdSinkSection,
				changedFileStatus: false,
				hadPreviousFileStatus: false,
				previousFileStatus: null,
				trashed: false,
			};
		} catch (err) {
			// Roll back sink append and frontmatter verdict so rescanning never loses the card
			if (appendedSinkNotePath && appendedSinkHeading && appendedSinkLine) {
				try {
					const sinkFile =
						this.app.vault.getAbstractFileByPath(appendedSinkNotePath);
					if (sinkFile instanceof TFile) {
						const h = appendedSinkHeading;
						const l = appendedSinkLine;
						const rmEmpty = createdSinkSection;
						await this.app.vault.process(sinkFile, (content) =>
							removeSinkEntry(content, h, l, rmEmpty)
						);
					}
				} catch {
					// Best-effort rollback
				}
			}
			if (wroteVerdict) {
				try {
					await this.app.fileManager.processFrontMatter(
						file,
						(fm: Record<string, unknown>) => {
							if (hadPreviousVerdictProp) {
								fm[verdictField] = previousVerdict ?? "";
							} else {
								delete fm[verdictField];
							}
						}
					);
				} catch {
					// Best-effort rollback
				}
			}
			throw err;
		}
	}

	/**
	 * Reverses a previous swipe (returns false if the file was trashed and cannot
	 * be restored programmatically).
	 */
	async undoSwipe(entry: SwipeUndoEntry): Promise<boolean> {
		if (entry.trashed) {
			return false;
		}

		const currentPath = entry.movedToPath ?? entry.card.filePath;
		const abstract = this.app.vault.getAbstractFileByPath(currentPath);
		if (!(abstract instanceof TFile)) {
			throw new StaleDeckError(
				"missing-file",
				`Note not found for undo at "${currentPath}".`
			);
		}

		if (entry.deck.mode === "cards") {
			const prevVal = entry.previousVerdict ?? entry.deck.pendingValue;
			await this.app.vault.process(abstract, (content) => {
				const res = updateCardVerdictInContent(
					content,
					entry.card,
					prevVal,
					entry.deck
				);
				return res.updatedContent;
			});

			if (entry.changedFileStatus) {
				await this.app.fileManager.processFrontMatter(
					abstract,
					(fm: Record<string, unknown>) => {
						if (entry.hadPreviousFileStatus) {
							fm.status = entry.previousFileStatus;
						} else {
							delete fm.status;
						}
					}
				);
			}
		} else {
			if (entry.movedToPath && entry.movedToPath !== entry.card.filePath) {
				const parentSlash = entry.card.filePath.lastIndexOf("/");
				if (parentSlash > 0) {
					await this.ensureFolderExists(
						entry.card.filePath.slice(0, parentSlash)
					);
				}
				await this.app.fileManager.renameFile(abstract, entry.card.filePath);
			}

			const verdictField = entry.deck.verdictField.trim() || "verdict";
			if (noteVerdictValue(entry.directionConfig)) {
				await this.app.fileManager.processFrontMatter(
					abstract,
					(fm: Record<string, unknown>) => {
						if (entry.hadPreviousVerdictProp) {
							fm[verdictField] = entry.previousVerdict ?? "";
						} else {
							delete fm[verdictField];
						}
					}
				);
			}
		}

		if (
			entry.appendedSinkNotePath &&
			entry.appendedSinkHeading &&
			entry.appendedSinkLine
		) {
			const sinkFile = this.app.vault.getAbstractFileByPath(
				entry.appendedSinkNotePath
			);
			if (sinkFile instanceof TFile) {
				const heading = entry.appendedSinkHeading;
				const line = entry.appendedSinkLine;
				const removeEmpty = entry.createdSinkSection;
				await this.app.vault.process(sinkFile, (content) =>
					removeSinkEntry(content, heading, line, removeEmpty)
				);
			}
		}

		return true;
	}

	async trashFiles(files: TFile[]): Promise<number> {
		let count = 0;
		for (const file of files) {
			await this.app.fileManager.trashFile(file);
			count++;
		}
		return count;
	}

	async writeDeckFile(deck: DeckConfig, overwrite = true): Promise<TFile> {
		const folder = normalizePath(deck.folderPath.trim());
		if (folder) {
			await this.ensureFolderExists(folder);
		}
		const deckPath = folder
			? normalizePath(`${folder}/${DECK_CONFIG_FILENAME}`)
			: DECK_CONFIG_FILENAME;
		const content = generateDeckFileMarkdown(deck);
		const existing = this.app.vault.getAbstractFileByPath(deckPath);
		if (existing instanceof TFile) {
			if (!overwrite) {
				throw new DeckAlreadyExistsError(existing.path);
			}
			await this.app.vault.process(existing, () => content);
			return existing;
		}
		return this.app.vault.create(deckPath, content);
	}

	/**
	 * Scaffolds a ready-to-use triage folder with `_deck.md`, outcome folders or
	 * sink notes, and sample cards. Refuses to overwrite an existing `_deck.md`
	 * unless `overwriteDeckFile` is explicitly true.
	 */
	async scaffoldTriageFolder(
		folderPath: string,
		preset: PresetId,
		customName?: string,
		includeSamples = true,
		overwriteDeckFile = false
	): Promise<DeckConfig> {
		const cleanedFolder = normalizePath(
			folderPath.trim().replace(/^\/+|\/+$/g, "")
		);

		const existingDeck = this.getExistingDeckFile(cleanedFolder);
		if (existingDeck && !overwriteDeckFile) {
			throw new DeckAlreadyExistsError(existingDeck.path);
		}

		const deck = createDeckFromPreset(
			preset,
			cleanedFolder,
			customName,
			`deck-file:${cleanedFolder || "__root__"}`
		);

		if (cleanedFolder) {
			await this.ensureFolderExists(cleanedFolder);
		}

		const dirs: SwipeDirection[] = ["left", "down", "right", "up"];
		for (const d of dirs) {
			const cfg = deck.directions[d];
			if (cfg.action === "move" && cfg.targetFolder) {
				await this.ensureFolderExists(normalizePath(cfg.targetFolder));
			}
			if (cfg.action === "append-note" && cfg.targetNote) {
				const sinkPath = sinkNotePath(cfg.targetNote);
				if (!this.app.vault.getAbstractFileByPath(sinkPath)) {
					await this.createSinkNote(
						sinkPath,
						cfg.targetHeading || "## Saved items"
					);
				}
			}
		}

		const deckFile = await this.writeDeckFile(deck, overwriteDeckFile);

		if (includeSamples) {
			const today = formatLocalDate();
			const samples = generateSampleFiles(deck, today);
			for (const sample of samples) {
				const samplePath = cleanedFolder
					? normalizePath(`${cleanedFolder}/${sample.relativeName}`)
					: sample.relativeName;
				if (!this.app.vault.getAbstractFileByPath(samplePath)) {
					await this.app.vault.create(samplePath, sample.content);
				}
			}
		}

		return {
			...deck,
			source: "deck-file",
			deckFilePath: deckFile.path,
		};
	}

	async openCardSourceNote(card: TriageCard): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(card.filePath);
		if (!(file instanceof TFile)) {
			throw new StaleDeckError(
				"missing-file",
				`Note not found: ${card.filePath}`
			);
		}
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.openFile(file, {
			eState: card.headingSubpath
				? { subpath: `#${card.headingSubpath}` }
				: undefined,
		});
	}

	async openFileByPath(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
		if (!(file instanceof TFile)) {
			throw new Error(`File not found: ${path}`);
		}
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.openFile(file);
	}

	private buildSinkNoteContent(
		sinkPath: string,
		sectionHeading: string,
		initialEntry?: string
	): string {
		const today = formatLocalDate();
		const basename =
			sinkPath.split("/").pop()?.replace(/\.md$/i, "") || "Saved items";
		const lines = [
			"---",
			`title: ${JSON.stringify(basename)}`,
			`created: ${today}`,
			`updated: ${today}`,
			"tags: [swipe-triage]",
			"---",
			"",
			`# ${basename}`,
			"",
		];
		if (!initialEntry) {
			lines.push("Items promoted during Swipe Triage sessions land below.", "");
		}
		lines.push(sectionHeading, "");
		if (initialEntry) {
			lines.push(initialEntry, "");
		}
		return lines.join("\n");
	}

	private async createSinkNote(
		sinkPath: string,
		sectionHeading: string,
		initialEntry?: string
	): Promise<void> {
		const lastSlash = sinkPath.lastIndexOf("/");
		if (lastSlash > 0) {
			await this.ensureFolderExists(sinkPath.slice(0, lastSlash));
		}
		const content = this.buildSinkNoteContent(
			sinkPath,
			sectionHeading,
			initialEntry
		);
		await this.app.vault.create(sinkPath, content);
	}

	private async appendToSinkNote(
		sinkPath: string,
		sectionHeading: string,
		entryLine: string
	): Promise<{ createdSection: boolean; alreadyPresent: boolean }> {
		const existing = this.app.vault.getAbstractFileByPath(sinkPath);

		if (!(existing instanceof TFile)) {
			await this.createSinkNote(sinkPath, sectionHeading, entryLine);
			return { createdSection: true, alreadyPresent: false };
		}

		let createdSection = false;
		let alreadyPresent = false;
		await this.app.vault.process(existing, (content) => {
			const res = appendSinkEntry(content, sectionHeading, entryLine);
			createdSection = res.createdSection;
			alreadyPresent = res.alreadyPresent;
			return res.updatedContent;
		});
		return { createdSection, alreadyPresent };
	}

	private async ensureFolderExists(folderPath: string): Promise<void> {
		const normalized = normalizePath(folderPath);
		if (!normalized || normalized === "/") return;

		const segments = normalized.split("/");
		let current = "";
		for (const seg of segments) {
			current = current ? `${current}/${seg}` : seg;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (!existing) {
				await this.app.vault.createFolder(current);
			}
		}
	}

	private resolveUniqueFilePath(destFolder: string, fileName: string): string {
		const candidate = normalizePath(`${destFolder}/${fileName}`);
		if (!this.app.vault.getAbstractFileByPath(candidate)) {
			return candidate;
		}
		const dotIdx = fileName.lastIndexOf(".");
		const base = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
		const ext = dotIdx > 0 ? fileName.slice(dotIdx) : "";
		let counter = 2;
		while (counter < 1000) {
			const numbered = normalizePath(`${destFolder}/${base}-${counter}${ext}`);
			if (!this.app.vault.getAbstractFileByPath(numbered)) {
				return numbered;
			}
			counter++;
		}
		return normalizePath(`${destFolder}/${base}-${Date.now()}${ext}`);
	}
}
