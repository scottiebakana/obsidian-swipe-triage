export type DeckMode = "notes" | "cards";

export type SwipeDirection = "left" | "down" | "right" | "up";

export type DirectionColor =
	| "red"
	| "orange"
	| "green"
	| "blue"
	| "purple"
	| "muted";

export type DirectionActionType = "verdict" | "move" | "append-note" | "trash";

export type SortMode = "newest" | "score";

export type PresetId = "inbox" | "ai-digest" | "reading-queue";

export interface DirectionConfig {
	label: string;
	verdict: string;
	color: DirectionColor;
	action: DirectionActionType;
	targetFolder?: string;
	targetNote?: string;
	targetHeading?: string;
}

export interface DeckConfig {
	id: string;
	name: string;
	folderPath: string;
	mode: DeckMode;
	filePattern: string;
	excludePattern: string;
	headingLevel: 2 | 3;
	verdictField: string;
	pendingValue: string;
	reviewedStatus: string;
	defaultSort: SortMode;
	directions: Record<SwipeDirection, DirectionConfig>;
	/** Where this deck definition came from (settings vs auto-discovered _deck.md). */
	source?: "settings" | "deck-file";
	deckFilePath?: string;
}

export interface TriageCard {
	id: string;
	mode: DeckMode;
	filePath: string;
	fileName: string;
	fileBasename: string;
	date: string;
	cardIndex: number;
	cardNumber: number | null;
	headingRaw: string;
	headingSubpath: string;
	title: string;
	score: number | null;
	seenInMultipleSources: boolean;
	whatItIs: string;
	whyItMatters: string;
	sourceQuote: string | null;
	unverifiedQuote: boolean;
	warningText: string | null;
	howToTrySteps: string[];
	extraMarkdown: string;
	effort: string;
	verdict: string;
	verdictLineIndex: number;
	sourceLabel: string;
	sourceUrl: string;
	sourceVia: string;
	tags: string[];
}

export interface ParsedDigestFile {
	filePath: string;
	fileName: string;
	date: string;
	cards: TriageCard[];
	pendingCards: TriageCard[];
	totalCount: number;
	pendingCount: number;
	isZeroCard: boolean;
}

export interface SwipeTriageSettings {
	activeDeckId: string;
	autoDiscoverDeckFiles: boolean;
	decks: DeckConfig[];
}

export interface SwipeUndoEntry {
	kind: "swipe";
	deck: DeckConfig;
	direction: SwipeDirection;
	directionConfig: DirectionConfig;
	card: TriageCard;
	previousVerdict: string | undefined;
	hadPreviousVerdictProp: boolean;
	movedToPath: string | null;
	appendedSinkNotePath: string | null;
	appendedSinkHeading: string | null;
	appendedSinkLine: string | null;
	createdSinkSection: boolean;
	previousFileStatus: string | null;
	trashed: boolean;
}

export interface SkipUndoEntry {
	kind: "skip";
	card: TriageCard;
}

export type UndoEntry = SwipeUndoEntry | SkipUndoEntry;

export interface SessionStats {
	left: number;
	down: number;
	right: number;
	up: number;
}
