export function normalizePath(p: string): string {
	const cleaned = p
		.replace(/\\/g, "/")
		.replace(/\/+/g, "/")
		.replace(/^\/+|\/+$/g, "");
	return cleaned || "/";
}

export class TAbstractFile {
	path: string;
	name: string;
	parent: TFolder | null = null;

	constructor(path: string) {
		this.path = normalizePath(path);
		const parts = this.path.split("/");
		this.name = parts[parts.length - 1] || "";
	}
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];

	isRoot(): boolean {
		return this.path === "/";
	}
}

export class TFile extends TAbstractFile {
	basename: string;
	extension: string;
	stat: { ctime: number; mtime: number; size: number };

	constructor(path: string, size = 0) {
		super(path);
		const dotIdx = this.name.lastIndexOf(".");
		if (dotIdx > 0) {
			this.basename = this.name.slice(0, dotIdx);
			this.extension = this.name.slice(dotIdx + 1);
		} else {
			this.basename = this.name;
			this.extension = "";
		}
		const now = Date.now();
		this.stat = { ctime: now, mtime: now, size };
	}
}

function parseSimpleYamlFrontmatter(
	content: string
): Record<string, unknown> | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
	if (!match) return undefined;

	const fm: Record<string, unknown> = {};
	const lines = match[1].split(/\r?\n/);
	for (const line of lines) {
		const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (!kv) continue;
		const key = kv[1];
		let val: unknown = kv[2].trim();
		if (val === "true") val = true;
		else if (val === "false") val = false;
		else if (
			typeof val === "string" &&
			((val.startsWith('"') && val.endsWith('"')) ||
				(val.startsWith("'") && val.endsWith("'")))
		) {
			val = val.slice(1, -1);
		} else if (typeof val === "string" && /^-?\d+(?:\.\d+)?$/.test(val)) {
			val = Number(val);
		}
		fm[key] = val;
	}
	return fm;
}

function applyFrontmatterObject(
	content: string,
	fm: Record<string, unknown>
): string {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(content);
	const body = match ? content.slice(match[0].length) : content;
	const entries = Object.entries(fm).filter(([, v]) => v !== undefined);
	if (entries.length === 0) {
		return body;
	}
	const yamlLines = entries.map(([k, v]) => {
		if (typeof v === "string") {
			return `${k}: ${v}`;
		}
		return `${k}: ${String(v)}`;
	});
	return `---\n${yamlLines.join("\n")}\n---\n${body}`;
}

export class FakeApp {
	private files = new Map<string, { file: TFile; content: string }>();
	private folders = new Map<string, TFolder>();
	trashedPaths: string[] = [];
	failRename = false;
	failProcessForPath: string | null = null;
	failCreateForPath: string | null = null;

	constructor() {
		this.folders.set("/", new TFolder("/"));
	}

	private ensureParentFolder(folderPath: string): TFolder {
		const norm = normalizePath(folderPath);
		if (norm === "/") return this.folders.get("/")!;
		const existing = this.folders.get(norm);
		if (existing) return existing;

		const slash = norm.lastIndexOf("/");
		const parentPath = slash > 0 ? norm.slice(0, slash) : "/";
		const parent = this.ensureParentFolder(parentPath);

		const folder = new TFolder(norm);
		folder.parent = parent;
		parent.children.push(folder);
		this.folders.set(norm, folder);
		return folder;
	}

	seedFile(filePath: string, content: string): TFile {
		const norm = normalizePath(filePath);
		const slash = norm.lastIndexOf("/");
		const parentPath = slash > 0 ? norm.slice(0, slash) : "/";
		const parent = this.ensureParentFolder(parentPath);

		const existing = this.files.get(norm);
		if (existing) {
			existing.content = content;
			return existing.file;
		}

		const file = new TFile(norm, content.length);
		file.parent = parent;
		parent.children.push(file);
		this.files.set(norm, { file, content });
		return file;
	}

	readRaw(filePath: string): string | undefined {
		return this.files.get(normalizePath(filePath))?.content;
	}

	deleteRaw(filePath: string): void {
		const norm = normalizePath(filePath);
		const entry = this.files.get(norm);
		if (!entry) return;
		if (entry.file.parent) {
			entry.file.parent.children = entry.file.parent.children.filter(
				(c) => c !== entry.file
			);
		}
		this.files.delete(norm);
	}

	vault = {
		getRoot: (): TFolder => this.folders.get("/")!,
		getMarkdownFiles: (): TFile[] =>
			Array.from(this.files.values())
				.map((e) => e.file)
				.filter((f) => f.extension === "md"),
		getAbstractFileByPath: (p: string): TAbstractFile | null => {
			const norm = normalizePath(p);
			return this.files.get(norm)?.file ?? this.folders.get(norm) ?? null;
		},
		cachedRead: async (file: TFile): Promise<string> => {
			const entry = this.files.get(file.path);
			if (!entry) throw new Error(`File not found: ${file.path}`);
			return entry.content;
		},
		process: async (
			file: TFile,
			fn: (data: string) => string
		): Promise<string> => {
			if (
				this.failProcessForPath &&
				normalizePath(this.failProcessForPath) === file.path
			) {
				throw new Error(`Simulated process failure on ${file.path}`);
			}
			const entry = this.files.get(file.path);
			if (!entry) throw new Error(`File not found: ${file.path}`);
			const next = fn(entry.content);
			entry.content = next;
			return next;
		},
		modify: async (file: TFile, data: string): Promise<void> => {
			const entry = this.files.get(file.path);
			if (!entry) throw new Error(`File not found: ${file.path}`);
			entry.content = data;
		},
		create: async (filePath: string, data: string): Promise<TFile> => {
			const norm = normalizePath(filePath);
			if (
				this.failCreateForPath &&
				normalizePath(this.failCreateForPath) === norm
			) {
				throw new Error(`Simulated create failure on ${norm}`);
			}
			return this.seedFile(norm, data);
		},
		createFolder: async (folderPath: string): Promise<void> => {
			this.ensureParentFolder(folderPath);
		},
	};

	metadataCache = {
		getFileCache: (file: TFile): { frontmatter?: Record<string, unknown> } | null => {
			const entry = this.files.get(file.path);
			if (!entry) return null;
			return { frontmatter: parseSimpleYamlFrontmatter(entry.content) };
		},
	};

	fileManager = {
		processFrontMatter: async (
			file: TFile,
			fn: (fm: Record<string, unknown>) => void
		): Promise<void> => {
			const entry = this.files.get(file.path);
			if (!entry) throw new Error(`File not found: ${file.path}`);
			const fm = parseSimpleYamlFrontmatter(entry.content) ?? {};
			fn(fm);
			entry.content = applyFrontmatterObject(entry.content, fm);
		},
		renameFile: async (file: TFile, newPath: string): Promise<void> => {
			if (this.failRename) {
				throw new Error(`Simulated rename failure to ${newPath}`);
			}
			const oldNorm = file.path;
			const newNorm = normalizePath(newPath);
			const entry = this.files.get(oldNorm);
			if (!entry) throw new Error(`File not found: ${oldNorm}`);

			if (file.parent) {
				file.parent.children = file.parent.children.filter((c) => c !== file);
			}
			this.files.delete(oldNorm);

			const slash = newNorm.lastIndexOf("/");
			const parentPath = slash > 0 ? newNorm.slice(0, slash) : "/";
			const newParent = this.ensureParentFolder(parentPath);

			file.path = newNorm;
			const parts = newNorm.split("/");
			file.name = parts[parts.length - 1] || "";
			const dotIdx = file.name.lastIndexOf(".");
			file.basename = dotIdx > 0 ? file.name.slice(0, dotIdx) : file.name;
			file.parent = newParent;
			newParent.children.push(file);
			this.files.set(newNorm, { file, content: entry.content });
		},
		trashFile: async (file: TFile): Promise<void> => {
			this.trashedPaths.push(file.path);
			this.deleteRaw(file.path);
		},
	};

	workspace = {
		getLeaf: () => ({
			openFile: async () => {},
		}),
	};
}
