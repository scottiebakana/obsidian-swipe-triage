import {
	StaleDeckError,
	type DeckConfig,
	type ParsedDigestFile,
	type SortMode,
	type TriageCard,
} from "./types";

interface LineToken {
	text: string;
	eol: string;
}

const MAX_NOTE_PREVIEW_CHARS = 3500;

/**
 * Splits text into lines while preserving each line's exact terminator (\r\n, \n, or "").
 */
export function splitLinesPreservingEol(content: string): LineToken[] {
	if (content.length === 0) {
		return [];
	}
	const tokens: LineToken[] = [];
	const regex = /([^\r\n]*)(\r\n|\n|$)/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(content)) !== null) {
		if (match[0].length === 0) {
			break;
		}
		tokens.push({ text: match[1], eol: match[2] });
		if (regex.lastIndex >= content.length) {
			break;
		}
	}
	return tokens;
}

export function joinLinesPreservingEol(tokens: LineToken[]): string {
	return tokens.map((t) => t.text + t.eol).join("");
}

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const idx = content.indexOf("\n");
	if (idx > 0 && content[idx - 1] === "\r") {
		return "\r\n";
	}
	return "\n";
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildVerdictRegex(verdictField: string): RegExp {
	const field = escapeRegExp(verdictField.trim() || "Verdict");
	return new RegExp(`^\\*\\*${field}:\\*\\*\\s*(.*)$`, "i");
}

/**
 * Returns a boolean array marking every line that sits inside (or opens/closes)
 * a Markdown fenced code block (``` or ~~~) so headings inside code never split cards.
 */
function computeCodeFenceFlags(lines: LineToken[]): boolean[] {
	const flags: boolean[] = new Array<boolean>(lines.length).fill(false);
	let activeChar: "`" | "~" | null = null;
	let activeLen = 0;

	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].text.trimStart();
		if (activeChar === null) {
			const openMatch = /^(`{3,}|~{3,})/.exec(trimmed);
			if (openMatch) {
				const seq = openMatch[1];
				const ch = seq[0] as "`" | "~";
				// Backtick info strings cannot contain backticks per CommonMark
				const rest = trimmed.slice(seq.length);
				if (ch === "~" || !rest.includes("`")) {
					activeChar = ch;
					activeLen = seq.length;
					flags[i] = true;
				}
			}
		} else {
			flags[i] = true;
			const closeRe = new RegExp(`^${activeChar}{${activeLen},}\\s*$`);
			if (closeRe.test(trimmed)) {
				activeChar = null;
				activeLen = 0;
			}
		}
	}

	return flags;
}

/**
 * Validates a deck's include and exclude regex patterns, returning any error messages.
 */
export function validateDeckPatterns(
	deck: Pick<DeckConfig, "filePattern" | "excludePattern">
): string[] {
	const errors: string[] = [];
	if (deck.filePattern.trim()) {
		try {
			new RegExp(deck.filePattern.trim(), "i");
		} catch (err) {
			errors.push(
				`Invalid file_pattern regex "${deck.filePattern}": ${
					err instanceof Error ? err.message : String(err)
				}`
			);
		}
	}
	if (deck.excludePattern.trim()) {
		try {
			new RegExp(deck.excludePattern.trim(), "i");
		} catch (err) {
			errors.push(
				`Invalid exclude_pattern regex "${deck.excludePattern}": ${
					err instanceof Error ? err.message : String(err)
				}`
			);
		}
	}
	return errors;
}

/**
 * Checks whether a filename matches a deck's include and exclude regex patterns.
 * Fails closed (returns false) if `filePattern` is malformed so typos never flood the deck.
 */
export function matchesDeckFileFilters(
	fileName: string,
	deck: Pick<DeckConfig, "filePattern" | "excludePattern">
): boolean {
	if (deck.excludePattern.trim()) {
		try {
			const excludeRe = new RegExp(deck.excludePattern.trim(), "i");
			if (excludeRe.test(fileName)) {
				return false;
			}
		} catch {
			// Malformed excludePattern is surfaced via validateDeckPatterns
		}
	}

	if (deck.filePattern.trim()) {
		try {
			const includeRe = new RegExp(deck.filePattern.trim(), "i");
			return includeRe.test(fileName);
		} catch {
			return false;
		}
	}

	return true;
}

/**
 * Extracts a YYYY-MM-DD date from a filename if present.
 */
export function extractDateFromFileName(fileName: string): string {
	const match = /(\d{4}-\d{2}-\d{2})/.exec(fileName);
	return match ? match[1] : "";
}

function formatDateFromMs(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "";
	return new Date(ms).toISOString().slice(0, 10);
}

function findBodyStartLine(lines: LineToken[]): number {
	if (lines.length === 0 || lines[0].text.trim() !== "---") {
		return 0;
	}
	for (let i = 1; i < lines.length; i++) {
		const trimmed = lines[i].text.trim();
		if (trimmed === "---" || trimmed === "...") {
			return i + 1;
		}
	}
	return 0;
}

interface RawCardSlice {
	startLine: number;
	endLine: number;
	headingRaw: string;
	verdictLineIndex: number;
	verdictValue: string;
	bodyFingerprint: string;
}

function computeSliceFingerprint(
	lines: LineToken[],
	startLine: number,
	endLine: number,
	verdictLineIndex: number
): string {
	const parts: string[] = [];
	for (let i = startLine + 1; i < endLine && parts.length < 3; i++) {
		if (i === verdictLineIndex) continue;
		const t = lines[i].text.trim();
		if (t) {
			parts.push(t);
		}
	}
	return parts.join(" | ").slice(0, 160);
}

function findCardSlices(
	lines: LineToken[],
	headingLevel: 2 | 3,
	verdictField: string
): RawCardSlice[] {
	const bodyStart = findBodyStartLine(lines);
	const fenced = computeCodeFenceFlags(lines);
	const headingPrefix = "#".repeat(headingLevel);
	const headingRe = new RegExp(`^${headingPrefix}\\s+`);
	const verdictRe = buildVerdictRegex(verdictField);

	const headingIndices: number[] = [];
	for (let i = bodyStart; i < lines.length; i++) {
		if (!fenced[i] && headingRe.test(lines[i].text)) {
			headingIndices.push(i);
		}
	}

	const slices: RawCardSlice[] = [];
	for (let k = 0; k < headingIndices.length; k++) {
		const startLine = headingIndices[k];
		const endLine =
			k + 1 < headingIndices.length ? headingIndices[k + 1] : lines.length;

		let verdictLineIndex = -1;
		let verdictValue = "";
		for (let i = startLine + 1; i < endLine; i++) {
			if (fenced[i]) continue;
			const match = verdictRe.exec(lines[i].text.trim());
			if (match) {
				verdictLineIndex = i;
				verdictValue = match[1].trim();
				break;
			}
		}

		if (verdictLineIndex !== -1) {
			slices.push({
				startLine,
				endLine,
				headingRaw: lines[startLine].text.trim(),
				verdictLineIndex,
				verdictValue,
				bodyFingerprint: computeSliceFingerprint(
					lines,
					startLine,
					endLine,
					verdictLineIndex
				),
			});
		}
	}

	return slices;
}

function parseSourceField(rawValue: string): {
	label: string;
	url: string;
	via: string;
} {
	let working = rawValue.trim();
	let via = "";

	const viaMatch = /\s+_\(via\s+([^)]+)\)_$/i.exec(working);
	if (viaMatch) {
		via = viaMatch[1].trim();
		working = working.slice(0, viaMatch.index).trim();
	}

	// Greedy (.+) handles nested brackets such as [[AINews] Title](https://...)
	const mdLinkMatch = /^\[(.+)\]\((https?:\/\/[^\s)]+)\)$/.exec(working);
	if (mdLinkMatch) {
		return {
			label: mdLinkMatch[1].trim(),
			url: mdLinkMatch[2].trim(),
			via,
		};
	}

	const urlMatch = /(https?:\/\/\S+)/.exec(working);
	if (urlMatch) {
		const url = urlMatch[1].replace(/[).,;]+$/, "");
		return { label: url, url, via };
	}

	return { label: working, url: "", via };
}

function stripOuterQuotes(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

function isKnownFieldStart(trimmed: string, verdictRe: RegExp): boolean {
	return (
		verdictRe.test(trimmed) ||
		/^\*\*(What it is|Summary|Why it matters(?: for you)?|Why|How to try it|Next steps|Steps|Effort|Time|Score|Source Quote|Source|Link|Warning):\*\*/i.test(
			trimmed
		) ||
		trimmed.startsWith(">") ||
		/^_score\s+/i.test(trimmed) ||
		/source quote could not be verified/i.test(trimmed)
	);
}

/**
 * Parses a multi-card digest Markdown file (`cards` mode).
 * Recognizes structured fields AND preserves any free-form Markdown in `extraMarkdown`.
 */
export function parseDigestFile(
	content: string,
	filePath: string,
	fileName: string,
	deck: Pick<DeckConfig, "headingLevel" | "verdictField" | "pendingValue">,
	fallbackDate = ""
): ParsedDigestFile {
	const date = extractDateFromFileName(fileName) || fallbackDate;
	const fileBasename = fileName.replace(/\.md$/i, "");
	const lines = splitLinesPreservingEol(content);
	const fenced = computeCodeFenceFlags(lines);
	const slices = findCardSlices(lines, deck.headingLevel, deck.verdictField);
	const verdictRe = buildVerdictRegex(deck.verdictField);
	const headingStripRe = new RegExp(`^#{${deck.headingLevel}}\\s+`);
	const pendingTarget = deck.pendingValue.trim().toLowerCase();

	const cards: TriageCard[] = slices.map((slice, cardIndex) => {
		const headingContent = slice.headingRaw.replace(headingStripRe, "").trim();
		let cardNumber: number | null = null;
		let title = headingContent;
		let headingSubpath = headingContent;
		let sourceLabel = "";
		let sourceUrl = "";
		let sourceVia = "";

		const numberedMatch = /^(\d+)\.\s+(.+)$/.exec(headingContent);
		if (numberedMatch) {
			cardNumber = parseInt(numberedMatch[1], 10);
			title = numberedMatch[2].trim();
			headingSubpath = headingContent;
		} else {
			const linkHeadingMatch = /^\[(.+)\]\((https?:\/\/[^\s)]+)\)$/.exec(
				headingContent
			);
			if (linkHeadingMatch) {
				title = linkHeadingMatch[1].trim();
				headingSubpath = title;
				sourceLabel = title;
				sourceUrl = linkHeadingMatch[2].trim();
			}
		}

		let score: number | null = null;
		let seenInMultipleSources = false;
		let whatItIs = "";
		let whyItMatters = "";
		let unverifiedQuote = false;
		let warningText: string | null = null;
		const quoteLines: string[] = [];
		const howToTrySteps: string[] = [];
		const extraLines: string[] = [];
		let effort = "";

		let i = slice.startLine + 1;
		while (i < slice.endLine) {
			const rawLine = lines[i].text;
			const trimmed = rawLine.trim();

			if (i === slice.verdictLineIndex) {
				i++;
				continue;
			}

			// Lines inside fenced code blocks always belong to extraMarkdown verbatim
			if (fenced[i]) {
				extraLines.push(rawLine);
				i++;
				continue;
			}

			if (!trimmed) {
				if (extraLines.length > 0) {
					extraLines.push("");
				}
				i++;
				continue;
			}

			// Italic score line: _score 9.0_ or _score 12.0 · seen in multiple sources_
			const scoreItalicMatch = /^_score\s+(\d+(?:\.\d+)?)(.*?)_$/i.exec(
				trimmed
			);
			if (scoreItalicMatch) {
				score = parseFloat(scoreItalicMatch[1]);
				seenInMultipleSources = /multiple sources/i.test(scoreItalicMatch[2]);
				i++;
				continue;
			}

			// Bold score line: **Score:** 9.0
			const scoreBoldMatch = /^\*\*Score:\*\*\s*(\d+(?:\.\d+)?)(.*)$/i.exec(
				trimmed
			);
			if (scoreBoldMatch) {
				score = parseFloat(scoreBoldMatch[1]);
				if (/multiple sources/i.test(scoreBoldMatch[2])) {
					seenInMultipleSources = true;
				}
				i++;
				continue;
			}

			// Unverified quote warning
			if (/source quote could not be verified/i.test(trimmed)) {
				unverifiedQuote = true;
				warningText = "Unverified quote";
				i++;
				continue;
			}

			const warningMatch = /^\*\*Warning:\*\*\s*(.+)$/i.exec(trimmed);
			if (warningMatch) {
				unverifiedQuote = true;
				warningText = warningMatch[1].trim();
				i++;
				continue;
			}

			// Blockquote
			if (trimmed.startsWith(">")) {
				quoteLines.push(trimmed.replace(/^>\s?/, "").trim());
				i++;
				continue;
			}

			// What it is / Summary
			const whatMatch = /^\*\*(?:What it is|Summary):\*\*\s*(.*)$/i.exec(
				trimmed
			);
			if (whatMatch) {
				const parts = whatMatch[1].trim() ? [whatMatch[1].trim()] : [];
				i++;
				while (i < slice.endLine) {
					if (fenced[i]) break;
					const next = lines[i].text.trim();
					if (!next || isKnownFieldStart(next, verdictRe)) break;
					parts.push(next);
					i++;
				}
				whatItIs = parts.join(" ");
				continue;
			}

			// Why it matters
			const whyMatch =
				/^\*\*(?:Why it matters(?: for you)?|Why):\*\*\s*(.*)$/i.exec(trimmed);
			if (whyMatch) {
				const parts = whyMatch[1].trim() ? [whyMatch[1].trim()] : [];
				i++;
				while (i < slice.endLine) {
					if (fenced[i]) break;
					const next = lines[i].text.trim();
					if (!next || isKnownFieldStart(next, verdictRe)) break;
					parts.push(next);
					i++;
				}
				whyItMatters = parts.join(" ");
				continue;
			}

			// How to try it / Next steps / Steps
			const howMatch =
				/^\*\*(?:How to try it|Next steps|Steps):\*\*\s*(.*)$/i.exec(trimmed);
			if (howMatch) {
				if (howMatch[1].trim()) {
					howToTrySteps.push(howMatch[1].trim());
				}
				i++;
				while (i < slice.endLine) {
					if (fenced[i]) break;
					const next = lines[i].text.trim();
					if (!next) {
						i++;
						continue;
					}
					if (isKnownFieldStart(next, verdictRe)) break;
					const stepText = next
						.replace(/^\d+\.\s+/, "")
						.replace(/^[-*]\s+/, "")
						.trim();
					if (stepText) {
						howToTrySteps.push(stepText);
					}
					i++;
				}
				continue;
			}

			// Effort / Time
			const effortMatch = /^\*\*(?:Effort|Time):\*\*\s*(.*)$/i.exec(trimmed);
			if (effortMatch) {
				effort = effortMatch[1].trim();
				i++;
				continue;
			}

			// Legacy **Source Quote:**
			const legacyQuoteMatch = /^\*\*Source Quote:\*\*\s*(.*)$/i.exec(trimmed);
			if (legacyQuoteMatch) {
				const cleaned = stripOuterQuotes(legacyQuoteMatch[1]);
				if (cleaned) quoteLines.push(cleaned);
				i++;
				continue;
			}

			// Source / Link
			const sourceMatch = /^\*\*(?:Source|Link):\*\*\s*(.*)$/i.exec(trimmed);
			if (sourceMatch) {
				const parsed = parseSourceField(sourceMatch[1]);
				if (parsed.label) sourceLabel = parsed.label;
				if (parsed.url) sourceUrl = parsed.url;
				if (parsed.via) sourceVia = parsed.via;
				i++;
				continue;
			}

			extraLines.push(rawLine);
			i++;
		}

		const verdict = slice.verdictValue.toLowerCase();
		const sourceQuote =
			quoteLines.length > 0 ? quoteLines.join(" ").trim() : null;
		const extraMarkdown = extraLines.join("\n").trim();

		return {
			id: `${filePath}::${cardIndex}::${slice.headingRaw}`,
			mode: "cards",
			filePath,
			fileName,
			fileBasename,
			date,
			cardIndex,
			cardNumber,
			headingRaw: slice.headingRaw,
			headingSubpath,
			bodyFingerprint: slice.bodyFingerprint,
			title,
			score,
			seenInMultipleSources,
			whatItIs,
			whyItMatters,
			sourceQuote,
			unverifiedQuote,
			warningText,
			howToTrySteps,
			extraMarkdown,
			effort,
			verdict,
			verdictLineIndex: slice.verdictLineIndex,
			sourceLabel,
			sourceUrl,
			sourceVia,
			tags: [],
		};
	});

	const pendingCards = cards.filter(
		(c) => c.verdict === pendingTarget || c.verdict === ""
	);

	return {
		filePath,
		fileName,
		date,
		cards,
		pendingCards,
		totalCount: cards.length,
		pendingCount: pendingCards.length,
		isZeroCard: cards.length === 0,
	};
}

function getFrontmatterValue(
	fm: Record<string, unknown> | undefined | null,
	keys: string[]
): unknown {
	if (!fm) return undefined;
	const entries = Object.entries(fm);
	for (const key of keys) {
		if (key in fm && fm[key] !== undefined && fm[key] !== null) {
			return fm[key];
		}
		const lower = key.toLowerCase();
		const found = entries.find(([k]) => k.toLowerCase() === lower);
		if (found && found[1] !== undefined && found[1] !== null) {
			return found[1];
		}
	}
	return undefined;
}

function asTrimmedString(val: unknown): string {
	if (typeof val === "string") return val.trim();
	if (typeof val === "number" || typeof val === "boolean") return String(val);
	if (val instanceof Date) return val.toISOString().slice(0, 10);
	return "";
}

function asNumber(val: unknown): number | null {
	if (typeof val === "number" && Number.isFinite(val)) return val;
	if (typeof val === "string") {
		const parsed = parseFloat(val);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function asTags(val: unknown): string[] {
	if (Array.isArray(val)) {
		return val
			.map((v) => asTrimmedString(v).replace(/^#/, ""))
			.filter(Boolean);
	}
	if (typeof val === "string") {
		return val
			.split(/[,\s]+/)
			.map((t) => t.trim().replace(/^#/, ""))
			.filter(Boolean);
	}
	return [];
}

/**
 * Parses a standalone Markdown note as a single triage card (`notes` mode).
 * Returns null if the note already has a non-pending verdict.
 */
export function parseNoteCard(
	content: string,
	frontmatter: Record<string, unknown> | undefined | null,
	filePath: string,
	fileName: string,
	fileBasename: string,
	ctimeMs: number,
	deck: Pick<DeckConfig, "verdictField" | "pendingValue">
): TriageCard | null {
	const verdictField = deck.verdictField.trim() || "verdict";
	const rawVerdict = asTrimmedString(
		getFrontmatterValue(frontmatter, [verdictField])
	);
	const verdictLower = rawVerdict.toLowerCase();
	const pendingTarget = deck.pendingValue.trim().toLowerCase();

	const isPending = verdictLower === "" || verdictLower === pendingTarget;
	if (!isPending) {
		return null;
	}

	const title =
		asTrimmedString(getFrontmatterValue(frontmatter, ["title"])) ||
		fileBasename;

	const rawDate = asTrimmedString(
		getFrontmatterValue(frontmatter, ["date", "created", "updated"])
	);
	const dateMatch = /(\d{4}-\d{2}-\d{2})/.exec(rawDate);
	const date =
		(dateMatch ? dateMatch[1] : "") ||
		extractDateFromFileName(fileName) ||
		formatDateFromMs(ctimeMs);

	const score = asNumber(
		getFrontmatterValue(frontmatter, ["score", "rating", "priority"])
	);

	const effort = asTrimmedString(
		getFrontmatterValue(frontmatter, ["effort", "time", "duration", "category"])
	);

	const summary = asTrimmedString(
		getFrontmatterValue(frontmatter, ["summary", "description"])
	);

	const whyItMatters = asTrimmedString(
		getFrontmatterValue(frontmatter, ["why", "why_it_matters", "relevance"])
	);

	const rawSource = asTrimmedString(
		getFrontmatterValue(frontmatter, ["source", "url", "link"])
	);
	const parsedSource = rawSource
		? parseSourceField(rawSource)
		: { label: "", url: "", via: "" };

	const tags = asTags(getFrontmatterValue(frontmatter, ["tags", "tag"]));

	const lines = splitLinesPreservingEol(content);
	const bodyStart = findBodyStartLine(lines);
	const bodyLines = lines.slice(bodyStart).map((l) => l.text);

	let firstIdx = 0;
	while (firstIdx < bodyLines.length && bodyLines[firstIdx].trim() === "") {
		firstIdx++;
	}
	if (firstIdx < bodyLines.length) {
		const h1Match = /^#\s+(.+)$/.exec(bodyLines[firstIdx].trim());
		if (h1Match && h1Match[1].trim().toLowerCase() === title.toLowerCase()) {
			firstIdx++;
		}
	}

	let extraMarkdown = bodyLines.slice(firstIdx).join("\n").trim();
	if (extraMarkdown.length > MAX_NOTE_PREVIEW_CHARS) {
		extraMarkdown =
			extraMarkdown.slice(0, MAX_NOTE_PREVIEW_CHARS).trimEnd() +
			"\n\n*(Preview truncated — open note to read in full)*";
	}

	return {
		id: `note::${filePath}`,
		mode: "notes",
		filePath,
		fileName,
		fileBasename,
		date,
		cardIndex: 0,
		cardNumber: null,
		headingRaw: "",
		headingSubpath: "",
		bodyFingerprint: "",
		title,
		score,
		seenInMultipleSources: false,
		whatItIs: summary,
		whyItMatters,
		sourceQuote: null,
		unverifiedQuote: false,
		warningText: null,
		howToTrySteps: [],
		extraMarkdown,
		effort,
		verdict: verdictLower || pendingTarget,
		verdictLineIndex: -1,
		sourceLabel: parsedSource.label,
		sourceUrl: parsedSource.url,
		sourceVia: parsedSource.via,
		tags,
	};
}

export interface VerdictUpdateResult {
	updatedContent: string;
	previousVerdict: string;
	changed: boolean;
	remainingPendingCount: number;
}

/**
 * Updates ONLY the targeted card's verdict line in place (`cards` mode),
 * preserving line endings (CRLF/LF) and every other byte of the file.
 *
 * Refuses to fall back blindly to positional `cardIndex`: if the heading was
 * removed or renamed externally, throws `StaleDeckError` so a neighboring card
 * never receives the wrong verdict.
 */
export function updateCardVerdictInContent(
	content: string,
	target: Pick<TriageCard, "headingRaw" | "cardIndex"> & {
		bodyFingerprint?: string;
	},
	newVerdict: string,
	deck: Pick<DeckConfig, "headingLevel" | "verdictField" | "pendingValue">
): VerdictUpdateResult {
	const lines = splitLinesPreservingEol(content);
	const slices = findCardSlices(lines, deck.headingLevel, deck.verdictField);

	const headingMatches = slices
		.map((s, idx) => ({ slice: s, idx }))
		.filter(({ slice }) => slice.headingRaw === target.headingRaw);

	if (headingMatches.length === 0) {
		throw new StaleDeckError(
			"card-not-found",
			`Card "${target.headingRaw}" no longer exists in the file.`
		);
	}

	let matchedSlice: RawCardSlice;
	if (headingMatches.length === 1) {
		const single = headingMatches[0].slice;
		if (
			target.bodyFingerprint &&
			single.bodyFingerprint &&
			single.bodyFingerprint !== target.bodyFingerprint
		) {
			throw new StaleDeckError(
				"card-ambiguous",
				`Card "${target.headingRaw}" was modified externally.`
			);
		}
		matchedSlice = single;
	} else {
		// Multiple cards share the exact same heading: require fingerprint or exact position+fingerprint match
		const byFingerprint = target.bodyFingerprint
			? headingMatches.filter(
					({ slice }) => slice.bodyFingerprint === target.bodyFingerprint
			  )
			: [];

		if (byFingerprint.length === 1) {
			matchedSlice = byFingerprint[0].slice;
		} else {
			const atIndex = headingMatches.find(
				({ idx, slice }) =>
					idx === target.cardIndex &&
					(!target.bodyFingerprint ||
						slice.bodyFingerprint === target.bodyFingerprint)
			);
			if (!atIndex) {
				throw new StaleDeckError(
					"card-ambiguous",
					`Multiple cards share heading "${target.headingRaw}" and the original card could not be uniquely identified.`
				);
			}
			matchedSlice = atIndex.slice;
		}
	}

	const previousVerdict = matchedSlice.verdictValue;
	const targetLine = lines[matchedSlice.verdictLineIndex];
	const prefixMatch = /^(\s*\*\*[^*]+:\*\*)/.exec(targetLine.text);
	const labelPrefix = prefixMatch
		? prefixMatch[1]
		: `**${deck.verdictField}:**`;
	const nextLineText = `${labelPrefix} ${newVerdict}`;
	const changed = targetLine.text !== nextLineText;

	lines[matchedSlice.verdictLineIndex] = {
		text: nextLineText,
		eol: targetLine.eol,
	};

	const pendingTarget = deck.pendingValue.trim().toLowerCase();
	let remainingPendingCount = 0;
	for (const s of slices) {
		const val =
			s === matchedSlice
				? newVerdict.trim().toLowerCase()
				: s.verdictValue.toLowerCase();
		if (val === pendingTarget || val === "") {
			remainingPendingCount++;
		}
	}

	return {
		updatedContent: joinLinesPreservingEol(lines),
		previousVerdict,
		changed,
		remainingPendingCount,
	};
}

/**
 * Formats a clean single-line checklist item to append to a sink/saved note.
 */
export function formatSinkEntry(
	card: Pick<
		TriageCard,
		"mode" | "fileBasename" | "title" | "whatItIs" | "sourceUrl" | "date"
	>
): string {
	const cleanTitle = card.title.replace(/\s+/g, " ").trim();
	const cleanSummary = card.whatItIs.replace(/\s+/g, " ").trim();
	const parts: string[] = [];

	if (card.mode === "notes") {
		const link =
			card.fileBasename.toLowerCase() === cleanTitle.toLowerCase()
				? `[[${card.fileBasename}]]`
				: `[[${card.fileBasename}|${cleanTitle}]]`;
		parts.push(`- [ ] ${link}`);
	} else {
		parts.push(`- [ ] **${cleanTitle}**`);
	}

	if (cleanSummary) {
		parts.push(`— ${cleanSummary}`);
	}
	if (card.sourceUrl) {
		parts.push(`([Source](${card.sourceUrl}))`);
	}
	if (card.date) {
		parts.push(`_(${card.date})_`);
	}

	return parts.join(" ");
}

function getHeadingBoundaryRegex(sectionHeading: string): RegExp {
	const match = /^(#{1,6})\s+/.exec(sectionHeading.trim());
	const level = match ? match[1].length : 2;
	return new RegExp(`^#{1,${level}}\\s+`);
}

export interface AppendSinkResult {
	updatedContent: string;
	createdSection: boolean;
	alreadyPresent: boolean;
}

/**
 * Appends a checklist item under the configured heading in a sink note,
 * respecting the heading's own Markdown level (and ignoring fenced code blocks).
 */
export function appendSinkEntry(
	content: string,
	sectionHeading: string,
	entryLine: string
): AppendSinkResult {
	const eol = detectLineEnding(content);
	const normalizedHeading = sectionHeading.trim() || "## Saved items";
	const normalizedEntry = entryLine.trim();
	const lines = splitLinesPreservingEol(content);
	const fenced = computeCodeFenceFlags(lines);
	const boundaryRe = getHeadingBoundaryRegex(normalizedHeading);

	let sectionIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (!fenced[i] && lines[i].text.trim() === normalizedHeading) {
			sectionIdx = i;
			break;
		}
	}

	if (sectionIdx === -1) {
		if (content.length === 0) {
			return {
				updatedContent: `${normalizedHeading}${eol}${eol}${normalizedEntry}${eol}`,
				createdSection: true,
				alreadyPresent: false,
			};
		}
		const trimmedEnd = content.replace(/(?:\r\n|\n)+$/, "");
		return {
			updatedContent: `${trimmedEnd}${eol}${eol}${normalizedHeading}${eol}${eol}${normalizedEntry}${eol}`,
			createdSection: true,
			alreadyPresent: false,
		};
	}

	let sectionEnd = lines.length;
	for (let i = sectionIdx + 1; i < lines.length; i++) {
		if (!fenced[i] && boundaryRe.test(lines[i].text.trim())) {
			sectionEnd = i;
			break;
		}
	}

	for (let i = sectionIdx + 1; i < sectionEnd; i++) {
		if (lines[i].text.trim() === normalizedEntry) {
			return {
				updatedContent: content,
				createdSection: false,
				alreadyPresent: true,
			};
		}
	}

	let insertAt = sectionEnd;
	while (insertAt > sectionIdx + 1 && lines[insertAt - 1].text.trim() === "") {
		insertAt--;
	}

	if (insertAt > 0 && lines[insertAt - 1].eol === "") {
		lines[insertAt - 1] = {
			text: lines[insertAt - 1].text,
			eol,
		};
	}

	const newLineEol =
		insertAt < lines.length || content.endsWith("\n") ? eol : "";
	lines.splice(insertAt, 0, {
		text: normalizedEntry,
		eol: newLineEol,
	});

	return {
		updatedContent: joinLinesPreservingEol(lines),
		createdSection: false,
		alreadyPresent: false,
	};
}

/**
 * Reverses `appendSinkEntry` during Undo, respecting heading level and code fences.
 */
export function removeSinkEntry(
	content: string,
	sectionHeading: string,
	entryLine: string,
	removeEmptySection: boolean
): string {
	const normalizedHeading = sectionHeading.trim() || "## Saved items";
	const normalizedEntry = entryLine.trim();
	const lines = splitLinesPreservingEol(content);
	const fenced = computeCodeFenceFlags(lines);
	const boundaryRe = getHeadingBoundaryRegex(normalizedHeading);

	let sectionIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (!fenced[i] && lines[i].text.trim() === normalizedHeading) {
			sectionIdx = i;
			break;
		}
	}
	if (sectionIdx === -1) {
		return content;
	}

	let sectionEnd = lines.length;
	for (let i = sectionIdx + 1; i < lines.length; i++) {
		if (!fenced[i] && boundaryRe.test(lines[i].text.trim())) {
			sectionEnd = i;
			break;
		}
	}

	let removedIdx = -1;
	for (let i = sectionEnd - 1; i > sectionIdx; i--) {
		if (lines[i].text.trim() === normalizedEntry) {
			removedIdx = i;
			break;
		}
	}
	if (removedIdx === -1) {
		return content;
	}

	lines.splice(removedIdx, 1);
	sectionEnd--;

	if (removeEmptySection) {
		let hasNonBlankContent = false;
		for (let i = sectionIdx + 1; i < sectionEnd; i++) {
			if (lines[i].text.trim() !== "") {
				hasNonBlankContent = true;
				break;
			}
		}
		if (!hasNonBlankContent) {
			let removeStart = sectionIdx;
			while (removeStart > 0 && lines[removeStart - 1].text.trim() === "") {
				removeStart--;
			}
			lines.splice(removeStart, sectionEnd - removeStart);
		}
	}

	return joinLinesPreservingEol(lines);
}

/**
 * Sorts cards either newest-first or highest-score-first.
 */
export function sortCards(cards: TriageCard[], mode: SortMode): TriageCard[] {
	const copy = [...cards];
	copy.sort((a, b) => {
		if (mode === "score") {
			const scoreA = a.score ?? -1;
			const scoreB = b.score ?? -1;
			if (scoreB !== scoreA) {
				return scoreB - scoreA;
			}
		}
		const dateCmp = b.date.localeCompare(a.date);
		if (dateCmp !== 0) {
			return dateCmp;
		}
		const numA = a.cardNumber ?? Number.MAX_SAFE_INTEGER;
		const numB = b.cardNumber ?? Number.MAX_SAFE_INTEGER;
		if (numA !== numB) {
			return numA - numB;
		}
		return a.title.localeCompare(b.title);
	});
	return copy;
}
