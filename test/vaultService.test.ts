import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "obsidian";
import { parseDeckConfigFromFrontmatter } from "../src/deckConfig";
import { createDeckFromPreset } from "../src/presets";
import { DeckAlreadyExistsError, StaleDeckError } from "../src/types";
import { SwipeTriageVaultService } from "../src/vaultService";
import { FakeApp } from "./obsidian-mock";

test("card removed externally throws StaleDeckError and NEVER writes Alpha's verdict onto Beta", async () => {
	const fake = new FakeApp();
	const service = new SwipeTriageVaultService(fake as unknown as App);
	const deck = createDeckFromPreset("ai-digest", "AI-Digest");

	const initial = [
		"---",
		"status: new",
		"---",
		"",
		"## 1. Alpha idea",
		"",
		"**What it is:** Alpha description.",
		"",
		"**Verdict:** pending",
		"",
		"## 2. Beta idea",
		"",
		"**What it is:** Beta description.",
		"",
		"**Verdict:** pending",
		"",
	].join("\n");

	fake.seedFile("AI-Digest/digest-2026-11-22.md", initial);
	const scan = await service.scanDeck(deck);
	assert.equal(scan.pendingCards.length, 2);
	const alphaCard = scan.pendingCards[0];

	// External tool removes Alpha, leaving Beta in position 0
	const alphaRemoved = [
		"---",
		"status: new",
		"---",
		"",
		"## 2. Beta idea",
		"",
		"**What it is:** Beta description.",
		"",
		"**Verdict:** pending",
		"",
	].join("\n");
	fake.seedFile("AI-Digest/digest-2026-11-22.md", alphaRemoved);

	await assert.rejects(
		() => service.applySwipe(deck, alphaCard, "left"),
		(err: unknown) =>
			err instanceof StaleDeckError && err.reason === "card-not-found"
	);

	// Beta MUST still be pending and byte-for-byte untouched
	assert.equal(fake.readRaw("AI-Digest/digest-2026-11-22.md"), alphaRemoved);

	// Same safety guarantee for Undo: swipe Alpha, then Alpha is removed externally -> Undo throws & leaves Beta untouched
	fake.seedFile("AI-Digest/digest-2026-11-22.md", initial);
	const scan2 = await service.scanDeck(deck);
	const undoAlpha = await service.applySwipe(deck, scan2.pendingCards[0], "left");
	fake.seedFile("AI-Digest/digest-2026-11-22.md", alphaRemoved);

	await assert.rejects(
		() => service.undoSwipe(undoAlpha),
		(err: unknown) =>
			err instanceof StaleDeckError && err.reason === "card-not-found"
	);
	assert.equal(fake.readRaw("AI-Digest/digest-2026-11-22.md"), alphaRemoved);
});

test("failed move rolls back frontmatter verdict so rescanning still finds the note pending", async () => {
	const fake = new FakeApp();
	const service = new SwipeTriageVaultService(fake as unknown as App);
	const deck = createDeckFromPreset("inbox", "Triage-Inbox");

	fake.seedFile(
		"Triage-Inbox/idea.md",
		"---\ntitle: Idea\n---\n\nSome note body.\n"
	);

	const before = await service.scanDeck(deck);
	assert.equal(before.pendingCards.length, 1);

	// Simulate move failure
	fake.failRename = true;
	await assert.rejects(() =>
		service.applySwipe(deck, before.pendingCards[0], "right")
	);
	fake.failRename = false;

	// Note must stay in Triage-Inbox without `verdict: keep`, and rescan MUST still return it
	const afterRaw = fake.readRaw("Triage-Inbox/idea.md") ?? "";
	assert.ok(!afterRaw.includes("verdict: keep"));

	const rescan = await service.scanDeck(deck);
	assert.equal(rescan.pendingCards.length, 1);
	assert.equal(rescan.pendingCards[0].title, "Idea");
});

test("failed sink append in cards mode rolls back both verdict and status so rescan still finds card pending", async () => {
	const fake = new FakeApp();
	const service = new SwipeTriageVaultService(fake as unknown as App);
	const deck = createDeckFromPreset("ai-digest", "AI-Digest");

	fake.seedFile(
		"AI-Digest/digest-2026-11-22.md",
		[
			"---",
			"title: Digest",
			"---",
			"",
			"## 1. Single card",
			"",
			"**What it is:** Only card in this digest.",
			"",
			"**Verdict:** pending",
			"",
		].join("\n")
	);

	const before = await service.scanDeck(deck);
	assert.equal(before.pendingCards.length, 1);

	// Simulate failure creating saved.md
	fake.failCreateForPath = "AI-Digest/saved.md";
	await assert.rejects(() =>
		service.applySwipe(deck, before.pendingCards[0], "right")
	);
	fake.failCreateForPath = null;

	const rawAfter = fake.readRaw("AI-Digest/digest-2026-11-22.md") ?? "";
	assert.ok(rawAfter.includes("**Verdict:** pending"));
	assert.ok(!rawAfter.includes("status: reviewed"));

	const rescan = await service.scanDeck(deck);
	assert.equal(rescan.pendingCards.length, 1);
});

test("digest undo deletes frontmatter status when the digest originally had no status property", async () => {
	const fake = new FakeApp();
	const service = new SwipeTriageVaultService(fake as unknown as App);
	const deck = createDeckFromPreset("ai-digest", "AI-Digest");

	fake.seedFile(
		"AI-Digest/no-status-2026-11-22.md",
		[
			"---",
			"title: Digest without status",
			"---",
			"",
			"## 1. Lone card",
			"",
			"**What it is:** Something cool.",
			"",
			"**Verdict:** pending",
			"",
		].join("\n")
	);

	const scan = await service.scanDeck(deck);
	const undoEntry = await service.applySwipe(deck, scan.pendingCards[0], "left");

	const afterSwipe = fake.readRaw("AI-Digest/no-status-2026-11-22.md") ?? "";
	assert.ok(afterSwipe.includes("status: reviewed"));
	assert.equal(undoEntry.changedFileStatus, true);
	assert.equal(undoEntry.hadPreviousFileStatus, false);

	await service.undoSwipe(undoEntry);
	const afterUndo = fake.readRaw("AI-Digest/no-status-2026-11-22.md") ?? "";
	assert.ok(afterUndo.includes("**Verdict:** pending"));
	assert.ok(
		!afterUndo.includes("status:"),
		`Expected status key to be deleted on undo, got:\n${afterUndo}`
	);
});

test("default inbox left swipe moves reversibly to Dismissed and Undo moves it right back", async () => {
	const fake = new FakeApp();
	const service = new SwipeTriageVaultService(fake as unknown as App);
	const deck = createDeckFromPreset("inbox", "Triage-Inbox");

	assert.equal(deck.directions.left.action, "move");
	assert.equal(deck.directions.left.targetFolder, "Triage-Inbox/Dismissed");

	fake.seedFile(
		"Triage-Inbox/fleeting.md",
		"---\ntitle: Fleeting thought\n---\n\nQuick idea.\n"
	);

	const scan = await service.scanDeck(deck);
	const undoEntry = await service.applySwipe(deck, scan.pendingCards[0], "left");

	assert.equal(fake.trashedPaths.length, 0);
	assert.equal(undoEntry.movedToPath, "Triage-Inbox/Dismissed/fleeting.md");
	assert.ok(fake.readRaw("Triage-Inbox/Dismissed/fleeting.md"));
	assert.equal(fake.readRaw("Triage-Inbox/fleeting.md"), undefined);

	const restored = await service.undoSwipe(undoEntry);
	assert.equal(restored, true);
	assert.ok(fake.readRaw("Triage-Inbox/fleeting.md"));
	assert.equal(fake.readRaw("Triage-Inbox/Dismissed/fleeting.md"), undefined);

	const rescan = await service.scanDeck(deck);
	assert.equal(rescan.pendingCards.length, 1);
});

test("scaffoldTriageFolder refuses to overwrite an existing _deck.md unless explicitly allowed", async () => {
	const fake = new FakeApp();
	const service = new SwipeTriageVaultService(fake as unknown as App);
	const customDeckContent =
		"---\nswipe-triage: true\nname: Custom hand-tuned deck\n---\n\nMy custom instructions.\n";

	fake.seedFile("My-Deck/_deck.md", customDeckContent);

	await assert.rejects(
		() => service.scaffoldTriageFolder("My-Deck", "inbox", "Overwritten", true),
		(err: unknown) => err instanceof DeckAlreadyExistsError
	);

	// Custom file must be completely untouched
	assert.equal(fake.readRaw("My-Deck/_deck.md"), customDeckContent);

	// Explicit overwrite succeeds and writes portable ./ paths
	await service.scaffoldTriageFolder(
		"My-Deck",
		"inbox",
		"Replaced deck",
		false,
		true
	);
	const written = fake.readRaw("My-Deck/_deck.md") ?? "";
	assert.ok(written.includes('name: "Replaced deck"'));
	assert.ok(written.includes('target_folder: "./Keep"'));
	assert.ok(written.includes('target_folder: "./Dismissed"'));
	assert.ok(!written.includes('target_folder: "My-Deck/'));

	// Moving/renaming the folder still resolves ./ paths cleanly!
	const reparsed = parseDeckConfigFromFrontmatter(
		{
			"swipe-triage": true,
			name: "Replaced deck",
			mode: "notes",
			directions: {
				right: {
					label: "Keep",
					verdict: "keep",
					color: "green",
					action: "move",
					target_folder: "./Keep",
				},
			},
		},
		"Renamed-Folder",
		"Renamed-Folder/_deck.md"
	);
	assert.equal(reparsed?.directions.right.targetFolder, "Renamed-Folder/Keep");
});

test("missing file throws StaleDeckError and invalid file_pattern fails closed with warning", async () => {
	const fake = new FakeApp();
	const service = new SwipeTriageVaultService(fake as unknown as App);
	const deck = createDeckFromPreset("inbox", "Triage-Inbox");

	fake.seedFile("Triage-Inbox/ghost.md", "---\ntitle: Ghost\n---\nBody\n");
	const scan = await service.scanDeck(deck);
	fake.deleteRaw("Triage-Inbox/ghost.md");

	await assert.rejects(
		() => service.applySwipe(deck, scan.pendingCards[0], "right"),
		(err: unknown) =>
			err instanceof StaleDeckError && err.reason === "missing-file"
	);

	// Invalid filePattern should report error and match 0 files rather than flooding the deck
	fake.seedFile("Triage-Inbox/real.md", "---\ntitle: Real\n---\nBody\n");
	const badDeck = { ...deck, filePattern: "[unclosed-regex" };
	const badScan = await service.scanDeck(badDeck);
	assert.equal(badScan.patternErrors.length, 1);
	assert.equal(badScan.pendingCards.length, 0);
});
