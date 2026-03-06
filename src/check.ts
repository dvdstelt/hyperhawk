import * as fs from 'fs';
import * as path from 'path';
import { getOctokit } from '@actions/github';
import { LinkInfo, CheckResult, Config } from './types';

type Octokit = ReturnType<typeof getOctokit>;

// Cache results by URL to avoid duplicate checks
const resultCache = new Map<string, { ok: boolean; statusCode?: number; error?: string }>();

// Lazily built index of every non-ignored file in the repo
let repoFilesCache: string[] | null = null;

function collectFiles(dir: string, results: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'lib'].includes(entry.name)) continue;
      collectFiles(fullPath, results);
    } else {
      results.push(fullPath);
    }
  }
}

function getAllRepoFiles(repoRoot: string): string[] {
  if (!repoFilesCache) {
    repoFilesCache = [];
    collectFiles(repoRoot, repoFilesCache);
  }
  return repoFilesCache;
}

/**
 * Levenshtein distance between two strings (optimised rolling-array variant).
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const prev = Array.from({ length: n + 1 }, (_, i) => i);
  const curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev.splice(0, n + 1, ...curr);
  }
  return curr[n];
}

const FUZZY_THRESHOLD = 0.7;

/**
 * Return all files whose stem scores >= FUZZY_THRESHOLD against the target
 * stem, keeping only those that share the top score.
 */
function fuzzyFindMatches(stem: string, ext: string, repoRoot: string): string[] {
  const target = stem.toLowerCase();
  const targetExt = ext.toLowerCase();
  const allFiles = getAllRepoFiles(repoRoot);

  let bestScore = 0;
  const results: string[] = [];

  for (const file of allFiles) {
    const fileExt = path.extname(file).toLowerCase();
    if (fileExt !== targetExt) continue;

    const fileStem = path.basename(file, fileExt).toLowerCase();
    const maxLen = Math.max(target.length, fileStem.length);
    if (maxLen === 0) continue;

    const score = 1 - levenshtein(target, fileStem) / maxLen;
    if (score < FUZZY_THRESHOLD) continue;

    if (score > bestScore) {
      bestScore = score;
      results.length = 0;
      results.push(file);
    } else if (score === bestScore) {
      results.push(file);
    }
  }

  return results;
}

/**
 * Given multiple candidate paths, pick the one closest to sourceDir by
 * counting path segments in the relative path.  If two candidates are
 * equidistant, returns undefined (truly ambiguous).
 */
function findClosest(candidates: string[], sourceDir: string): string | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  const ranked = candidates
    .map(c => ({ file: c, depth: path.relative(sourceDir, c).split(path.sep).length }))
    .sort((a, b) => a.depth - b.depth);

  return ranked[0].depth < ranked[1].depth ? ranked[0].file : undefined;
}

/**
 * Convert an absolute file path to a repo-root-relative URL (starts with /).
 */
function toRootRelative(absPath: string, repoRoot: string): string {
  return '/' + path.relative(repoRoot, absPath).replace(/\\/g, '/');
}

/**
 * Check an internal (relative or root-relative) link.
 *
 * For working links that use a relative path (../../ or ./):
 *   returns ok=true with a suggestionOnly suggestion to convert to root-relative.
 *
 * For broken links:
 *   1. tries exact filename match across the whole repo
 *   2. falls back to fuzzy stem match
 *   suggestions always use root-relative paths.
 */
async function checkInternal(link: LinkInfo, config: Config): Promise<CheckResult> {
  const url = link.url;

  // Anchor-only links are valid (heading verification would need AST parsing)
  if (url.startsWith('#')) {
    return { link, ok: true };
  }

  // Strip anchor fragment
  const hashIdx = url.indexOf('#');
  const urlWithoutAnchor = hashIdx >= 0 ? url.slice(0, hashIdx) : url;

  if (!urlWithoutAnchor) {
    return { link, ok: true };
  }

  const isRootRelative = urlWithoutAnchor.startsWith('/');
  const sourceDir = path.dirname(path.join(config.repoRoot, link.filePath));

  const resolvedPath = isRootRelative
    ? path.join(config.repoRoot, urlWithoutAnchor)
    : path.resolve(sourceDir, urlWithoutAnchor);

  const exists = fs.existsSync(resolvedPath);

  if (exists) {
    // Link is valid. If it uses a relative path (not root-relative), suggest conversion.
    if (!isRootRelative) {
      const anchor = hashIdx >= 0 ? url.slice(hashIdx) : '';
      const rootRelUrl = toRootRelative(resolvedPath, config.repoRoot) + anchor;
      const suggestion = link.lineContent.trimEnd().replace(url, rootRelUrl);
      return { link, ok: true, suggestion, suggestionOnly: true };
    }
    return { link, ok: true };
  }

  // --- Link is broken: search for the target file ---

  const filename = path.basename(urlWithoutAnchor);
  const stem = path.basename(urlWithoutAnchor, path.extname(urlWithoutAnchor));
  const ext = path.extname(urlWithoutAnchor);

  let correctedAbs: string | undefined;
  let isFuzzy = false;

  // 1. Exact filename match - if multiple, pick the one closest to the source file
  const allFiles = getAllRepoFiles(config.repoRoot);
  const exactMatches = allFiles.filter(f => path.basename(f) === filename);

  if (exactMatches.length >= 1) {
    correctedAbs = findClosest(exactMatches, sourceDir);
  }

  // 2. Fuzzy stem match as fallback - same proximity tie-breaking applies
  if (!correctedAbs && stem) {
    const fuzzyMatches = fuzzyFindMatches(stem, ext, config.repoRoot);
    correctedAbs = findClosest(fuzzyMatches, sourceDir);
    if (correctedAbs) isFuzzy = true;
  }

  let suggestion: string | undefined;
  if (correctedAbs) {
    const anchor = hashIdx >= 0 ? url.slice(hashIdx) : '';
    const rootRelUrl = toRootRelative(correctedAbs, config.repoRoot) + anchor;
    const note = isFuzzy ? '  <!-- fuzzy match - please verify -->' : '';
    // trimEnd() strips trailing \r on CRLF files, which would break GitHub's suggestion block
    suggestion = link.lineContent.trimEnd().replace(url, rootRelUrl) + note;
  }

  return {
    link,
    ok: false,
    error: `File not found: ${resolvedPath}`,
    suggestion,
  };
}

/**
 * Check a same-org GitHub link via the GitHub API.
 */
async function checkSameOrg(link: LinkInfo, octokit: Octokit): Promise<CheckResult> {
  const cached = resultCache.get(link.url);
  if (cached) return { link, ...cached };

  try {
    const parsed = new URL(link.url);
    // pathname: /<owner>/<repo>[/blob/<ref>/<...path>]
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2) {
      const r = { ok: false, error: 'Could not parse GitHub URL' };
      resultCache.set(link.url, r);
      return { link, ...r };
    }

    const repoOwner = parts[0];
    const repoName = parts[1];

    // Verify repo exists
    try {
      await octokit.rest.repos.get({ owner: repoOwner, repo: repoName });
    } catch (err: unknown) {
      const status = getStatusCode(err);
      const r = {
        ok: false,
        statusCode: status,
        error: status === 404 ? `Repository not found (or not accessible with the provided token): ${repoOwner}/${repoName}` : `API error: ${String(err)}`,
      };
      resultCache.set(link.url, r);
      return { link, ...r };
    }

    // If URL has a file path (/blob/<ref>/<path>), check it
    // parts: [owner, repo, 'blob', ref, ...pathParts]
    if (parts.length > 4 && parts[2] === 'blob') {
      const ref = parts[3];
      const filePath = parts.slice(4).join('/');

      try {
        await octokit.rest.repos.getContent({
          owner: repoOwner,
          repo: repoName,
          path: filePath,
          ref,
        });
      } catch (err: unknown) {
        const status = getStatusCode(err);
        const r = {
          ok: false,
          statusCode: status,
          error: status === 404 ? `File not found in repo: ${filePath}` : `API error: ${String(err)}`,
        };
        resultCache.set(link.url, r);
        return { link, ...r };
      }
    }

    const r = { ok: true };
    resultCache.set(link.url, r);
    return { link, ...r };
  } catch (err: unknown) {
    const r = { ok: false, error: `Failed to check same-org link: ${String(err)}` };
    resultCache.set(link.url, r);
    return { link, ...r };
  }
}

/**
 * Check an external HTTP/HTTPS link.
 */
async function checkExternal(link: LinkInfo, config: Config): Promise<CheckResult> {
  const cached = resultCache.get(link.url);
  if (cached) return { link, ...cached };

  const timeout = config.timeout;

  const tryFetch = async (method: string): Promise<{ ok: boolean; status: number }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(link.url, {
        method,
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'HyperHawk-Link-Checker/1.0' },
      });
      return { ok: res.status < 400, status: res.status };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let result = await tryFetch('HEAD');

    // HEAD returned Method Not Allowed - fall back to GET
    if (result.status === 405) {
      result = await tryFetch('GET');
    }

    const r = { ok: result.ok, statusCode: result.status };
    if (!result.ok) {
      resultCache.set(link.url, { ...r, error: `HTTP ${result.status}` });
      return { link, ...r, error: `HTTP ${result.status}` };
    }
    resultCache.set(link.url, r);
    return { link, ...r };
  } catch (err: unknown) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const errorMsg = isTimeout ? `Timed out after ${timeout}ms` : `Network error: ${String(err)}`;
    const r = { ok: false, error: errorMsg };
    resultCache.set(link.url, r);
    return { link, ...r };
  }
}

function getStatusCode(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err) {
    return (err as { status: number }).status;
  }
  return undefined;
}

/**
 * Run checks with limited concurrency.
 */
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;

  const worker = async (): Promise<void> => {
    while (index < tasks.length) {
      const current = index++;
      results[current] = await tasks[current]();
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Check all links with deduplication and concurrency control.
 */
export async function checkLinks(
  links: LinkInfo[],
  config: Config,
  octokit: Octokit
): Promise<CheckResult[]> {
  const tasks = links.map(link => () => {
    switch (link.type) {
      case 'internal':
        return checkInternal(link, config);
      case 'same-org':
        if (!config.checkSameOrg) return Promise.resolve({ link, ok: true });
        return checkSameOrg(link, octokit);
      case 'external':
        if (!config.checkExternal) return Promise.resolve({ link, ok: true });
        return checkExternal(link, config);
    }
  });

  return runWithConcurrency(tasks, config.concurrency);
}
