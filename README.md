# Swipe Triage

Turn any Obsidian folder into a fast, mobile-friendly swipe deck controlled by a single plain-text `_deck.md` note—so both **humans** and **AI agents** (Claude Code, Codex, Cursor, n8n, or Python scripts) can drop items in, swipe through them, and read decisions back.

---

## How It Works (10-Second Example)

Drop an AI-generated digest (or standalone notes) into a folder with a `_deck.md` file:

```markdown
## 1. Local semantic search for Markdown folders

_score 9.0_

**What it is:** A local index for searching private Markdown notes offline.

**Why it matters:** Answers questions across your vault without cloud uploads.

**Effort:** an evening

**Verdict:** pending

**Source:** [Project repository](https://example.com) _(via selfhosted)_
```

**Swipe right (`Keep`)** → Swipe Triage updates only the single `**Verdict:**` line in place (preserving line endings and untouched lines byte-for-byte) and appends a checklist item to `saved.md`:

```diff
- **Verdict:** pending
+ **Verdict:** more-like-this
```

```markdown
## Saved items

- [ ] **Local semantic search for Markdown folders** — A local index for searching private Markdown notes offline. ([Source](https://example.com)) _(2026-11-22)_
```

On the next run, your AI script reads recent `**Verdict:**` lines (`more-like-this`, `tried`, `meh`, `no`) to learn your taste—and when new notes arrive in the folder, the deck refreshes automatically.

---

## Features

- **Folder-level `_deck.md` configuration (the core idea):** Put a `_deck.md` note with `swipe-triage: true` in its YAML frontmatter inside any folder. Swipe Triage auto-discovers it, and both you and your AI tools can edit swipe labels, colors, verdicts, and destinations in plain YAML.
- **Two drop-in modes:**
  - **Multi-card digest (`cards` mode):** Parse multiple `## ` (or `### `) cards inside daily or batch digest notes. Updates verdicts in place, flips note frontmatter `status` to `reviewed` when the last pending card is cleared, and optionally appends liked cards to a sink note.
  - **One note per card (`notes` mode):** Dump fleeting notes, web clippings, bookmarks, or inbox drafts into a folder. Swipe to move notes into reversible subfolders (`./Keep`, `./Archive`, `./Someday`, `./Dismissed`), set frontmatter verdicts, append `- [ ] [[Note]]` links to a saved note, or optionally trash.
- **Safe defaults & full Undo:** All 3 starter presets use **reversible** actions (moves, verdict updates, and sink-note appends) so an accidental swipe can always be undone with `Cmd/Ctrl+Z`. Permanent `trash` is available as an explicit opt-in action.
- **1-click folder scaffolder:** Run **Swipe Triage: Create triage folder** to scaffold a ready-to-swipe folder (`Inbox triage`, `AI digest feed`, or `Reading queue`) with `_deck.md`, subfolders or `saved.md`, and starter sample cards—without ever silently overwriting an existing `_deck.md`.
- **Built-in AI prompt & schema copy:** Click the robot icon (or run **Swipe Triage: Copy AI prompt for active deck**) to copy a tailored prompt telling any AI agent the exact format to write and how to read your past verdicts back.
- **Live auto-refresh + mobile native (`isDesktopOnly: false`):** Automatically picks up newly dropped files from agents or sync, supports smooth 4-direction touch & mouse drag physics, keyboard shortcuts, and Obsidian light/dark themes.

---

## Controls

| Action | Gesture | Keyboard |
| --- | --- | --- |
| **Right** (e.g. Keep / Star) | Swipe right | `→` or `D` |
| **Left** (e.g. Dismiss / Drop / No) | Swipe left | `←` or `A` |
| **Up** (e.g. Archive / Tried / Read) | Swipe up | `↑` or `W` |
| **Down** (e.g. Someday / Meh / Later) | Swipe down | `↓` or `S` |
| **Skip** (move to end of queue) | Tap Skip | `Space` |
| **Undo** (reverts verdicts, moves & saved lines*) | Tap Undo | `Cmd/Ctrl + Z` |
| **Open source note** | Tap note icon | `O` |

*\*If you explicitly configure a direction with `action: trash`, trashed files are moved via Obsidian's trash preference and must be restored from trash manually.*

---

## Quick Start (30 Seconds)

1. Open the Command Palette and run **Swipe Triage: Create triage folder**.
2. Pick a starter preset:
   - **Inbox triage** — dump any notes into a folder and swipe into `./Keep`, `./Archive`, `./Someday`, or `./Dismissed`.
   - **AI digest feed** — multi-card `## ` suggestion digests with in-place `**Verdict:**` feedback and auto-saved favorites in `./saved.md`.
   - **Reading queue** — bookmark/clipping notes with `Star` (`./favorites.md`), `Read` (`./Read`), `Later`, and `Drop` (`./Dropped`).
3. Swipe through the sample cards, then drop your own notes in—or click **Copy AI prompt** to wire up an AI agent or script.

---

## Configuring a Folder with `_deck.md`

Place a `_deck.md` file inside any folder to turn it into a self-contained deck:

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

### Path resolution in `_deck.md`
- **Relative to the deck folder (recommended):** Prefix with `./` (for example, `target_folder: "./Keep"` or `target_note: "./saved.md"`). These keep working even if you rename or move the parent folder.
- **Relative to the vault root:** Omit `./` (for example, `target_folder: "Projects/Keep"` or `target_note: "Lists/saved.md"`).

### Supported direction actions
- `verdict` — update the card's `**Verdict:**` line (`cards` mode) or frontmatter property (`notes` mode) in place.
- `append-note` — update the verdict **and** append a `- [ ]` checklist item to `target_note` under `target_heading` (created automatically if missing).
- `move` (`notes` mode) — update optional frontmatter verdict and move the note to `target_folder` (fully reversible with Undo).
- `trash` (`notes` mode, explicit opt-in) — move the note to trash using Obsidian's configured deleted-files preference (restored manually from trash).

---

## Card Format (`cards` mode)

Any `## ` (or `### `) heading outside fenced code blocks containing a `**Verdict:** pending` line is recognized as a card. Structured fields (`_score X_`, `**What it is:**`, `**Why it matters:**`, `> quote`, `**How to try it:**`, `**Effort:**`, `**Source:**`) are styled automatically, and any extra Markdown renders natively inside the card. Minimal free-form cards work too—only a heading and `**Verdict:** pending` are required.

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
npm test        # Run parser + vaultService regression tests
npm run lint    # Run eslint-plugin-obsidianmd checks
npm run build   # Type-check & bundle main.js
```

## License

[MIT](LICENSE)
