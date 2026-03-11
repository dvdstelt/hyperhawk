/**
 * Snapshot test for HyperHawk's link checking.
 *
 * Runs extract + check against tests/test-document.md and writes
 * a stable sorted output. CI compares this against expected-output.txt.
 *
 * Tests internal links, same-org self-repo links (which resolve
 * locally without API calls), and external redirect detection via
 * a local HTTP test server.
 */

import * as http from 'http';
import * as path from 'path';
import { extractLinks, filterIgnored } from '../src/extract';
import { checkLinks } from '../src/check';
import { Config, CheckResult, LinkInfo } from '../src/types';
import { mergeResultsForLine } from '../src/report';

/**
 * Start a local HTTP server that serves various redirect scenarios.
 * Returns the base URL (e.g. http://127.0.0.1:12345) and a close function.
 */
function startRedirectServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? '/';

      // 301 redirect chain: /redirect-301 -> /redirect-301-step2 -> /final
      if (url === '/redirect-301') {
        res.writeHead(301, { Location: '/redirect-301-step2' });
        res.end();
      } else if (url === '/redirect-301-step2') {
        res.writeHead(301, { Location: '/final' });
        res.end();
      } else if (url === '/final') {
        res.writeHead(200);
        res.end('OK');

      // 302 redirect
      } else if (url === '/redirect-302') {
        res.writeHead(302, { Location: '/final' });
        res.end();

      // No redirect (direct 200)
      } else if (url === '/no-redirect') {
        res.writeHead(200);
        res.end('OK');

      // Redirect loop: /loop-a -> /loop-b -> /loop-a -> ...
      } else if (url === '/loop-a') {
        res.writeHead(302, { Location: '/loop-b' });
        res.end();
      } else if (url === '/loop-b') {
        res.writeHead(302, { Location: '/loop-a' });
        res.end();

      // Redirect to a URL with a fragment already set
      } else if (url === '/redirect-with-fragment') {
        res.writeHead(301, { Location: '/final#server-fragment' });
        res.end();

      // 403 after redirect (simulates WAF/bot-block at final destination)
      } else if (url === '/redirect-to-403') {
        res.writeHead(301, { Location: '/blocked' });
        res.end();
      } else if (url === '/blocked') {
        res.writeHead(403);
        res.end('Forbidden');

      // 401 (auth-wall, e.g. private Google Sheets)
      } else if (url === '/auth-required') {
        res.writeHead(401);
        res.end('Unauthorized');

      // Cross-domain redirect: redirect from 127.0.0.1 to localhost (different hostname)
      // Simulates auth redirects like particular-tools.azurewebsites.net -> github.com/login
      } else if (url === '/cross-domain-redirect') {
        const addr = server.address() as { port: number };
        res.writeHead(302, { Location: `http://localhost:${addr.port}/final` });
        res.end();

      // 404 (broken link)
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Unexpected server address'));
        return;
      }
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({
        baseUrl,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });

    server.on('error', reject);
  });
}

/**
 * Build synthetic LinkInfo objects for external redirect tests.
 * These reference a virtual file path so they sort predictably in output.
 */
function buildExternalLinks(baseUrl: string, testFile: string): LinkInfo[] {
  const entries: { url: string; text: string; line: number; lineContent: string }[] = [
    { url: `${baseUrl}/redirect-301`, text: '301 chain', line: 1001, lineContent: `[301 chain](${baseUrl}/redirect-301)` },
    { url: `${baseUrl}/redirect-302`, text: '302 redirect', line: 1002, lineContent: `[302 redirect](${baseUrl}/redirect-302)` },
    { url: `${baseUrl}/no-redirect`, text: 'no redirect', line: 1003, lineContent: `[no redirect](${baseUrl}/no-redirect)` },
    { url: `${baseUrl}/loop-a`, text: 'redirect loop', line: 1004, lineContent: `[redirect loop](${baseUrl}/loop-a)` },
    { url: `${baseUrl}/redirect-301#my-anchor`, text: '301 with fragment', line: 1005, lineContent: `[301 with fragment](${baseUrl}/redirect-301#my-anchor)` },
    { url: `${baseUrl}/redirect-with-fragment#my-anchor`, text: 'server fragment wins', line: 1006, lineContent: `[server fragment wins](${baseUrl}/redirect-with-fragment#my-anchor)` },
    { url: `${baseUrl}/redirect-to-403`, text: 'redirect to 403', line: 1007, lineContent: `[redirect to 403](${baseUrl}/redirect-to-403)` },
    { url: `${baseUrl}/auth-required`, text: 'auth required', line: 1008, lineContent: `[auth required](${baseUrl}/auth-required)` },
    { url: `${baseUrl}/cross-domain-redirect`, text: 'cross-domain redirect', line: 1009, lineContent: `[cross-domain redirect](${baseUrl}/cross-domain-redirect)` },
    { url: `${baseUrl}/not-found`, text: 'plain 404', line: 1010, lineContent: `[plain 404](${baseUrl}/not-found)` },
  ];

  return entries.map(e => ({
    url: e.url,
    text: e.text,
    filePath: 'tests/test-document.md',
    line: e.line,
    lineContent: e.lineContent,
    type: 'external' as const,
  }));
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, '..');
  const testFile = path.join(repoRoot, 'tests', 'test-document.md');

  const { baseUrl, close: closeServer } = await startRedirectServer();

  try {
    await runTests(repoRoot, testFile, baseUrl);
  } finally {
    await closeServer();
  }
}

/**
 * Intercept stdout writes from @actions/core (::debug::, ::warning::, etc.)
 * to replace the dynamic localhost URL with a stable placeholder.
 */
function interceptStdout(baseUrl: string): () => void {
  const original = process.stdout.write.bind(process.stdout);
  // The cross-domain test redirects from 127.0.0.1 to localhost on the same port
  const port = new URL(baseUrl).port;
  const localhostUrl = `http://localhost:${port}`;
  process.stdout.write = function (chunk: any, ...args: any[]) {
    if (typeof chunk === 'string' && chunk.startsWith('::')) {
      chunk = chunk.replaceAll(baseUrl, '<server>').replaceAll(localhostUrl, '<server-alt>');
    }
    return (original as any)(chunk, ...args);
  } as any;
  return () => { process.stdout.write = original; };
}

async function runTests(repoRoot: string, testFile: string, baseUrl: string): Promise<void> {
  const restoreStdout = interceptStdout(baseUrl);

  const config: Config = {
    token: '',
    repoRoot,
    owner: 'dvdstelt',
    repo: 'hyperhawk',
    strict: false,
    checkExternal: true,
    checkSameOrg: true,
    ignorePatterns: [],
    timeout: 5000,
    filePatterns: ['tests/test-document.md'],
    concurrency: 1,
  };

  const links = extractLinks(testFile, config);
  const testable = links.filter(l => l.type === 'internal' || l.type === 'same-org');

  // Add synthetic external links that point to the local test server
  const externalLinks = buildExternalLinks(baseUrl, testFile);
  const allLinks = [...testable, ...externalLinks];

  // checkLinks needs an octokit but self-repo same-org links resolve locally
  // and external checks use fetch directly, so no API calls are made.
  const results = await checkLinks(allLinks, config, null as any);

  // Replace the dynamic localhost base URL with a stable placeholder for snapshot comparison
  const stabilize = (s: string): string =>
    s.replaceAll(baseUrl, '<server>').replaceAll(repoRoot, '<root>').replaceAll(path.dirname(repoRoot), '<parent>');

  const lines = results
    .map(r => {
      const rel = path.relative(repoRoot, r.link.filePath).replace(/\\/g, '/');
      const status = r.ok ? (r.suggestionOnly ? 'suggestion' : 'ok') : 'broken';
      let detail = '';
      if (!r.ok && r.correctedUrl) {
        detail = r.isFuzzyMatch ? ` -> ${r.correctedUrl} (fuzzy)` : ` -> ${r.correctedUrl}`;
      } else if (r.suggestionOnly && r.correctedUrl) {
        detail = ` -> ${stabilize(r.correctedUrl)}`;
      } else if (!r.ok) {
        const err = stabilize(r.error ?? 'unknown');
        detail = ` | ${err}`;
      }
      return `${rel}:${r.link.line} | ${stabilize(r.link.url)} | ${status}${detail}`;
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
    const urls = group.map(r => stabilize(r.link.url)).join(' + ');
    const rel = path.relative(repoRoot, group[0].link.filePath).replace(/\\/g, '/');
    mergeLines.push(`merge:${rel}:${group[0].link.line} | ${urls} | ${stabilize(suggestion)}`);
  }

  if (mergeLines.length > 0) {
    process.stdout.write(mergeLines.join('\n') + '\n');
  }

  restoreStdout();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
