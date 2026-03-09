/**
 * Snapshot test for HyperHawk's link checking.
 *
 * Runs extract + check against docs/test-document.md and writes
 * a stable sorted output. CI compares this against expected-output.txt.
 *
 * Tests internal links and same-org self-repo links (which resolve
 * locally without API calls). External HTTP checks are disabled.
 */

import * as path from 'path';
import { extractLinks, filterIgnored } from '../src/extract';
import { checkLinks } from '../src/check';
import { Config, CheckResult } from '../src/types';

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, '..');
  const testFile = path.join(repoRoot, 'docs', 'test-document.md');

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
    filePatterns: ['docs/test-document.md'],
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
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
