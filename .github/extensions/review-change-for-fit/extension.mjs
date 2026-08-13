// Extension: review-change-for-fit
// Gathers diff and repo-standards context so Copilot can assess whether a change fits architecture, hosting, cost, typing, and security standards before it's accepted.

import { joinSession } from "@github/copilot-sdk/extension";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const MAX_DIFF_CHARS = 20000;

function run(args, cwd) {
    try {
        return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }).trim();
    } catch (err) {
        return `(git ${args.join(" ")} failed: ${err.message})`;
    }
}

function findRepoRoot() {
    const top = run(["rev-parse", "--show-toplevel"], process.cwd());
    return top && !top.startsWith("(git ") ? top : process.cwd();
}

function readIfExists(repoRoot, relPath) {
    const full = path.join(repoRoot, relPath);
    if (!existsSync(full)) return null;
    try {
        return readFileSync(full, "utf8");
    } catch {
        return null;
    }
}

function truncate(text, max) {
    if (!text) return text;
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n\n...[truncated, ${text.length - max} more chars]`;
}

function resolveDiffRange(scope, base) {
    // Returns git diff args (excluding the leading "diff") for the requested scope.
    switch (scope) {
        case "staged":
            return ["--cached"];
        case "unstaged":
            return [];
        case "branch":
            return [`${base || "main"}...HEAD`];
        case "all":
        default:
            return [base ? `${base}...HEAD` : "HEAD"];
    }
}

function detectSignals(diffText, changedFiles) {
    const signals = [];

    const depFiles = changedFiles.filter((f) =>
        /(^|\/)(package\.json|package-lock\.json|requirements\.txt|go\.mod|pyproject\.toml|Pipfile)$/.test(f)
    );
    if (depFiles.length) {
        signals.push(`Dependency manifests touched: ${depFiles.join(", ")} — check for new/unpinned packages and their cost/maintenance burden.`);
    }

    const infraFiles = changedFiles.filter((f) =>
        /(^|\/)(Dockerfile|docker-compose\.ya?ml|azure\.ya?ml|.*\.bicep|.*\.tf|.*\.yml|.*\.yaml|Procfile)$/i.test(f)
    );
    if (infraFiles.length) {
        signals.push(`Deployment/hosting files touched: ${infraFiles.join(", ")} — verify this still matches the documented deployment runbook and hosting assumptions.`);
    }

    const envFiles = changedFiles.filter((f) => /(^|\/)\.env|secrets?\.|\.pem$|\.key$/i.test(f));
    if (envFiles.length) {
        signals.push(`Potential secret-bearing files touched: ${envFiles.join(", ")} — confirm nothing sensitive is committed and secrets remain in Key Vault/secretref, not plain env vars.`);
    }

    if (/\bany\b/.test(diffText)) {
        signals.push(`Diff contains the word "any" — check whether this weakens TypeScript typing (explicit \`any\`, \`as any\`, or loosened interfaces).`);
    }
    if (/(api[_-]?key|secret|password|token)\s*[:=]\s*["'`][^"'`]+["'`]/i.test(diffText)) {
        signals.push(`Diff appears to contain a hardcoded credential-like literal — verify no secret is being committed in plaintext.`);
    }
    if (/migrations?\//i.test(diffText) || changedFiles.some((f) => /migrations?\//i.test(f))) {
        signals.push(`Migration files touched — confirm this follows the documented migration process, not an ad-hoc schema change.`);
    }

    return signals;
}

const session = await joinSession({
    tools: [
        {
            name: "review_change_for_fit",
            description:
                "Reviews a proposed or in-progress code change (staged, unstaged, or against a base branch) for architectural, hosting, dependency/cost, typing, and security fit against this repo's documented standards (.github/copilot-instructions.md and .github/instructions/*.instructions.md). " +
                "Gathers the diff, changed-file list, dependency/infra/secret signals, and relevant scoped instructions, and returns them for analysis. " +
                "Use this before accepting a vibe-coded or AI-generated change, to catch changes that are plausible-looking but violate repo conventions. " +
                "After calling this tool, produce a report answering: (1) does it fit the existing architecture, (2) does it preserve deployment/hosting assumptions, " +
                "(3) does it introduce unnecessary dependencies or cost, (4) does it weaken typing or data contracts, (5) does it create security/secret-handling risk, " +
                "(6) what is the smallest safer version of the same change.",
            parameters: {
                type: "object",
                properties: {
                    scope: {
                        type: "string",
                        enum: ["staged", "unstaged", "branch", "all"],
                        description:
                            "Which changes to review: 'staged' (git add'd changes), 'unstaged' (working tree vs index), 'branch' (this branch vs base), 'all' (everything vs base, default).",
                    },
                    base: {
                        type: "string",
                        description: "Base branch or ref to diff against for 'branch'/'all' scope. Defaults to 'main'.",
                    },
                },
            },
            handler: async (args) => {
                const scope = args?.scope || "all";
                const base = args?.base;
                const repoRoot = findRepoRoot();

                const diffRangeArgs = resolveDiffRange(scope, base);
                const nameStatus = run(["diff", "--name-status", ...diffRangeArgs], repoRoot);
                const stat = run(["diff", "--stat", ...diffRangeArgs], repoRoot);
                const fullDiff = truncate(run(["diff", ...diffRangeArgs], repoRoot), MAX_DIFF_CHARS);

                const changedFiles = nameStatus
                    .split("\n")
                    .map((line) => line.split("\t").pop())
                    .filter(Boolean);

                const signals = detectSignals(fullDiff, changedFiles);

                const rootInstructions = readIfExists(repoRoot, ".github/copilot-instructions.md");
                const scopedDir = path.join(repoRoot, ".github", "instructions");
                let scopedInstructionsSummary = "(none found)";
                if (existsSync(scopedDir)) {
                    scopedInstructionsSummary = "Scoped instruction files exist at .github/instructions/*.instructions.md — check applyTo globs against the changed files above and read any that match.";
                }

                const report = [
                    `# Change-for-fit review context (scope: ${scope}${base ? `, base: ${base}` : ""})`,
                    "",
                    "## Changed files",
                    "```",
                    nameStatus || "(no changes detected for this scope)",
                    "```",
                    "",
                    "## Diff stat",
                    "```",
                    stat || "(none)",
                    "```",
                    "",
                    "## Automated signals",
                    signals.length ? signals.map((s) => `- ${s}`).join("\n") : "- No automated signals detected — still review manually against the six questions below.",
                    "",
                    "## Repo standards to weigh this against",
                    rootInstructions
                        ? "Root .github/copilot-instructions.md is present (loaded separately by the agent as repo instructions)."
                        : "No .github/copilot-instructions.md found in this repo.",
                    scopedInstructionsSummary,
                    "",
                    "## Full diff",
                    "```diff",
                    fullDiff || "(no diff content)",
                    "```",
                    "",
                    "## Required output format",
                    "Using the above, answer these six questions directly and concisely:",
                    "1. Does it fit the existing architecture?",
                    "2. Does it preserve deployment and hosting assumptions?",
                    "3. Does it introduce unnecessary dependencies or cost?",
                    "4. Does it weaken typing or data contracts?",
                    "5. Does it create security or secret-handling risk?",
                    "6. What is the smallest safer version of the same change?",
                ].join("\n");

                return report;
            },
        },
    ],
});
