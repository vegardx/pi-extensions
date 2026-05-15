import { classifyStatic, parseClassifyResponse } from "../bash-classifier.js";

// ---- classifyStatic -----------------------------------------------------

describe("classifyStatic", () => {
	describe("allowlist", () => {
		it("allows git read commands", () => {
			expect(classifyStatic("git log --oneline -10")?.verdict).toBe("allow");
			expect(classifyStatic("git diff HEAD~3")?.verdict).toBe("allow");
			expect(classifyStatic("git branch -a")?.verdict).toBe("allow");
			expect(classifyStatic("git status")?.verdict).toBe("allow");
			expect(classifyStatic("git show HEAD")?.verdict).toBe("allow");
			expect(classifyStatic("git blame src/foo.ts")?.verdict).toBe("allow");
		});

		it("allows common read-only binaries", () => {
			// cat is excluded — it redirects to the read tool (tested separately)
			expect(classifyStatic("ls -la src/")?.verdict).toBe("allow");
			expect(classifyStatic("rg TODO src/")?.verdict).toBe("allow");
			expect(classifyStatic("tree src/")?.verdict).toBe("allow");
			expect(classifyStatic("wc -l src/foo.ts")?.verdict).toBe("allow");
		});

		it("redirects cat to the read tool", () => {
			const r = classifyStatic("cat src/foo.ts");
			expect(r?.verdict).toBe("redirect");
			expect(r?.tool).toBe("read");
		});

		it("allows gh CLI read operations", () => {
			expect(classifyStatic("gh pr list --state open")?.verdict).toBe("allow");
			expect(classifyStatic("gh issue view 42")?.verdict).toBe("allow");
			expect(classifyStatic("gh run list --branch main")?.verdict).toBe(
				"allow",
			);
			expect(classifyStatic("gh search issues foo")?.verdict).toBe("allow");
		});

		it("defers gh api to LLM (can mutate)", () => {
			expect(classifyStatic("gh api repos/org/repo/pulls")).toBeNull();
		});

		it("allows gh commands even when body contains deny-list words", () => {
			expect(
				classifyStatic(
					'gh issue create --title "cleanup" --body "rm the old config files"',
				)?.verdict,
			).toBe("allow");
			expect(
				classifyStatic(
					'gh pr comment 42 --body "DELETE the stale rows from the table"',
				)?.verdict,
			).toBe("allow");
			expect(
				classifyStatic(
					'gh issue edit 99 --body "kill the background worker and restart"',
				)?.verdict,
			).toBe("allow");
			expect(
				classifyStatic('gh search issues "DROP TABLE users"')?.verdict,
			).toBe("allow");
		});

		it("defers curl to LLM (ambiguous)", () => {
			expect(classifyStatic("curl -s https://api.example.com")).toBeNull();
			expect(classifyStatic("curl --silent https://docs.rs")).toBeNull();
		});

		it("allows npm read-only commands", () => {
			expect(classifyStatic("npm list")?.verdict).toBe("allow");
			expect(classifyStatic("npm view lodash versions")?.verdict).toBe("allow");
			expect(classifyStatic("npm outdated")?.verdict).toBe("allow");
		});

		it("allows npx tsc --noEmit and biome check", () => {
			expect(classifyStatic("npx tsc --noEmit")?.verdict).toBe("allow");
			expect(classifyStatic("npx biome check .")?.verdict).toBe("allow");
		});

		it("blocks allow-listed commands with output redirects", () => {
			expect(classifyStatic("git log > out.txt")?.verdict).toBe("block");
			expect(classifyStatic("cat foo.ts >> bar.ts")?.verdict).toBe("block");
			expect(classifyStatic("echo hello > file")?.verdict).toBe("block");
		});
	});

	describe("chaining / bypass prevention", () => {
		it("redirects piped cat — chain handler propagates redirect", () => {
			const r = classifyStatic("cat package.json | grep prepare");
			expect(r?.verdict).toBe("redirect");
			expect(r?.tool).toBe("read");
		});

		it("still blocks chained commands when any segment is dangerous", () => {
			expect(classifyStatic("git log && rm -rf node_modules")?.verdict).toBe(
				"block",
			);
			expect(classifyStatic("ls -la; rm -rf /")?.verdict).toBe("block");
			expect(classifyStatic("echo hi || git push origin main")?.verdict).toBe(
				"block",
			);
		});

		it("blocks gh commands chained with dangerous segments", () => {
			expect(classifyStatic("gh pr list; rm -rf ~/work")?.verdict).toBe(
				"block",
			);
			expect(
				classifyStatic("gh issue view 1 && git push origin main")?.verdict,
			).toBe("block");
		});

		it("defers gh commands with substitutions to LLM", () => {
			expect(classifyStatic("gh api repos/foo $(rm -rf /tmp/x)")).toBeNull();
			expect(
				classifyStatic("gh issue create --body `cat /etc/passwd`"),
			).toBeNull();
		});

		it("blocks time-prefixed destructive commands", () => {
			expect(classifyStatic("time rm -rf foo")?.verdict).toBe("block");
		});

		it("blocks plain cp/mv (mutations without redirects)", () => {
			expect(classifyStatic("cp a b")?.verdict).toBe("block");
			expect(classifyStatic("mv a b")?.verdict).toBe("block");
		});

		it("blocks git tag creation (mutation)", () => {
			expect(classifyStatic("git tag v1.0.0")).toBeNull();
		});

		it("blocks git branch -D (mutation)", () => {
			expect(classifyStatic("git branch -D foo")).toBeNull();
		});

		it("defers awk/sed to LLM (can write files)", () => {
			expect(classifyStatic("awk '{print}' file.txt")).toBeNull();
		});
	});

	describe("denylist", () => {
		it("blocks rm/rmdir", () => {
			expect(classifyStatic("rm -rf node_modules")?.verdict).toBe("block");
			expect(classifyStatic("rmdir empty_dir")?.verdict).toBe("block");
		});

		it("blocks package installs", () => {
			expect(classifyStatic("npm install lodash")?.verdict).toBe("block");
			expect(classifyStatic("npm i -D typescript")?.verdict).toBe("block");
			expect(classifyStatic("yarn add react")?.verdict).toBe("block");
			expect(classifyStatic("pnpm add zod")?.verdict).toBe("block");
			expect(classifyStatic("pip install requests")?.verdict).toBe("block");
		});

		it("blocks git mutations", () => {
			expect(classifyStatic("git push origin main")?.verdict).toBe("block");
			expect(classifyStatic("git reset --hard HEAD~1")?.verdict).toBe("block");
			expect(classifyStatic("git rebase main")?.verdict).toBe("block");
			expect(classifyStatic("git commit -m 'x'")?.verdict).toBe("block");
		});

		it("blocks gh pr mutations (route through /commit and /ship)", () => {
			expect(classifyStatic("gh pr create --title x")?.verdict).toBe("block");
			expect(classifyStatic("gh pr edit 42 --title x")?.verdict).toBe("block");
			expect(classifyStatic("gh pr merge 42")?.verdict).toBe("block");
			expect(classifyStatic("gh pr close 42")?.verdict).toBe("block");
			expect(classifyStatic("gh pr ready 42")?.verdict).toBe("block");
			// Read-only gh pr commands stay allowed via PRIORITY_ALLOW_PREFIXES
			expect(classifyStatic("gh pr list --head feat/x")?.verdict).toBe("allow");
			expect(classifyStatic("gh pr view 42 --json state")?.verdict).toBe(
				"allow",
			);
		});

		it("blocks sed -i (in-place edit)", () => {
			expect(classifyStatic("sed -i 's/foo/bar/' file.ts")?.verdict).toBe(
				"block",
			);
		});

		it("blocks docker run/exec", () => {
			expect(classifyStatic("docker run --rm alpine sh")?.verdict).toBe(
				"block",
			);
			expect(classifyStatic("docker exec -it container bash")?.verdict).toBe(
				"block",
			);
		});

		it("blocks sudo", () => {
			expect(classifyStatic("sudo apt-get update")?.verdict).toBe("block");
		});

		it("blocks tee (writes to file)", () => {
			expect(classifyStatic("echo x | tee output.txt")?.verdict).toBe("block");
		});
	});

	describe("ambiguous commands", () => {
		it("returns null for ambiguous commands (defers to LLM)", () => {
			expect(classifyStatic("node search.js query")).toBeNull();
			expect(classifyStatic('python3 -c "print(2+2)"')).toBeNull();
			expect(classifyStatic("npm test")).toBeNull();
			expect(classifyStatic("make check")).toBeNull();
			expect(classifyStatic("curl https://example.com")).toBeNull();
		});
	});
});

// ---- parseClassifyResponse ----------------------------------------------

describe("parseClassifyResponse", () => {
	it("parses a clean allow response", () => {
		const r = parseClassifyResponse(
			'{"verdict":"allow","reason":"read-only git history","tool":null}',
		);
		expect(r.verdict).toBe("allow");
		expect(r.reason).toBe("read-only git history");
		expect(r.tool).toBeUndefined();
	});

	it("parses a redirect response with a tool", () => {
		const r = parseClassifyResponse(
			'{"verdict":"redirect","reason":"reads a file — use the read tool","tool":"read"}',
		);
		expect(r.verdict).toBe("redirect");
		expect(r.tool).toBe("read");
	});

	it("ignores tool on a non-redirect verdict", () => {
		const r = parseClassifyResponse(
			'{"verdict":"allow","reason":"safe","tool":"grep"}',
		);
		expect(r.verdict).toBe("allow");
		expect(r.tool).toBeUndefined();
	});

	it("parses a block response", () => {
		const r = parseClassifyResponse(
			'{"verdict":"block","reason":"installs packages","tool":null}',
		);
		expect(r.verdict).toBe("block");
		expect(r.reason).toBe("installs packages");
	});

	it("strips markdown code fences", () => {
		const r = parseClassifyResponse(
			'```json\n{"verdict":"allow","reason":"safe","tool":null}\n```',
		);
		expect(r.verdict).toBe("allow");
	});

	it("strips plain code fences", () => {
		const r = parseClassifyResponse(
			'```\n{"verdict":"block","reason":"writes a file","tool":null}\n```',
		);
		expect(r.verdict).toBe("block");
	});

	it("blocks on invalid verdict value", () => {
		const r = parseClassifyResponse(
			'{"verdict":"maybe","reason":"unclear","tool":null}',
		);
		expect(r.verdict).toBe("block");
	});

	it("blocks on unparseable JSON", () => {
		expect(parseClassifyResponse("not json at all").verdict).toBe("block");
		expect(parseClassifyResponse("").verdict).toBe("block");
		expect(parseClassifyResponse("{}").verdict).toBe("block");
	});

	it("ignores unknown tool values on redirect", () => {
		const r = parseClassifyResponse(
			'{"verdict":"redirect","reason":"use something","tool":"vim"}',
		);
		expect(r.verdict).toBe("redirect");
		expect(r.tool).toBeUndefined();
	});

	it("accepts all valid redirect tools", () => {
		for (const tool of ["read", "grep", "find", "ls"] as const) {
			const r = parseClassifyResponse(
				`{"verdict":"redirect","reason":"use it","tool":"${tool}"}`,
			);
			expect(r.tool).toBe(tool);
		}
	});
});
