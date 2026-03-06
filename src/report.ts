import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { CheckResult } from './types';

type Octokit = ReturnType<typeof getOctokit>;

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
 * Report in a PR context: inline review comments for files in the diff,
 * summary comment for broken links in unchanged files.
 * Improvement suggestions are only posted for files in the diff.
 */
async function reportPR(
  results: CheckResult[],
  octokit: Octokit,
  changedFiles: Set<string>
): Promise<void> {
  const broken = results.filter(r => !r.ok);
  const improvements = results.filter(r => r.ok && r.suggestionOnly && r.suggestion);

  if (broken.length === 0 && improvements.length === 0) return;

  const pr = context.payload.pull_request!;
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const pullNumber = pr.number as number;
  const commitSha = (pr.head as { sha: string }).sha;

  type ReviewComment = { path: string; line: number; side: 'RIGHT'; body: string };
  const reviewComments: ReviewComment[] = [];
  const notInDiff: CheckResult[] = [];

  // Broken links in changed files -> inline comments
  for (const result of broken) {
    if (changedFiles.has(result.link.filePath)) {
      reviewComments.push({
        path: result.link.filePath,
        line: result.link.line,
        side: 'RIGHT',
        body: formatBrokenComment(result),
      });
    } else {
      notInDiff.push(result);
    }
  }

  // Improvement suggestions only for changed files
  for (const result of improvements) {
    if (changedFiles.has(result.link.filePath)) {
      reviewComments.push({
        path: result.link.filePath,
        line: result.link.line,
        side: 'RIGHT',
        body: formatImprovementComment(result),
      });
    }
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
      notInDiff.push(...broken.filter(r => changedFiles.has(r.link.filePath)));
    }
  }

  // Summary comment for broken links in files not in the diff
  if (notInDiff.length > 0) {
    const rows = notInDiff
      .map(r => `| \`${r.link.filePath}\` | ${r.link.line} | \`${r.link.url}\` | ${r.error ?? 'broken'} |`)
      .join('\n');

    const body = [
      '## HyperHawk: Broken Links in Unchanged Files',
      '',
      'The following broken links were found in files not modified by this PR:',
      '',
      '| File | Line | URL | Error |',
      '|------|------|-----|-------|',
      rows,
      '',
      'These links need to be fixed separately.',
    ].join('\n');

    try {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: pullNumber, body });
    } catch (err) {
      core.warning(`Failed to post summary comment: ${String(err)}`);
    }
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

    let changedFiles = new Set<string>();
    try {
      const filesResponse = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
      });
      changedFiles = new Set(filesResponse.data.map((f: { filename: string }) => f.filename));
    } catch (err) {
      core.warning(`Failed to fetch PR file list: ${String(err)}`);
    }

    await reportPR(results, octokit, changedFiles);
  } else {
    reportSummary(results);
  }

  core.info(`Link check complete: ${results.length} checked, ${broken.length} broken`);
  return broken.length;
}
