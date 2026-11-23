import { App, TFile, TFolder, normalizePath } from "obsidian";
import {
	DECK_CONFIG_FILENAME,
	generateDeckFileMarkdown,
	generateSampleFiles,
	parseDeckConfigFromFrontmatter,
} from "./deckConfig";
import {
	appendSinkEntry,
	formatSinkEntry,
	matchesDeckFileFilters,
	parseDigestFile,
	parseNoteCard,
	removeSinkEntry,
	updateCardVerdictInContent,
} from "./parser";
import { createDeckFromPreset } from "./presets";
import type {
	DeckConfig,
	PresetId,
	SwipeDirection,
	SwipeTriageSettings,
	SwipeUndoEntry,
	TriageCard,
} from "./types";

export interface DeckScanResult {
	pendingCards: TriageCard[];
	zeroCardFiles: TFile[];
	totalCardCount: number;
	folderExists: boolean;
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

		// Settings decks first (upgraded with _deck.md override if present)
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

		// Any additional auto-discovered _deck.md folders not listed in settings
		for (const [normFolder, deck] of discoveredByFolder.entries()) {
			if (!seenFolders.has(normFolder)) {
				result.push(deck);
			}
		}

		return result;
	}

	/**
	 * Collects all sink note paths configured by a deck so we never show
	 * the deck's own saved/favorites file as a swipeable card.
	 */
	private getExcludedSinkPaths(deck: DeckConfig): Set<string> {
		const paths = new Set<string>();
		const dirs: SwipeDirection[] = ["left", "down", "right", "up"];
		for (const d of dirs) {
			const target = deck.directions[d].targetNote?.trim();
			if (target) {
				paths.add(normalizePath(target).toLowerCase());
			}
		}
		return paths;
	}

	/**
	 * Scans a deck's folder and returns all pending cards and any 0-card digest files.
	 */
	async scanDeck(deck: DeckConfig): Promise<DeckScanResult> {
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
				const fallbackDate = new Date(file.stat.ctime)
					.toISOString()
					.slice(0, 10);
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
		};
	}

	/**
	 * Applies a swipe direction's action to the card and returns an UndoEntry.
	 */
	async applySwipe(
		deck: DeckConfig,
		card: TriageCard,
		direction: SwipeDirection
	): Promise<SwipeUndoEntry> {
		const abstract = this.app.vault.getAbstractFileByPath(card.filePath);
		if (!(abstract instanceof TFile)) {
			throw new Error(`Note not found: ${card.filePath}`);
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
		const verdictValue = dirConfig.verdict.trim() || dirConfig.label.toLowerCase();

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

		let previousFileStatus: string | null = null;
		if (remainingPendingCount === 0 && deck.reviewedStatus.trim()) {
			const nextStatus = deck.reviewedStatus.trim();
			await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				const current = fm.status;
				if (
					current === "new" ||
					current === "active" ||
					current === undefined
				) {
					previousFileStatus = typeof current === "string" ? current : "new";
					fm.status = nextStatus;
				}
			});
		}

		let appendedSinkNotePath: string | null = null;
		let appendedSinkHeading: string | null = null;
		let appendedSinkLine: string | null = null;
		let createdSinkSection = false;

		if (dirConfig.action === "append-note" && dirConfig.targetNote?.trim()) {
			const sinkPath = normalizePath(dirConfig.targetNote.trim());
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
			previousFileStatus,
			trashed: false,
		};
	}

	private async applyNoteCardSwipe(
		deck: DeckConfig,
		card: TriageCard,
		file: TFile,
		direction: SwipeDirection
	): Promise<SwipeUndoEntry> {
		const dirConfig = deck.directions[direction];
		const verdictField = deck.verdictField.trim() || "verdict";

		// Trash action: respect user's Obsidian deleted-files preference
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
				previousFileStatus: null,
				trashed: true,
			};
		}

		// Record verdict in frontmatter if verdict value is configured
		let hadPreviousVerdictProp = false;
		let previousVerdict: string | undefined;
		if (dirConfig.verdict.trim()) {
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
					fm[verdictField] = dirConfig.verdict.trim();
				}
			);
		}

		let appendedSinkNotePath: string | null = null;
		let appendedSinkHeading: string | null = null;
		let appendedSinkLine: string | null = null;
		let createdSinkSection = false;

		if (dirConfig.action === "append-note" && dirConfig.targetNote?.trim()) {
			const sinkPath = normalizePath(dirConfig.targetNote.trim());
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

		let movedToPath: string | null = null;
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
			previousFileStatus: null,
			trashed: false,
		};
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
			throw new Error(`Note not found for undo: ${currentPath}`);
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

			if (entry.previousFileStatus !== null) {
				await this.app.fileManager.processFrontMatter(
					abstract,
					(fm: Record<string, unknown>) => {
						fm.status = entry.previousFileStatus;
					}
				);
			}
		} else {
			// Move note back first if it was relocated
			if (entry.movedToPath && entry.movedToPath !== entry.card.filePath) {
				const parentSlash = entry.card.filePath.lastIndexOf("/");
				if (parentSlash > 0) {
					await this.ensureFolderExists(
						entry.card.filePath.slice(0, parentSlash)
					);
				}
				await this.app.fileManager.renameFile(abstract, entry.card.filePath);
			}

			// Restore or remove frontmatter verdict property
			const verdictField = entry.deck.verdictField.trim() || "verdict";
			if (entry.directionConfig.verdict.trim()) {
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

		// Remove appended checklist line from sink note if applicable
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

	/**
	 * Safely trashes empty digest files using Obsidian's fileManager.trashFile.
	 */
	async trashFiles(files: TFile[]): Promise<number> {
		let count = 0;
		for (const file of files) {
			await this.app.fileManager.trashFile(file);
			count++;
		}
		return count;
	}

	/**
	 * Writes a `_deck.md` file inside the deck's folder so humans and AI agents
	 * can inspect or customize it right alongside the notes.
	 */
	async writeDeckFile(deck: DeckConfig): Promise<TFile> {
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
			await this.app.vault.modify(existing, content);
			return existing;
		}
		return this.app.vault.create(deckPath, content);
	}

	/**
	 * Scaffolds a ready-to-use triage folder with `_deck.md`, outcome folders or
	 * sink notes, and sample cards so users can start swiping immediately.
	 */
	async scaffoldTriageFolder(
		folderPath: string,
		preset: PresetId,
		customName?: string,
		includeSamples = true
	): Promise<DeckConfig> {
		const cleanedFolder = normalizePath(
			folderPath.trim().replace(/^\/+|\/+$/g, "")
		);
		const deck = createDeckFromPreset(
			preset,
			cleanedFolder,
			customName,
			`deck-file:${cleanedFolder || "__root__"}`
		);

		if (cleanedFolder) {
			await this.ensureFolderExists(cleanedFolder);
		}

		// Create destination subfolders for any "move" actions
		const dirs: SwipeDirection[] = ["left", "down", "right", "up"];
		for (const d of dirs) {
			const cfg = deck.directions[d];
			if (cfg.action === "move" && cfg.targetFolder) {
				await this.ensureFolderExists(normalizePath(cfg.targetFolder));
			}
			if (cfg.action === "append-note" && cfg.targetNote) {
				const sinkPath = normalizePath(cfg.targetNote);
				if (!this.app.vault.getAbstractFileByPath(sinkPath)) {
					await this.createEmptySinkNote(
						sinkPath,
						cfg.targetHeading || "## Saved items"
					);
				}
			}
		}

		// Write _deck.md
		const deckFile = await this.writeDeckFile(deck);

		// Create starter sample items if requested and folder has no notes yet
		if (includeSamples) {
			const today = new Date().toISOString().slice(0, 10);
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
			throw new Error(`Note not found: ${card.filePath}`);
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

	private async appendToSinkNote(
		sinkPath: string,
		sectionHeading: string,
		entryLine: string
	): Promise<{ createdSection: boolean; alreadyPresent: boolean }> {
		const existing = this.app.vault.getAbstractFileByPath(sinkPath);

		if (!(existing instanceof TFile)) {
			const lastSlash = sinkPath.lastIndexOf("/");
			if (lastSlash > 0) {
				await this.ensureFolderExists(sinkPath.slice(0, lastSlash));
			}
			const today = new Date().toISOString().slice(0, 10);
			const basename = sinkPath
				.split("/")
				.pop()
				?.replace(/\.md$/i, "") || "Saved items";
			const initialContent = [
				"---",
				`title: ${JSON.stringify(basename)}`,
				`created: ${today}`,
				`updated: ${today}`,
				"tags: [swipe-triage]",
				"---",
				"",
				`# ${basename}`,
				"",
				sectionHeading,
				"",
				entryLine,
				"",
			].join("\n");
			await this.app.vault.create(sinkPath, initialContent);
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

	private async createEmptySinkNote(
		sinkPath: string,
		sectionHeading: string
	): Promise<void> {
		const lastSlash = sinkPath.lastIndexOf("/");
		if (lastSlash > 0) {
			await this.ensureFolderExists(sinkPath.slice(0, lastSlash));
		}
		const today = new Date().toISOString().slice(0, 10);
		const basename =
			sinkPath.split("/").pop()?.replace(/\.md$/i, "") || "Saved items";
		const content = [
			"---",
			`title: ${JSON.stringify(basename)}`,
			`created: ${today}`,
			`updated: ${today}`,
			"tags: [swipe-triage]",
			"---",
			"",
			`# ${basename}`,
			"",
			"Items promoted during Swipe Triage sessions land below.",
			"",
			sectionHeading,
			"",
		].join("\n");
		await this.app.vault.create(sinkPath, content);
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
