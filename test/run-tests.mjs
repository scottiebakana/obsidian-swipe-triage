import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import esbuild from "esbuild";

const outfile = path.resolve("test/.bundle.test.mjs");

try {
	await esbuild.build({
		entryPoints: ["test/parser.test.ts"],
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node20",
		outfile,
	});

	const result = spawnSync(process.execPath, ["--test", outfile], {
		stdio: "inherit",
	});

	process.exitCode = result.status ?? 1;
} finally {
	if (fs.existsSync(outfile)) {
		fs.unlinkSync(outfile);
	}
}
