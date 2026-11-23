# Swipe Triage

Turn any folder of Markdown notes—or multi-card AI digests—into a fast, mobile-friendly Tinder-style swipe deck right inside Obsidian.

Designed to be **plug-and-play for humans** and **self-describing for AI agents** (Claude Code, Codex, Cursor, n8n, or Python scripts).

---

## Features

- **Two drop-in deck modes:**
  - **One note per card (`notes` mode):** Dump fleeting notes, web clippings, bookmarks, or inbox drafts into a folder. Swipe to move notes into outcome folders (`Keep/`, `Archive/`, `Someday/`), set frontmatter verdicts, append links to a saved note, or trash.
  - **Multi-card digest (`cards` mode):** Parse multiple `## ` (or `### `) cards inside daily or batch digest notes. Swiping updates each card's `**Verdict:**` line in place (preserving line endings and untouched text byte-for-byte), flips frontmatter `status` to `reviewed` when the last pending card is cleared, and optionally appends liked cards to a wishlist/saved note.
- **Folder-level `_deck.md` configuration:** Any folder containing a `_deck.md` note with `swipe-triage: true` in its YAML frontmatter is automatically discovered as a deck. Edit labels, colors, verdicts, and destinations in plain YAML—no plugin code needed.
- **1-click folder scaffolder:** Run **Swipe Triage: Create triage folder** to generate a ready-to-swipe folder (`Inbox triage`, `AI digest feed`, or `Reading queue`) with `_deck.md`, outcome folders or saved note, and starter sample items.
- **Built-in AI prompt & schema copy:** Click the robot icon (or run **Swipe Triage: Copy AI prompt for active deck**) to copy a tailored prompt telling any AI tool the exact schema to write and how to read your past verdicts back as a taste feedback loop.
- **Desktop & mobile native (`isDesktopOnly: false`):** Smooth 4-direction touch & mouse drag physics with directional stamps, keyboard shortcuts, Undo (`Cmd/Ctrl+Z`), Skip (`Space`), Newest vs. Top score sorting, and light/dark theme support.

---

## Controls

| Action | Gesture | Keyboard |
| --- | --- | --- |
| **Right** (e.g. Keep / Star) | Swipe right | `→` or `D` |
| **Left** (e.g. Trash / No) | Swipe left | `←` or `A` |
| **Up** (e.g. Archive / Tried / Read) | Swipe up | `↑` or `W` |
| **Down** (e.g. Someday / Meh / Later) | Swipe down | `↓` or `S` |
| **Skip** (send to end of queue) | Tap Skip | `Space` |
| **Undo** (reverts verdict, move & saved line) | Tap Undo | `Cmd/Ctrl + Z` |
| **Open source note** | Tap note icon | `O` |

---

## Quick Start (30 seconds)

1. Open the Command Palette and run **Swipe Triage: Create triage folder**.
2. Pick a starter preset:
   - **Inbox triage** — dump any notes into a folder and swipe into `Keep/`, `Archive/`, `Someday/`, or trash.
   - **AI digest feed** — multi-card `## ` suggestion digests with in-place `**Verdict:**` feedback and auto-saved favorites.
   - **Reading queue** — bookmark/clipping notes with `Star`, `Read`, `Later`, and `Drop`.
3. Swipe through the sample cards, then drop your own notes in—or click **Copy AI prompt** to wire up an AI agent or script.

---

## Configuring a Folder with `_deck.md`

Place a `_deck.md` file inside any folder to make it a self-contained deck that both humans and AI agents can read and tune:

```yaml
---
swipe-triage: true
name: "AI digest feed"
mode: cards # "notes" (one file per card) or "cards" (multiple ## cards per file)
heading_level: 2
verdict_field: "Verdict"
pending_value: "pending"
reviewed_status: "reviewed"
default_sort: newest # "newest" or "score"
exclude_pattern: "(?:^_index\\.md$|^README\\.md$|week-)"
directions:
  left:
    label: "No"
    verdict: "no"
    color: red
    action: verdict
  down:
    label: "Meh"
    verdict: "meh"
    color: orange
    action: verdict
  up:
    label: "Tried"
    verdict: "tried"
    color: blue
    action: verdict
  right:
    label: "Keep"
    verdict: "more-like-this"
    color: green
    action: append-note
    target_note: "./saved.md"
    target_heading: "## Saved items"
---
```

Supported `action` values per direction:
- `verdict` — update the card's `**Verdict:**` line (`cards` mode) or frontmatter property (`notes` mode) in place.
- `append-note` — update the verdict **and** append a `- [ ]` checklist item to `target_note` under `target_heading` (created automatically if missing).
- `move` (`notes` mode) — update optional frontmatter verdict and move the note to `target_folder` (relative paths starting with `./` resolve inside the deck folder).
- `trash` (`notes` mode) — move the note to trash using Obsidian's configured deleted-files preference.

---

## Card Format (`cards` mode)

Any `## ` (or `### `) heading containing a `**Verdict:** pending` line is recognized as a card. Structured fields are styled automatically, and any extra Markdown (bullets, callouts, custom fields) renders natively inside the card:

```markdown
## 1. Try local RAG over your research notes

_score 9.0 · seen in multiple sources_

**What it is:** A local tool for chatting with Markdown folders without cloud uploads.

**Why it matters:** Keeps private notes offline while speeding up research synthesis.

> Optional verified quote from the source.

**How to try it:**

1. Clone the repository
2. Point it at a test folder

**Effort:** an evening

**Verdict:** pending

**Source:** [Project repository](https://example.com) _(via selfhosted)_
```

Minimal free-form cards work too—only a heading and `**Verdict:** pending` are required.

---

## Installation

### Via BRAT (recommended while community listing is pending)
1. Install the **BRAT** community plugin in Obsidian.
2. Run **BRAT: Add a beta plugin for testing** and paste `scottiebakana/obsidian-swipe-triage`.
3. Enable **Swipe Triage** in *Settings → Community plugins*.

### Manual installation
1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [GitHub Release](https://github.com/scottiebakana/obsidian-swipe-triage/releases).
2. Copy them into `<your-vault>/.obsidian/plugins/swipe-triage/`.
3. Reload Obsidian and enable **Swipe Triage** in *Settings → Community plugins*.

---

## Development

```bash
npm install
npm test        # Run unit tests
npm run lint    # Run eslint-plugin-obsidianmd checks
npm run build   # Type-check & bundle main.js
```

## License

[MIT](LICENSE)
