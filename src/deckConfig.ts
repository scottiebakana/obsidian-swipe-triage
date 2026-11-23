import { createDeckFromPreset } from "./presets";
import type {
	DeckConfig,
	DeckMode,
	DirectionActionType,
	DirectionColor,
	DirectionConfig,
	PresetId,
	SortMode,
	SwipeDirection,
} from "./types";

export const DECK_CONFIG_FILENAME = "_deck.md";

const VALID_COLORS = new Set<DirectionColor>([
	"red",
	"orange",
	"green",
	"blue",
	"purple",
	"muted",
]);

const VALID_ACTIONS = new Set<DirectionActionType>([
	"verdict",
	"move",
	"append-note",
	"trash",
]);

const VALID_PRESETS = new Set<PresetId>([
	"inbox",
	"ai-digest",
	"reading-queue",
]);

function asString(val: unknown): string | undefined {
	if (typeof val === "string") return val.trim();
	if (typeof val === "number" || typeof val === "boolean") return String(val);
	return undefined;
}

function asRecord(val: unknown): Record<string, unknown> | null {
	if (val && typeof val === "object" && !Array.isArray(val)) {
		return val as Record<string, unknown>;
	}
	return null;
}

function resolveRelativeTarget(
	folderPath: string,
	rawTarget: string | undefined
): string | undefined {
	if (!rawTarget) return undefined;
	const trimmed = rawTarget.trim().replace(/^\/+/, "");
	if (!trimmed) return undefined;
	if (trimmed.startsWith("./")) {
		const sub = trimmed.slice(2);
		return folderPath ? `${folderPath}/${sub}` : sub;
	}
	return trimmed;
}

function mergeDirection(
	base: DirectionConfig,
	overrideObj: unknown,
	folderPath: string
): DirectionConfig {
	const rec = asRecord(overrideObj);
	if (!rec) return { ...base };

	const label = asString(rec.label) ?? base.label;
	const verdict = asString(rec.verdict) ?? base.verdict;
	const rawColor = asString(rec.color) as DirectionColor | undefined;
	const color =
		rawColor && VALID_COLORS.has(rawColor) ? rawColor : base.color;
	const rawAction = asString(rec.action) as DirectionActionType | undefined;
	const action =
		rawAction && VALID_ACTIONS.has(rawAction) ? rawAction : base.action;

	const targetFolder = resolveRelativeTarget(
		folderPath,
		asString(rec.target_folder ?? rec.targetFolder) ?? base.targetFolder
	);
	const targetNote = resolveRelativeTarget(
		folderPath,
		asString(rec.target_note ?? rec.targetNote) ?? base.targetNote
	);
	const targetHeading =
		asString(rec.target_heading ?? rec.targetHeading) ?? base.targetHeading;

	return {
		label,
		verdict,
		color,
		action,
		...(targetFolder ? { targetFolder } : {}),
		...(targetNote ? { targetNote } : {}),
		...(targetHeading ? { targetHeading } : {}),
	};
}

/**
 * Parses a folder's `_deck.md` YAML frontmatter object into a DeckConfig.
 * Returns null if the note does not opt in via `swipe-triage: true` (or `type: swipe-triage-deck`).
 */
export function parseDeckConfigFromFrontmatter(
	fm: Record<string, unknown> | undefined | null,
	folderPath: string,
	deckFilePath: string
): DeckConfig | null {
	if (!fm) return null;

	const optIn =
		fm["swipe-triage"] === true ||
		fm["swipe_triage"] === true ||
		fm.type === "swipe-triage-deck";
	if (!optIn) {
		return null;
	}

	const cleanedFolder = folderPath.replace(/^\/+|\/+$/g, "");
	const rawMode = asString(fm.mode)?.toLowerCase();
	const rawPreset = asString(fm.preset)?.toLowerCase() as PresetId | undefined;

	let preset: PresetId = "inbox";
	if (rawPreset && VALID_PRESETS.has(rawPreset)) {
		preset = rawPreset;
	} else if (rawMode === "cards") {
		preset = "ai-digest";
	}

	const folderLabel =
		cleanedFolder.split("/").pop() || "Vault root";
	const name = asString(fm.name ?? fm.title) || folderLabel;
	const id = `deck-file:${cleanedFolder || "__root__"}`;

	const base = createDeckFromPreset(preset, cleanedFolder, name, id);

	const mode: DeckMode =
		rawMode === "cards" || rawMode === "notes" ? rawMode : base.mode;
	const headingNum = Number(fm.heading_level ?? fm.headingLevel);
	const headingLevel: 2 | 3 = headingNum === 3 ? 3 : headingNum === 2 ? 2 : base.headingLevel;

	const rawSort = asString(fm.default_sort ?? fm.defaultSort)?.toLowerCase();
	const defaultSort: SortMode =
		rawSort === "score" || rawSort === "newest" ? rawSort : base.defaultSort;

	const verdictField =
		asString(fm.verdict_field ?? fm.verdictField) ??
		(mode === "cards" && base.mode !== "cards" ? "Verdict" : base.verdictField);

	const directionsContainer = asRecord(fm.directions);
	const dirs: SwipeDirection[] = ["left", "down", "right", "up"];
	const directions = { ...base.directions };
	for (const d of dirs) {
		const rawDir = directionsContainer?.[d] ?? fm[d];
		directions[d] = mergeDirection(base.directions[d], rawDir, cleanedFolder);
	}

	return {
		...base,
		id,
		name,
		folderPath: cleanedFolder,
		mode,
		filePattern:
			asString(fm.file_pattern ?? fm.filePattern) ?? base.filePattern,
		excludePattern:
			asString(fm.exclude_pattern ?? fm.excludePattern) ?? base.excludePattern,
		headingLevel,
		verdictField,
		pendingValue:
			asString(fm.pending_value ?? fm.pendingValue) ?? base.pendingValue,
		reviewedStatus:
			asString(fm.reviewed_status ?? fm.reviewedStatus) ?? base.reviewedStatus,
		defaultSort,
		directions,
		source: "deck-file",
		deckFilePath,
	};
}

function yamlQuote(value: string): string {
	return JSON.stringify(value);
}

/**
 * Converts a target path inside `folderPath` into a portable `./...` relative path
 * so renaming the deck folder never breaks `_deck.md`.
 */
export function toPortableDeckPath(folderPath: string, targetPath: string): string {
	const cleanTarget = targetPath.trim().replace(/^\/+|\/+$/g, "");
	if (!cleanTarget) return "";
	if (cleanTarget.startsWith("./")) return cleanTarget;

	const cleanFolder = folderPath.trim().replace(/^\/+|\/+$/g, "");
	if (cleanFolder && cleanTarget.startsWith(`${cleanFolder}/`)) {
		return `./${cleanTarget.slice(cleanFolder.length + 1)}`;
	}
	return cleanTarget;
}

function renderDirectionYaml(
	dir: SwipeDirection,
	cfg: DirectionConfig,
	folderPath: string
): string[] {
	const lines = [
		`  ${dir}:`,
		`    label: ${yamlQuote(cfg.label)}`,
		`    verdict: ${yamlQuote(cfg.verdict)}`,
		`    color: ${cfg.color}`,
		`    action: ${cfg.action}`,
	];
	if (cfg.action === "move" && cfg.targetFolder) {
		lines.push(
			`    target_folder: ${yamlQuote(
				toPortableDeckPath(folderPath, cfg.targetFolder)
			)}`
		);
	}
	if (cfg.action === "append-note") {
		if (cfg.targetNote) {
			lines.push(
				`    target_note: ${yamlQuote(
					toPortableDeckPath(folderPath, cfg.targetNote)
				)}`
			);
		}
		if (cfg.targetHeading) {
			lines.push(`    target_heading: ${yamlQuote(cfg.targetHeading)}`);
		}
	}
	return lines;
}

/**
 * Generates a clean, self-documenting `_deck.md` file for a triage folder.
 * Both humans and AI agents can read and edit the YAML frontmatter directly.
 */
export function generateDeckFileMarkdown(deck: DeckConfig): string {
	const frontmatterLines = [
		"---",
		"swipe-triage: true",
		`name: ${yamlQuote(deck.name)}`,
		`mode: ${deck.mode}`,
		`verdict_field: ${yamlQuote(deck.verdictField)}`,
		`pending_value: ${yamlQuote(deck.pendingValue)}`,
		`reviewed_status: ${yamlQuote(deck.reviewedStatus)}`,
		`default_sort: ${deck.defaultSort}`,
	];

	if (deck.mode === "cards") {
		frontmatterLines.push(`heading_level: ${deck.headingLevel}`);
	}
	if (deck.filePattern) {
		frontmatterLines.push(`file_pattern: ${yamlQuote(deck.filePattern)}`);
	}
	if (deck.excludePattern) {
		frontmatterLines.push(`exclude_pattern: ${yamlQuote(deck.excludePattern)}`);
	}

	frontmatterLines.push("directions:");
	frontmatterLines.push(
		...renderDirectionYaml("left", deck.directions.left, deck.folderPath),
		...renderDirectionYaml("down", deck.directions.down, deck.folderPath),
		...renderDirectionYaml("right", deck.directions.right, deck.folderPath),
		...renderDirectionYaml("up", deck.directions.up, deck.folderPath)
	);
	frontmatterLines.push("---", "");

	const bodyLines = [
		`# ${deck.name}`,
		"",
		"This folder is configured as a **Swipe Triage** deck. Edit the YAML properties above to customize swipe actions, labels, or folders — no plugin code required.",
		"",
		"## Swipe actions",
		"",
		`- **Left (← / A) — ${deck.directions.left.label}:** \`${deck.directions.left.verdict}\` (${describeAction(deck.directions.left)})`,
		`- **Down (↓ / S) — ${deck.directions.down.label}:** \`${deck.directions.down.verdict}\` (${describeAction(deck.directions.down)})`,
		`- **Right (→ / D) — ${deck.directions.right.label}:** \`${deck.directions.right.verdict}\` (${describeAction(deck.directions.right)})`,
		`- **Up (↑ / W) — ${deck.directions.up.label}:** \`${deck.directions.up.verdict}\` (${describeAction(deck.directions.up)})`,
		"",
		"## For AI agents & automation scripts",
		"",
		"```markdown",
		generateAiPrompt(deck),
		"```",
		"",
	];

	return [...frontmatterLines, ...bodyLines].join("\n");
}

function describeAction(cfg: DirectionConfig): string {
	if (cfg.action === "move" && cfg.targetFolder) {
		return `moves note to \`${cfg.targetFolder}/\``;
	}
	if (cfg.action === "append-note" && cfg.targetNote) {
		return `records verdict & appends to \`${cfg.targetNote}\``;
	}
	if (cfg.action === "trash") {
		return "moves note to trash";
	}
	return "updates verdict in place";
}

/**
 * Generates a ready-to-paste prompt telling any AI agent or script how to
 * produce items for this deck and how to read back past verdicts.
 */
export function generateAiPrompt(deck: DeckConfig): string {
	const folder = deck.folderPath || "(vault root)";
	const verdictList = (["right", "up", "down", "left"] as SwipeDirection[])
		.map(
			(d) =>
				`- \`${deck.directions[d].verdict}\` (${deck.directions[d].label})`
		)
		.join("\n");

	if (deck.mode === "cards") {
		const hashes = "#".repeat(deck.headingLevel);
		return [
			`You are writing suggestion cards into the Obsidian folder \`${folder}/\` for the Swipe Triage deck "${deck.name}".`,
			"",
			"### File & card format",
			`Create a Markdown file (for example \`digest-YYYY-MM-DD.md\`) with \`status: new\` in YAML frontmatter, followed by one \`${hashes}\` section per item:`,
			"",
			`${hashes} 1. Short actionable title`,
			"",
			"_score 8.5_",
			"",
			"**What it is:** One- or two-sentence plain-language summary.",
			"",
			"**Why it matters:** Why this item is relevant to the user right now.",
			"",
			"> Optional short direct quote from the source.",
			"",
			"**How to try it:**",
			"",
			"1. First concrete step",
			"2. Second concrete step",
			"",
			"**Effort:** 15 minutes",
			"",
			`**${deck.verdictField}:** ${deck.pendingValue}`,
			"",
			"**Source:** [Article or repo title](https://example.com) _(via source-name)_",
			"",
			"### Reading feedback from previous runs",
			`Before generating new cards, scan recent notes in \`${folder}/\` for non-\`${deck.pendingValue}\` \`**${deck.verdictField}:**\` lines:`,
			verdictList,
			"Favor topics similar to positive verdicts and avoid repeating rejected patterns.",
		].join("\n");
	}

	return [
		`You are adding items into the Obsidian folder \`${folder}/\` for the Swipe Triage deck "${deck.name}".`,
		"",
		"### Note format (one file per item)",
		"Create one `.md` file per item with YAML frontmatter:",
		"",
		"---",
		'title: "Short clear title"',
		"created: YYYY-MM-DD",
		"score: 8.5",
		"effort: 15 minutes",
		"source: https://example.com",
		"tags: [triage]",
		`summary: "One-line summary shown at the top of the card."`,
		`${deck.verdictField}: ${deck.pendingValue}`,
		"---",
		"",
		"Short body with context, key points, or next steps.",
		"",
		"### Reading feedback from past swipes",
		`When checking user decisions, look for \`${deck.verdictField}\` in frontmatter (or notes moved into outcome folders):`,
		verdictList,
	].join("\n");
}

export interface SampleFileSpec {
	relativeName: string;
	content: string;
}

/**
 * Creates beginner-friendly sample items so a freshly scaffolded folder is
 * immediately swipeable in 5 seconds.
 */
export function generateSampleFiles(
	deck: DeckConfig,
	todayIso: string
): SampleFileSpec[] {
	if (deck.mode === "cards") {
		const hashes = "#".repeat(deck.headingLevel);
		return [
			{
				relativeName: `sample-digest-${todayIso}.md`,
				content: [
					"---",
					`title: "${deck.name} — ${todayIso}"`,
					"status: new",
					`created: ${todayIso}`,
					"tags: [swipe-triage, sample]",
					"---",
					"",
					`# ${deck.name} — ${todayIso}`,
					"",
					"_Sample digest generated by Swipe Triage. Try swiping left, right, up, or down — then press Cmd/Ctrl+Z to test undo._",
					"",
					`${hashes} 1. Try swiping cards with mouse, touch, or keyboard`,
					"",
					"_score 9.5 · seen in multiple sources_",
					"",
					"**What it is:** A tactile swipe deck built right into Obsidian for triaging AI-generated feeds, reading queues, and inbox notes.",
					"",
					"**Why it matters:** Keeps triage fast on both phone and desktop while writing clean Markdown back to your vault.",
					"",
					"> Plain Markdown files in, plain Markdown verdicts out.",
					"",
					"**How to try it:**",
					"",
					"1. Drag this card in any direction or press arrow / WASD keys",
					"2. Press Space to skip a card to the end of the queue",
					"3. Press Cmd/Ctrl+Z anytime to undo your last swipe",
					"",
					"**Effort:** 2 minutes",
					"",
					`**${deck.verdictField}:** ${deck.pendingValue}`,
					"",
					"**Source:** [Swipe Triage documentation](https://github.com/scottiebakana/obsidian-swipe-triage) _(via sample)_",
					"",
					`${hashes} 2. Customize this deck in _deck.md`,
					"",
					"_score 8.5_",
					"",
					"**What it is:** Every triage folder can hold a `_deck.md` file whose YAML frontmatter defines swipe labels, verdicts, folders, and target notes.",
					"",
					"**Why it matters:** Both humans and AI agents can read and tune the deck without digging through JSON files.",
					"",
					"_(source quote could not be verified — example warning pill)_",
					"",
					"**How to try it:**",
					"",
					"1. Open `_deck.md` in this folder",
					"2. Edit any direction label, color, or action",
					"3. Click Refresh in the Swipe Triage toolbar",
					"",
					"**Effort:** 5 minutes",
					"",
					`**${deck.verdictField}:** ${deck.pendingValue}`,
					"",
					"**Source:** [Example custom deck](https://obsidian.md) _(via sample)_",
					"",
					`${hashes} 3. Minimal free-form cards work too`,
					"",
					"You don't need every field above. Any Markdown heading with a verdict line renders cleanly — including bullet lists:",
					"",
					"- Works with Claude, Codex, n8n, or Python scripts",
					"- Preserves line endings and untouched lines byte-for-byte",
					"- Syncs cleanly to Obsidian Mobile",
					"",
					`**${deck.verdictField}:** ${deck.pendingValue}`,
					"",
				].join("\n"),
			},
		];
	}

	// Note-per-card sample files
	return [
		{
			relativeName: "Welcome to Swipe Triage.md",
			content: [
				"---",
				'title: "Welcome to Swipe Triage"',
				`created: ${todayIso}`,
				"score: 9.5",
				"effort: 2 minutes",
				"tags: [sample, inbox]",
				'summary: "Drop any notes into this folder and swipe to sort them quickly on desktop or mobile."',
				`${deck.verdictField}: ${deck.pendingValue}`,
				"---",
				"",
				"Try dragging this card **right**, **left**, **up**, or **down** (or use `WASD` / arrow keys).",
				"",
				"- Press `Space` to skip to the back of the queue",
				"- Press `Cmd/Ctrl+Z` to undo a move or verdict",
				"- Edit `_deck.md` in this folder to customize where swiped notes go",
				"",
			].join("\n"),
		},
		{
			relativeName: "Tune this folder for AI workflows.md",
			content: [
				"---",
				'title: "Tune this folder for AI workflows"',
				`created: ${todayIso}`,
				"score: 8.5",
				"effort: 5 minutes",
				"source: https://github.com/scottiebakana/obsidian-swipe-triage",
				"tags: [sample, ai]",
				'summary: "Use the Copy AI prompt button so any AI agent writes cards directly in this folder\'s format."',
				`${deck.verdictField}: ${deck.pendingValue}`,
				"---",
				"",
				"Click the **Copy AI prompt** button in the toolbar or settings to copy an exact schema + feedback loop prompt tailored to this deck.",
				"",
			].join("\n"),
		},
	];
}
