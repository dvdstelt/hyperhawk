/**
 * Snapshot test for HyperHawk's link checking.
 *
 * Runs extract + check against tests/test-document.md and writes
 * a stable sorted output. CI compares this against expected-output.txt.
 *
 * Tests internal links and same-org self-repo links (which resolve
 * locally without API calls). External HTTP checks are disabled.
 */

import * as path from 'path';
import { extractLinks, filterIgnored } from '../src/extract';
import { checkLinks } from '../src/check';
import { Config, CheckResult } from '../src/types';
import { mergeResultsForLine } from '../src/report';

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, '..');
  const testFile = path.join(repoRoot, 'tests', 'test-document.md');

  const config: Config = {
    token: '',
    repoRoot,
    owner: 'dvdstelt',
    repo: 'hyperhawk',
    strict: false,
    checkExternal: false,
    checkSameOrg: true,
    ignorePatterns: [],
    timeout: 5000,
    filePatterns: ['tests/test-document.md'],
    concurrency: 1,
  };

  const links = extractLinks(testFile, config);
  const testable = links.filter(l => l.type === 'internal' || l.type === 'same-org');

  // checkLinks needs an octokit but self-repo same-org links resolve locally
  // and external checks are disabled, so no API calls are made.
  const results = await checkLinks(testable, config, null as any);

  const lines = results
    .map(r => {
      const rel = path.relative(repoRoot, r.link.filePath).replace(/\\/g, '/');
      const status = r.ok ? (r.suggestionOnly ? 'suggestion' : 'ok') : 'broken';
      let detail = '';
      if (!r.ok && r.correctedUrl) {
        detail = r.isFuzzyMatch ? ` -> ${r.correctedUrl} (fuzzy)` : ` -> ${r.correctedUrl}`;
      } else if (r.suggestionOnly && r.correctedUrl) {
        detail = ` -> ${r.correctedUrl}`;
      } else if (!r.ok) {
        const err = (r.error ?? 'unknown').replaceAll(repoRoot, '<root>').replaceAll(path.dirname(repoRoot), '<parent>');
        detail = ` | ${err}`;
      }
      return `${rel}:${r.link.line} | ${r.link.url} | ${status}${detail}`;
    })
    .sort();

  process.stdout.write(lines.join('\n') + '\n');

  // --- Merge test: group results by line and output merged suggestions ---
  const grouped = new Map<string, CheckResult[]>();
  for (const r of results) {
    const key = `${r.link.filePath}:${r.link.line}`;
    let group = grouped.get(key);
    if (!group) {
      group = [];
      grouped.set(key, group);
    }
    group.push(r);
  }

  const mergeLines: string[] = [];
  for (const [key, group] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (group.length < 2) continue;
    const { body } = mergeResultsForLine(group);
    // Extract just the suggestion block if present
    const suggestionMatch = /```suggestion\n(.*)\n```/s.exec(body);
    const suggestion = suggestionMatch ? suggestionMatch[1] : '(no suggestion)';
    const urls = group.map(r => r.link.url).join(' + ');
    const rel = path.relative(repoRoot, group[0].link.filePath).replace(/\\/g, '/');
    mergeLines.push(`merge:${rel}:${group[0].link.line} | ${urls} | ${suggestion}`);
  }

  if (mergeLines.length > 0) {
    process.stdout.write(mergeLines.join('\n') + '\n');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
