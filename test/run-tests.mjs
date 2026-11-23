import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import esbuild from "esbuild";

const testFiles = ["test/parser.test.ts", "test/vaultService.test.ts"];
const builtFiles = [];

try {
	for (let i = 0; i < testFiles.length; i++) {
		const outfile = path.resolve(`test/.bundle-${i}.test.mjs`);
		builtFiles.push(outfile);
		await esbuild.build({
			entryPoints: [testFiles[i]],
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node20",
			alias: {
				obsidian: path.resolve("test/obsidian-mock.ts"),
			},
			outfile,
		});
	}

	const result = spawnSync(process.execPath, ["--test", ...builtFiles], {
		stdio: "inherit",
	});

	process.exitCode = result.status ?? 1;
} finally {
	for (const file of builtFiles) {
		if (fs.existsSync(file)) {
			fs.unlinkSync(file);
		}
	}
}
