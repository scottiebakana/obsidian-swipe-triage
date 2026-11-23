import type { DeckConfig, PresetId, SwipeTriageSettings } from "./types";

export interface PresetMetadata {
	id: PresetId;
	name: string;
	description: string;
	defaultFolder: string;
}

export const PRESET_LIST: PresetMetadata[] = [
	{
		id: "inbox",
		name: "Inbox triage",
		description:
			"One note per card. Dump notes into a folder and swipe to keep, archive, defer to someday, or dismiss (all reversible with Undo).",
		defaultFolder: "Triage-Inbox",
	},
	{
		id: "ai-digest",
		name: "AI digest feed",
		description:
			"Multiple cards per note under ## headings. Updates each card's Verdict line in place and saves favorites to a sink note.",
		defaultFolder: "AI-Digest",
	},
	{
		id: "reading-queue",
		name: "Reading queue",
		description:
			"One note per article or bookmark. Swipe to star, mark read, save for later, or move to Dropped.",
		defaultFolder: "Reading-Queue",
	},
];

function joinVaultPath(folder: string, child: string): string {
	const cleaned = folder.replace(/^\/+|\/+$/g, "");
	return cleaned ? `${cleaned}/${child}` : child;
}

export function createDeckFromPreset(
	preset: PresetId,
	folderPath?: string,
	nameOverride?: string,
	idOverride?: string
): DeckConfig {
	const meta = PRESET_LIST.find((p) => p.id === preset) ?? PRESET_LIST[0];
	const folder = (folderPath?.trim() || meta.defaultFolder).replace(
		/^\/+|\/+$/g,
		""
	);
	const id =
		idOverride ??
		`${preset}-${folder.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

	if (preset === "ai-digest") {
		return {
			id,
			name: nameOverride?.trim() || "AI digest feed",
			folderPath: folder,
			mode: "cards",
			filePattern: "",
			excludePattern: "(?:^_index\\.md$|^README\\.md$|week-)",
			headingLevel: 2,
			verdictField: "Verdict",
			pendingValue: "pending",
			reviewedStatus: "reviewed",
			defaultSort: "newest",
			source: "settings",
			directions: {
				left: {
					label: "No",
					verdict: "no",
					color: "red",
					action: "verdict",
				},
				down: {
					label: "Meh",
					verdict: "meh",
					color: "orange",
					action: "verdict",
				},
				up: {
					label: "Tried",
					verdict: "tried",
					color: "blue",
					action: "verdict",
				},
				right: {
					label: "Keep",
					verdict: "more-like-this",
					color: "green",
					action: "append-note",
					targetNote: joinVaultPath(folder, "saved.md"),
					targetHeading: "## Saved items",
				},
			},
		};
	}

	if (preset === "reading-queue") {
		return {
			id,
			name: nameOverride?.trim() || "Reading queue",
			folderPath: folder,
			mode: "notes",
			filePattern: "",
			excludePattern: "(?:^_index\\.md$|^README\\.md$)",
			headingLevel: 2,
			verdictField: "verdict",
			pendingValue: "pending",
			reviewedStatus: "reviewed",
			defaultSort: "newest",
			source: "settings",
			directions: {
				left: {
					label: "Drop",
					verdict: "dropped",
					color: "red",
					action: "move",
					targetFolder: joinVaultPath(folder, "Dropped"),
				},
				down: {
					label: "Later",
					verdict: "later",
					color: "orange",
					action: "verdict",
				},
				up: {
					label: "Read",
					verdict: "read",
					color: "blue",
					action: "move",
					targetFolder: joinVaultPath(folder, "Read"),
				},
				right: {
					label: "Star",
					verdict: "starred",
					color: "green",
					action: "append-note",
					targetNote: joinVaultPath(folder, "favorites.md"),
					targetHeading: "## Starred",
				},
			},
		};
	}

	// Default: inbox (all 4 directions are reversible moves so accidental swipes can always be undone)
	return {
		id,
		name: nameOverride?.trim() || "Inbox triage",
		folderPath: folder,
		mode: "notes",
		filePattern: "",
		excludePattern: "(?:^_index\\.md$|^README\\.md$)",
		headingLevel: 2,
		verdictField: "verdict",
		pendingValue: "pending",
		reviewedStatus: "reviewed",
		defaultSort: "newest",
		source: "settings",
		directions: {
			left: {
				label: "Dismiss",
				verdict: "dismissed",
				color: "red",
				action: "move",
				targetFolder: joinVaultPath(folder, "Dismissed"),
			},
			down: {
				label: "Someday",
				verdict: "someday",
				color: "orange",
				action: "move",
				targetFolder: joinVaultPath(folder, "Someday"),
			},
			up: {
				label: "Archive",
				verdict: "archive",
				color: "blue",
				action: "move",
				targetFolder: joinVaultPath(folder, "Archive"),
			},
			right: {
				label: "Keep",
				verdict: "keep",
				color: "green",
				action: "move",
				targetFolder: joinVaultPath(folder, "Keep"),
			},
		},
	};
}

export function createDefaultSettings(): SwipeTriageSettings {
	const inboxDeck = createDeckFromPreset(
		"inbox",
		"Triage-Inbox",
		"Inbox triage",
		"default-inbox"
	);
	return {
		activeDeckId: inboxDeck.id,
		autoDiscoverDeckFiles: true,
		decks: [inboxDeck],
	};
}
