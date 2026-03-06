import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { CheckResult } from './types';

type Octokit = ReturnType<typeof getOctokit>;

// Maps file path -> set of line numbers visible in the PR diff (right/new side)
type DiffLineMap = Map<string, Set<number>>;

/**
 * Parse the patch string returned by listFiles() and return the set of
 * line numbers (on the new/right side) that are visible in the diff.
 * Only lines prefixed with '+' (added) or ' ' (context) are commentable.
 */
function parseDiffLines(patch: string | undefined): Set<number> {
  const visible = new Set<number>();
  if (!patch) return visible;

  const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  let currentLine = 0;

  for (const line of patch.split('\n')) {
    const match = hunkHeader.exec(line);
    if (match) {
      currentLine = parseInt(match[1], 10);
      continue;
    }
    if (line.startsWith('+') || line.startsWith(' ')) {
      visible.add(currentLine++);
    }
  }

  return visible;
}

/**
 * Hidden marker appended to every comment body.
 * Keyed only on URL - no commit SHA. This means:
 * - Same broken link, line unchanged between commits: existing comment stays
 *   active (position !== null) and we skip re-posting. The existing comment
 *   is still visible and relevant.
 * - Same broken link, line changed by a new commit: GitHub marks the comment
 *   outdated (position === null), so we treat it as gone and post fresh.
 * - Re-running the workflow on the same commit: existing active comment found,
 *   skipped - no duplicate.
 */
function makeMarker(url: string): string {
  return `\n<!-- hyperhawk url="${url}" -->`;
}

function parseMarker(body: string | null | undefined): { url: string } | null {
  if (!body) return null;
  const m = /<!-- hyperhawk url="([^"]+)" -->/.exec(body);
  return m ? { url: m[1] } : null;
}

function formatBrokenComment(result: CheckResult): string {
  const { link, error, suggestion } = result;
  const lines: string[] = [
    `**HyperHawk** found a broken link: \`${link.url}\``,
  ];
  if (error) lines.push(`**Error:** ${error}`);

  if (suggestion) {
    lines.push('', '**Suggested fix:**', '```suggestion', suggestion, '```');
  } else {
    lines.push('', 'Please verify and update this link manually.');
  }
  return lines.join('\n');
}

function formatImprovementComment(result: CheckResult): string {
  const { link, suggestion } = result;
  return [
    `**HyperHawk** suggests converting this relative link to a root-relative path so it stays valid if this file is moved.`,
    `Current: \`${link.url}\``,
    '',
    '```suggestion',
    suggestion!,
    '```',
  ].join('\n');
}

/**
 * Report in a PR context.
 * Inline comments are only posted for lines visible in the diff.
 * Duplicate comments (same url + sha, still active) are skipped.
 * Outdated comments (position === null after a new push) are ignored so
 * a fresh comment is posted for the new commit.
 */
async function reportPR(
  results: CheckResult[],
  octokit: Octokit,
  diffLines: DiffLineMap,
  commitSha: string
): Promise<void> {
  const broken = results.filter(r => !r.ok);
  const improvements = results.filter(r => r.ok && r.suggestionOnly && r.suggestion);

  if (broken.length === 0 && improvements.length === 0) return;

  const pr = context.payload.pull_request!;
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const pullNumber = pr.number as number;

  const isCommentable = (filePath: string, line: number): boolean =>
    diffLines.has(filePath) && (diffLines.get(filePath)?.has(line) ?? false);

  // --- Deduplicate inline review comments ---

  // Build a set of URLs that already have an active (non-outdated) comment
  // for this exact commit. position===null means the comment is outdated
  // (the line moved out of the diff after a new push) - those don't count.
  const alreadyCommented = new Set<string>();
  try {
    const existing = await octokit.rest.pulls.listReviewComments({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
    for (const comment of existing.data) {
      if (comment.position === null) continue; // outdated, treat as gone
      const marker = parseMarker(comment.body);
      if (marker) {
        alreadyCommented.add(marker.url);
      }
    }
  } catch (err) {
    core.warning(`Could not fetch existing review comments for deduplication: ${String(err)}`);
  }

  type ReviewComment = { path: string; line: number; side: 'RIGHT'; body: string };
  const reviewComments: ReviewComment[] = [];
  const notInDiff: CheckResult[] = [];

  for (const result of broken) {
    if (!isCommentable(result.link.filePath, result.link.line)) {
      notInDiff.push(result);
      continue;
    }
    if (alreadyCommented.has(result.link.url)) continue;
    reviewComments.push({
      path: result.link.filePath,
      line: result.link.line,
      side: 'RIGHT',
      body: formatBrokenComment(result) + makeMarker(result.link.url),
    });
  }

  for (const result of improvements) {
    if (!isCommentable(result.link.filePath, result.link.line)) continue;
    if (alreadyCommented.has(result.link.url)) continue;
    reviewComments.push({
      path: result.link.filePath,
      line: result.link.line,
      side: 'RIGHT',
      body: formatImprovementComment(result) + makeMarker(result.link.url),
    });
  }

  if (reviewComments.length > 0) {
    try {
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        commit_id: commitSha,
        event: 'COMMENT',
        comments: reviewComments,
      });
      core.info(`Posted review with ${reviewComments.length} inline comment(s)`);
    } catch (err) {
      core.warning(`Failed to post inline review comments: ${String(err)}`);
      notInDiff.push(...broken.filter(r => isCommentable(r.link.filePath, r.link.line)));
    }
  }

  // Broken links outside the visible diff: emit check annotations.
  // GitHub expands the Files Changed view to show annotated lines even
  // when they are not part of the diff hunks.
  for (const result of notInDiff) {
    core.warning(
      `Broken ${result.link.type} link: ${result.link.url} — ${result.error ?? 'broken'}`,
      {
        file: result.link.filePath,
        startLine: result.link.line,
        title: 'Broken Link',
      }
    );
  }
}

/**
 * Report via step summary and warning/notice annotations (non-PR context).
 */
function reportSummary(results: CheckResult[]): void {
  const broken = results.filter(r => !r.ok);
  const improvements = results.filter(r => r.ok && r.suggestionOnly);
  const total = results.length;

  const summary: string[] = [
    '## HyperHawk Link Check Results',
    '',
    `- **Total links checked:** ${total}`,
    `- **Broken links found:** ${broken.length}`,
    `- **Root-relative suggestions:** ${improvements.length}`,
    '',
  ];

  if (broken.length > 0) {
    const rows = broken
      .map(r => `| \`${r.link.filePath}\` | ${r.link.line} | ${r.link.type} | \`${r.link.url}\` | ${r.error ?? 'broken'} |`)
      .join('\n');
    summary.push(
      '### Broken Links',
      '',
      '| File | Line | Type | URL | Error |',
      '|------|------|------|-----|-------|',
      rows,
      ''
    );
  }

  if (improvements.length > 0) {
    const rows = improvements
      .map(r => `| \`${r.link.filePath}\` | ${r.link.line} | \`${r.link.url}\` |`)
      .join('\n');
    summary.push(
      '### Root-Relative Suggestions',
      '',
      'These links work today but will break if the file containing them is moved.',
      'Converting them to root-relative paths (/folder/file.md) makes them location-independent.',
      '',
      '| File | Line | Current URL |',
      '|------|------|-------------|',
      rows,
      ''
    );
  }

  if (broken.length === 0 && improvements.length === 0) {
    summary.push('All links are valid and root-relative!');
  }

  core.summary.addRaw(summary.join('\n')).write().catch(err => {
    core.warning(`Failed to write step summary: ${String(err)}`);
  });

  for (const result of broken) {
    core.warning(`Broken ${result.link.type} link: ${result.link.url} (${result.error ?? 'broken'})`, {
      file: result.link.filePath,
      startLine: result.link.line,
      title: 'Broken Link',
    });
  }

  for (const result of improvements) {
    core.notice(`Relative link should be root-relative: ${result.link.url}`, {
      file: result.link.filePath,
      startLine: result.link.line,
      title: 'Use Root-Relative Link',
    });
  }
}

/**
 * Report all check results. Returns the number of broken links.
 */
export async function report(results: CheckResult[], octokit: Octokit): Promise<number> {
  const broken = results.filter(r => !r.ok);

  if (context.payload.pull_request) {
    const pr = context.payload.pull_request;
    const owner = context.repo.owner;
    const repo = context.repo.repo;
    const pullNumber = pr.number as number;
    const commitSha = (pr.head as { sha: string }).sha;

    let diffLines: DiffLineMap = new Map();
    try {
      const filesResponse = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
      });
      for (const file of filesResponse.data) {
        if (file.status !== 'removed') {
          diffLines.set(file.filename, parseDiffLines(file.patch));
        }
      }
    } catch (err) {
      core.warning(`Failed to fetch PR file list: ${String(err)}`);
    }

    await reportPR(results, octokit, diffLines, commitSha);
  } else {
    reportSummary(results);
  }

  core.info(`Link check complete: ${results.length} checked, ${broken.length} broken`);
  return broken.length;
}
