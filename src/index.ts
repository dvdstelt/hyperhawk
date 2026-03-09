import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import * as glob from '@actions/glob';
import minimatch from 'minimatch';
import * as path from 'path';
import { Config } from './types';
import { extractLinks, filterIgnored } from './extract';
import { checkLinks } from './check';
import { report } from './report';

async function getChangedMdFiles(octokit: ReturnType<typeof getOctokit>): Promise<string[]> {
  const pr = context.payload.pull_request!;
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const pullNumber = pr.number as number;

  const filesResponse = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  return filesResponse.data
    .filter((f: { status: string; filename: string }) => f.status !== 'removed')
    .filter((f: { filename: string }) => /\.(md|mdx)$/i.test(f.filename))
    .map((f: { filename: string }) => f.filename);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../package.json') as { version: string };

async function run(): Promise<void> {
  try {
    core.info(`HyperHawk v${version}`);
    // Load config
    const token = core.getInput('token', { required: true });
    const filesInput = core.getInput('files') || '**/*.md,**/*.mdx';
    const checkExternal = core.getInput('check-external') !== 'false';
    const checkSameOrg = core.getInput('check-same-org') !== 'false';
    const ignorePatternsInput = core.getInput('ignore-patterns');
    const timeout = parseInt(core.getInput('timeout') || '10000', 10);
    const concurrency = parseInt(core.getInput('concurrency') || '5', 10);
    // strict: check both input and LINK_CHECK_STRICT env var
    const strictInput = core.getInput('strict');
    const strictEnv = process.env['LINK_CHECK_STRICT'];
    const strict = strictInput === 'true' || strictEnv === 'true';

    const repoRoot = process.env['GITHUB_WORKSPACE'] || process.cwd();
    const [owner, repo] = (process.env['GITHUB_REPOSITORY'] || '/').split('/');

    const ignorePatterns: RegExp[] = ignorePatternsInput
      ? ignorePatternsInput.split(',').map(p => new RegExp(p.trim()))
      : [];

    const filePatterns = filesInput.split(',').map(p => p.trim());

    const config: Config = {
      token,
      repoRoot,
      owner,
      repo,
      strict,
      checkExternal,
      checkSameOrg,
      ignorePatterns,
      timeout,
      filePatterns,
      concurrency,
    };

    const octokit = getOctokit(token);
    const crossRepoTokenInput = core.getInput('cross-repo-token');
    const crossRepoOctokit = crossRepoTokenInput ? getOctokit(crossRepoTokenInput) : undefined;

    // Determine files to scan
    let filesToScan: string[];

    if (context.payload.pull_request) {
      core.info('PR context detected - scanning only changed .md/.mdx files');
      try {
        let changedFiles = await getChangedMdFiles(octokit);
        // Apply include/exclude file patterns so exclusions like !docs/test.md work on PRs too
        changedFiles = changedFiles.filter(f => {
          const included = filePatterns.filter(p => !p.startsWith('!')).some(p => minimatch(f, p));
          const excluded = filePatterns.filter(p => p.startsWith('!')).some(p => minimatch(f, p.slice(1)));
          return included && !excluded;
        });
        filesToScan = changedFiles.map(f => path.join(repoRoot, f));
        core.info(`Changed markdown files: ${filesToScan.length}`);
      } catch (err) {
        core.warning(`Failed to get changed files, falling back to full scan: ${String(err)}`);
        filesToScan = await globFiles(filePatterns, repoRoot);
      }
    } else {
      core.info('Non-PR context - scanning all markdown files');
      filesToScan = await globFiles(filePatterns, repoRoot);
    }

    core.info(`Scanning ${filesToScan.length} file(s)`);

    if (filesToScan.length === 0) {
      core.info('No files to scan');
      return;
    }

    // Extract links from all files
    const allLinks = filesToScan.flatMap(file => {
      try {
        return extractLinks(file, config);
      } catch (err) {
        core.warning(`Failed to extract links from ${file}: ${String(err)}`);
        return [];
      }
    });

    core.info(`Extracted ${allLinks.length} link(s)`);

    // Filter ignored patterns
    const filteredLinks = filterIgnored(allLinks, ignorePatterns);
    const ignored = allLinks.length - filteredLinks.length;
    if (ignored > 0) {
      core.info(`Ignored ${ignored} link(s) matching ignore patterns`);
    }

    core.info(`Checking ${filteredLinks.length} link(s)...`);

    // Check all links
    const results = await checkLinks(filteredLinks, config, octokit, crossRepoOctokit);

    // Report results
    const brokenCount = await report(results, octokit);

    // Fail workflow if strict mode
    if (strict && brokenCount > 0) {
      core.setFailed(`HyperHawk found ${brokenCount} broken link(s). Set strict=false to allow failures.`);
    }
  } catch (err) {
    core.setFailed(`HyperHawk encountered an unexpected error: ${String(err)}`);
  }
}

async function globFiles(patterns: string[], repoRoot: string): Promise<string[]> {
  const excludePatterns = [
    '!**/node_modules/**',
    '!**/.git/**',
    '!**/dist/**',
    '!**/lib/**',
  ];

  const globPatterns = [
    ...patterns.map(p => path.join(repoRoot, p)),
    ...excludePatterns,
  ];

  const globber = await glob.create(globPatterns.join('\n'));
  return globber.glob();
}

run();
