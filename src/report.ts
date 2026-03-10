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
 * Keyed only on URL - no commit SHA. Once a comment exists for a URL
 * (active, outdated, or resolved) it is never re-posted.
 */
function makeMarker(url: string): string {
  return `<!-- hyperhawk url="${url}" -->`;
}

function parseMarkers(body: string | null | undefined): string[] {
  if (!body) return [];
  const urls: string[] = [];
  const re = /<!-- hyperhawk url="([^"]+)" -->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    urls.push(m[1]);
  }
  return urls;
}

function formatBrokenComment(result: CheckResult): string {
  const { link, correctedUrl, isFuzzyMatch, statusCode } = result;
  const lines: string[] = [];

  if (link.type === 'internal') {
    if (correctedUrl) {
      const qualifier = isFuzzyMatch ? ' as a close match' : ' elsewhere in the repository';
      lines.push(
        `The link points to \`${link.url}\`, but this file does not exist.`,
        `\`${correctedUrl}\` was found${qualifier} — did you mean to link there?`
      );
    } else {
      lines.push(
        `The link points to \`${link.url}\`, but this file could not be found in the repository.`,
        'Update the path or remove the link if it is no longer needed.'
      );
    }
  } else if (link.type === 'same-org') {
    const status = statusCode ? ` (HTTP ${statusCode})` : '';
    lines.push(
      `The link to \`${link.url}\` could not be resolved${status}.`,
      'Verify the repository name, branch, and file path are correct.'
    );
  } else {
    const status = statusCode ? `HTTP ${statusCode}` : 'an error';
    lines.push(
      `The external link returns ${status}. Verify the URL is still valid or remove the link.`,
      `URL: \`${link.url}\``
    );
  }

  return lines.join('\n');
}

function formatImprovementComment(result: CheckResult): string {
  const { link, correctedUrl } = result;
  if (link.type === 'external' && correctedUrl) {
    return [
      `This link redirects to \`${correctedUrl}\`. Consider updating it to point directly to the final destination.`,
      `Current: \`${link.url}\``,
    ].join('\n');
  }
  return [
    `**HyperHawk** suggests converting this relative link to a root-relative path so it stays valid if this file is moved.`,
    `Current: \`${link.url}\``,
  ].join('\n');
}

/**
 * Merge multiple results on the same line into one review comment.
 * Produces a single suggestion block that applies all fixes at once.
 */
export function mergeResultsForLine(group: CheckResult[]): { body: string; markers: string[] } {
  const bodyParts: string[] = [];
  const markers: string[] = [];

  // Build a merged suggestion line by applying all URL replacements
  // Start from the original lineContent (same for all results on this line)
  let mergedLine: string | null = group[0].link.lineContent.trimEnd();
  let hasSuggestion = false;

  for (const result of group) {
    markers.push(makeMarker(result.link.url));

    if (!result.ok) {
      bodyParts.push(formatBrokenComment(result));
    } else if (result.suggestionOnly) {
      bodyParts.push(formatImprovementComment(result));
    }

    if (result.correctedUrl) {
      mergedLine = mergedLine!.replace(result.link.url, result.correctedUrl);
      hasSuggestion = true;
    } else if (result.suggestion) {
      // suggestion has the full replaced line; extract what the URL was replaced with
      const replacedUrl = extractReplacedUrl(result.link.lineContent, result.suggestion, result.link.url);
      if (replacedUrl !== null) {
        mergedLine = mergedLine!.replace(result.link.url, replacedUrl);
        hasSuggestion = true;
      }
    }
  }

  const parts = [bodyParts.join('\n\n')];
  if (hasSuggestion && mergedLine !== null) {
    parts.push('', '```suggestion', mergedLine, '```');
  }

  return { body: parts.join('\n'), markers };
}

/**
 * Given the original line, a suggestion line, and the original URL,
 * figure out what the URL was replaced with in the suggestion.
 */
function extractReplacedUrl(originalLine: string, suggestionLine: string, originalUrl: string): string | null {
  const idx = originalLine.indexOf(originalUrl);
  if (idx < 0) return null;

  const before = originalLine.slice(0, idx);
  const after = originalLine.slice(idx + originalUrl.length);

  // The suggestion should have the same prefix and suffix
  if (!suggestionLine.startsWith(before)) return null;
  const afterIdx = after.length > 0 ? suggestionLine.lastIndexOf(after) : suggestionLine.length;
  if (afterIdx < 0) return null;

  return suggestionLine.slice(before.length, afterIdx);
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

  // Build a set of URLs that already have a comment, regardless of whether
  // it is active, outdated, or resolved. Once commented, never re-comment.
  const alreadyCommented = new Set<string>();
  try {
    const existing = await octokit.rest.pulls.listReviewComments({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
    for (const comment of existing.data) {
      for (const url of parseMarkers(comment.body)) {
        alreadyCommented.add(url);
      }
    }
  } catch (err) {
    core.warning(`Could not fetch existing review comments for deduplication: ${String(err)}`);
  }

  type ReviewComment = { path: string; line: number; side: 'RIGHT'; body: string };
  const reviewComments: ReviewComment[] = [];
  const notInDiff: CheckResult[] = [];

  // Collect commentable results, filtering out already-commented and out-of-diff
  const commentable: CheckResult[] = [];
  for (const result of [...broken, ...improvements]) {
    if (!isCommentable(result.link.filePath, result.link.line)) {
      if (!result.ok) notInDiff.push(result);
      continue;
    }
    if (alreadyCommented.has(result.link.url)) continue;
    commentable.push(result);
  }

  // Group by file:line so multiple results on the same line get one comment
  const grouped = new Map<string, CheckResult[]>();
  for (const result of commentable) {
    const key = `${result.link.filePath}:${result.link.line}`;
    let group = grouped.get(key);
    if (!group) {
      group = [];
      grouped.set(key, group);
    }
    group.push(result);
  }

  for (const group of grouped.values()) {
    const first = group[0];
    const { body, markers } = mergeResultsForLine(group);
    reviewComments.push({
      path: first.link.filePath,
      line: first.link.line,
      side: 'RIGHT',
      body: body + '\n' + markers.join('\n'),
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
    const hint = result.correctedUrl
      ? ` Did you mean \`${result.correctedUrl}\`${result.isFuzzyMatch ? ' (fuzzy match)' : ''}?`
      : '';
    core.warning(
      `Broken ${result.link.type} link: \`${result.link.url}\`${hint}`,
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
  const allImprovements = results.filter(r => r.ok && r.suggestionOnly);
  const redirectSuggestions = allImprovements.filter(r => r.link.type === 'external');
  const rootRelativeSuggestions = allImprovements.filter(r => r.link.type !== 'external');
  const total = results.length;

  const summary: string[] = [
    '## HyperHawk Link Check Results',
    '',
    `- **Total links checked:** ${total}`,
    `- **Broken links found:** ${broken.length}`,
    `- **Redirect suggestions:** ${redirectSuggestions.length}`,
    `- **Root-relative suggestions:** ${rootRelativeSuggestions.length}`,
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

  if (redirectSuggestions.length > 0) {
    const rows = redirectSuggestions
      .map(r => `| \`${r.link.filePath}\` | ${r.link.line} | \`${r.link.url}\` | \`${r.correctedUrl}\` |`)
      .join('\n');
    summary.push(
      '### Redirect Suggestions',
      '',
      'These links are redirected to a different URL. Consider updating them to point directly to the final destination.',
      '',
      '| File | Line | Current URL | Redirects To |',
      '|------|------|-------------|--------------|',
      rows,
      ''
    );
  }

  if (rootRelativeSuggestions.length > 0) {
    const rows = rootRelativeSuggestions
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

  if (broken.length === 0 && allImprovements.length === 0) {
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

  for (const result of redirectSuggestions) {
    core.notice(`Redirected link: ${result.link.url} -> ${result.correctedUrl}`, {
      file: result.link.filePath,
      startLine: result.link.line,
      title: 'Update Redirected Link',
    });
  }

  for (const result of rootRelativeSuggestions) {
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
