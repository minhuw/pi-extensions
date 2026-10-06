import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { runGit } from "./primitives.ts";
import { sha256, stableJson } from "../../shared/protocol.ts";

/** Includes ignored files: unlike checkout preservation, forced removal deletes everything. */
export function destructiveSnapshot(worktree: string) {
	const git = (args: string[]) => runGit(worktree, args, { encoding: null, maxBuffer: 64 * 1024 * 1024 }).stdout;
	const index = () => {
		const stage = git(["ls-files", "--stage", "-z"]);
		if (stage.toString("utf8").split("\0").some(row => row.startsWith("160000 "))) throw new Error("Selective revision refuses nested Git/submodule surfaces");
		return sha256(Buffer.concat([stage, git(["ls-files", "-v", "-z"])]));
	};
	const same = (a: fs.BigIntStats, b: fs.BigIntStats) => ["dev", "ino", "mode", "uid", "gid", "size", "mtimeNs", "ctimeNs"].every(key => a[key as keyof fs.BigIntStats] === b[key as keyof fs.BigIntStats]);
	const contents = () => {
		const hash = createHash("sha256");
		function visit(relative: string) {
			const file = path.join(worktree, relative);
			const before = fs.lstatSync(file, { bigint: true });
			const metadata = { relative, mode: String(before.mode), uid: String(before.uid), gid: String(before.gid) };
			let content: string;
			if (before.isSymbolicLink()) content = sha256(fs.readlinkSync(file, { encoding: "buffer" }));
			else if (before.isFile()) {
				const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
				try {
					if (!same(before, fs.fstatSync(fd, { bigint: true }))) throw new Error(`Selective revision path changed: ${file}`);
					const digest = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
					let count: number;
					while ((count = fs.readSync(fd, buffer)) > 0) digest.update(buffer.subarray(0, count));
					content = digest.digest("hex");
				} finally { fs.closeSync(fd); }
			} else if (before.isDirectory()) {
				const names = fs.readdirSync(file).sort();
				if ((relative && names.some(name => name.toLowerCase() === ".git")) || (names.includes("HEAD") && names.includes("objects") && names.includes("refs"))) throw new Error(`Selective revision refuses nested Git surface: ${file}`);
				content = "directory";
				for (const name of names) {
					if (!relative && name === ".git") continue; // Attachment is independently inode/hash fenced.
					visit(path.join(relative, name));
				}
			} else throw new Error(`Selective revision refuses unsafe special file: ${file}`);
			if (!same(before, fs.lstatSync(file, { bigint: true }))) throw new Error(`Selective revision path changed while hashing: ${file}`);
			hash.update(stableJson({ ...metadata, content }) + "\n");
		}
		visit("");
		return hash.digest("hex");
	};
	const count = (args: string[]) => git(args).toString("utf8").split("\0").filter(Boolean).length;
	const indexSha256 = index(), contentSha256 = contents();
	const counts = {
		tracked: count(["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z"]),
		staged: count(["diff", "--cached", "--no-ext-diff", "--no-renames", "--name-only", "-z", "HEAD"]),
		untracked: count(["ls-files", "--others", "--exclude-standard", "-z"]),
		ignored: count(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]),
	};
	if (indexSha256 !== index() || contentSha256 !== contents()) throw new Error("Selective revision destructive snapshot changed during capture");
	return { sha256: sha256(stableJson({ indexSha256, contentSha256 })), ...counts };
}
