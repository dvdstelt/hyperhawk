/**
 * Snapshot test for HyperHawk's internal link checking.
 *
 * Runs extract + check against docs/test-document.md and writes
 * a stable sorted output. CI compares this against expected-output.txt.
 *
 * Only tests internal links (no external HTTP, no same-org API calls)
 * so the output is fully deterministic.
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
    owner: '',
    repo: '',
    strict: false,
    checkExternal: false,
    checkSameOrg: false,
    ignorePatterns: [],
    timeout: 5000,
    filePatterns: ['docs/test-document.md'],
    concurrency: 1,
  };

  const links = extractLinks(testFile, config);
  const internal = links.filter(l => l.type === 'internal');

  // checkLinks needs an octokit but we skip external/same-org, so pass null
  const results = await checkLinks(internal, config, null as any);

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
