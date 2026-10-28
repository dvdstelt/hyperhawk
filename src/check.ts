import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import { getOctokit } from '@actions/github';
import { LinkInfo, CheckResult, Config } from './types';

type Octokit = ReturnType<typeof getOctokit>;

// Cache check results by URL to avoid duplicate checks and carry redirect metadata across call sites
const resultCache = new Map<string, { ok: boolean; statusCode?: number; error?: string; correctedUrl?: string; suggestionOnly?: boolean }>();

// Mimic a real browser to avoid bot-detection blocks from sites like Cloudflare, Akamai, etc.
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

/**
 * Manually follow redirect chains so we can detect when a URL was redirected
 * and suggest updating the link to the final destination.
 *
 * @throws {Error} When the redirect limit is exceeded ("Too many redirects").
 * @throws {Error} When a request times out (AbortError via the AbortController).
 */
async function followRedirects(
  url: string,
  method: string,
  timeout: number,
  headers: Record<string, string>,
  maxRedirects = 10
): Promise<{ finalUrl: string; status: number; redirected: boolean }> {
  let currentUrl = url;
  let currentMethod = method;

  for (let i = 0; i < maxRedirects; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let res: Response;
    try {
      res = await fetch(currentUrl, {
        method: currentMethod,
        signal: controller.signal,
        redirect: 'manual',
        headers,
      });
    } finally {
      clearTimeout(timer);
    }

    if (![301, 302, 303, 307, 308].includes(res.status)) {
      // Discard the response body to free the underlying connection
      res.body?.cancel();
      return { finalUrl: currentUrl, status: res.status, redirected: currentUrl !== url };
    }

    const location = res.headers.get('location');
    // Discard the response body for redirect responses
    res.body?.cancel();
    if (!location) {
      // Redirect status but no Location header: this is a protocol violation.
      // Treat current response as final but warn so the issue is visible.
      core.warning(`[external] ${currentUrl} returned HTTP ${res.status} with no Location header`);
      return { finalUrl: currentUrl, status: res.status, redirected: currentUrl !== url };
    }

    try {
      currentUrl = new URL(location, currentUrl).href;
    } catch {
      throw new Error(`Malformed redirect Location header from ${currentUrl}: ${location}`);
    }

    // 303 always switches to GET per HTTP spec.
    // 307/308 preserve the original method (no change needed).
    if (res.status === 303) {
      currentMethod = 'GET';
    }
  }

  throw new Error('Too many redirects');
}

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

  // Decode percent-encoded characters (e.g. %20 for spaces) so the path
  // matches the actual filename on disk.
  const decodedPath = decodeURIComponent(urlWithoutAnchor);

  const isRootRelative = decodedPath.startsWith('/');

  // Relative-link checking can be disabled entirely. Root-relative links
  // (and anchors, handled above) are still verified.
  if (!isRootRelative && !config.checkRelative) {
    return { link, ok: true };
  }

  const sourceDir = path.dirname(path.join(config.repoRoot, link.filePath));

  const resolvedPath = isRootRelative
    ? path.join(config.repoRoot, decodedPath)
    : path.resolve(sourceDir, decodedPath);

  const exists = fs.existsSync(resolvedPath);

  if (exists) {
    // Link is valid. If it uses a relative path (not root-relative), suggest conversion.
    // However, skip the suggestion for same-folder links (e.g. "readme.md" or "./readme.md")
    // because they are simple and unlikely to break.
    if (!isRootRelative && !isIssueTemplate(link.filePath)) {
      // Suggest a root-relative conversion only for links that traverse more
      // directory levels than the configured depth. Closer links (at or below
      // the threshold, e.g. same-folder by default) are left as-is because
      // they are simple and unlikely to break.
      const depth = relativeLinkDepth(urlWithoutAnchor);
      if (depth > config.relativeSuggestionDepth) {
        const anchor = hashIdx >= 0 ? url.slice(hashIdx) : '';
        const rootRelUrl = toRootRelative(resolvedPath, config.repoRoot) + anchor;
        const suggestion = link.lineContent.trimEnd().replace(url, rootRelUrl);
        return { link, ok: true, suggestion, suggestionOnly: true };
      }
    }
    return { link, ok: true };
  }

  // --- Link is broken: search for the target file ---

  const filename = path.basename(decodedPath);
  const stem = path.basename(decodedPath, path.extname(decodedPath));
  const ext = path.extname(decodedPath);

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
  let correctedUrl: string | undefined;
  if (correctedAbs) {
    const anchor = hashIdx >= 0 ? url.slice(hashIdx) : '';
    correctedUrl = toRootRelative(correctedAbs, config.repoRoot) + anchor;
    const note = isFuzzy ? '  <!-- fuzzy match - please verify -->' : '';
    // trimEnd() strips trailing \r on CRLF files, which would break GitHub's suggestion block
    suggestion = link.lineContent.trimEnd().replace(url, correctedUrl) + note;
  }

  return {
    link,
    ok: false,
    error: `File not found: ${resolvedPath}`,
    suggestion,
    correctedUrl,
    isFuzzyMatch: isFuzzy && !!correctedAbs,
  };
}

/**
 * Returns true if a GitHub repo appears to be private (or otherwise
 * inaccessible). Makes a single unauthenticated request to the public API:
 * - public repo  → 200, clearly accessible, not private
 * - private repo → 404 without auth (same as non-existent)
 * When the unauthenticated request also returns 404 we can't be certain,
 * but we treat it as "may be private" and skip silently to avoid false
 * positives on repos the token simply can't see.
 */
async function looksPrivate(owner: string, repo: string): Promise<boolean> {
  core.debug(`[same-org] Authenticated request returned 404 for ${owner}/${repo} - checking unauthenticated to distinguish private vs non-existent`);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github.v3+json' },
    });
    clearTimeout(timer);
    core.debug(`[same-org] Unauthenticated check for ${owner}/${repo} returned HTTP ${res.status}`);
    // 200 = public repo, our authenticated check should have succeeded too (unusual)
    // Anything other than 200 (404, 403, ...) = treat as private/inaccessible
    return res.status !== 200;
  } catch (err) {
    // Network error - can't verify, assume inaccessible
    core.debug(`[same-org] Unauthenticated check for ${owner}/${repo} failed with network error: ${String(err)}`);
    return true;
  }
}

/**
 * Files in .github/ISSUE_TEMPLATE/ are rendered as GitHub issues, where
 * relative and root-relative URLs do not work. Skip conversion suggestions
 * for links inside these files.
 */
function isIssueTemplate(filePath: string): boolean {
  return filePath.startsWith('.github/ISSUE_TEMPLATE/');
}

/**
 * Count how many directory levels a relative link traverses, ignoring the
 * filename itself. Each '..' (up) or named directory segment (down) counts
 * as one level; '.' and empty segments are ignored.
 *
 *   readme.md         -> 0  (same folder)
 *   ./readme.md       -> 0
 *   ../readme.md      -> 1
 *   sub/readme.md     -> 1
 *   ../../readme.md   -> 2
 *   ../sub/readme.md  -> 2
 */
function relativeLinkDepth(relativePath: string): number {
  const segments = relativePath.replace(/\\/g, '/').split('/');
  segments.pop(); // drop the filename
  let depth = 0;
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    depth++;
  }
  return depth;
}

/**
 * Suggest rewriting a full GitHub URL that points to the current repo
 * as a local path. Uses the same convention as checkInternal: same-folder
 * files use a bare filename, everything else uses a root-relative path.
 */
function suggestLocalPath(link: LinkInfo, parts: string[], config: Config): CheckResult {
  if (isIssueTemplate(link.filePath)) {
    return { link, ok: true, suggestionOnly: true };
  }
  // parts: [owner, repo, 'blob'|'tree', ref, ...pathParts] or [owner, repo, ...]
  const hasFilePath = parts.length > 4 && (parts[2] === 'blob' || parts[2] === 'tree');

  if (!hasFilePath) {
    // Just a repo URL (e.g. https://github.com/owner/repo or .../issues/1)
    // No local path equivalent; mark ok with no suggestion
    return { link, ok: true, suggestionOnly: true };
  }

  const filePath = parts.slice(4).join('/');
  const resolvedPath = path.join(config.repoRoot, filePath);
  const exists = fs.existsSync(resolvedPath);

  const sourceDir = path.dirname(path.join(config.repoRoot, link.filePath));
  const isSameFolder = path.dirname(resolvedPath) === sourceDir;

  let localUrl = isSameFolder
    ? path.basename(filePath)
    : '/' + filePath;

  // Preserve hash fragment from the original URL
  const hashIndex = link.url.indexOf('#');
  if (hashIndex !== -1) {
    localUrl += link.url.substring(hashIndex);
  }

  if (!exists) {
    // Try to find the correct file via exact filename or fuzzy stem match,
    // same as checkInternal does for broken internal links.
    const filename = path.basename(filePath);
    const stem = path.basename(filePath, path.extname(filePath));
    const ext = path.extname(filePath);

    let correctedAbs: string | undefined;
    let isFuzzy = false;

    const allFiles = getAllRepoFiles(config.repoRoot);
    const exactMatches = allFiles.filter(f => path.basename(f) === filename);
    if (exactMatches.length >= 1) {
      correctedAbs = findClosest(exactMatches, sourceDir);
    }

    if (!correctedAbs && stem) {
      const fuzzyMatches = fuzzyFindMatches(stem, ext, config.repoRoot);
      correctedAbs = findClosest(fuzzyMatches, sourceDir);
      if (correctedAbs) isFuzzy = true;
    }

    if (correctedAbs) {
      const correctedSameFolder = path.dirname(correctedAbs) === sourceDir;
      localUrl = correctedSameFolder
        ? path.basename(correctedAbs)
        : toRootRelative(correctedAbs, config.repoRoot);
      if (hashIndex !== -1) {
        localUrl += link.url.substring(hashIndex);
      }
    }

    const suggestion = link.lineContent.trimEnd().replace(link.url, localUrl);
    return {
      link,
      ok: false,
      error: `File not found: ${resolvedPath}`,
      correctedUrl: localUrl,
      suggestion,
      isFuzzyMatch: isFuzzy && !!correctedAbs,
    };
  }

  const suggestion = link.lineContent.trimEnd().replace(link.url, localUrl);
  return {
    link,
    ok: true,
    suggestion,
    correctedUrl: localUrl,
    suggestionOnly: true,
  };
}

/**
 * Check a same-org GitHub link via the GitHub API.
 */
// Upper bound on the number of slash-separated segments tried as a ref.
const MAX_REF_SEGMENTS = 5;

/**
 * Split the segments after /blob/ or /tree/ into a ref and a file path.
 *
 * Branch names can contain slashes (e.g. release/1.0), so a URL like
 * /blob/release/1.0/docs/guide.md is ambiguous: the URL alone doesn't say
 * where the ref ends. GitHub resolves it against the refs that exist; here
 * every split is returned, shortest ref first, so callers can try each one.
 * The first candidate is the common case of a ref without slashes.
 */
export function refPathCandidates(segments: string[]): { ref: string; filePath: string }[] {
  const candidates: { ref: string; filePath: string }[] = [];
  for (let i = 1; i < segments.length && candidates.length < MAX_REF_SEGMENTS; i++) {
    candidates.push({
      ref: segments.slice(0, i).join('/'),
      filePath: segments.slice(i).join('/'),
    });
  }
  return candidates;
}

async function checkSameOrg(link: LinkInfo, octokit: Octokit, config: Config): Promise<CheckResult> {
  const cached = resultCache.get(link.url);
  if (cached) {
    core.debug(`[same-org] Cache hit for ${link.url}: ok=${cached.ok}`);
    return { link, ...cached };
  }

  core.debug(`[same-org] Checking ${link.url}`);

  try {
    const parsed = new URL(link.url);
    // pathname: /<owner>/<repo>[/blob/<ref>/<...path>]
    //       or: /orgs/<owner>/projects/<id>[/views/<id>]
    const parts = parsed.pathname.split('/').filter(Boolean);

    // Org-level URLs (e.g. /orgs/owner/projects/123) - we trust these if
    // the org matches; there is no simple API to verify project access.
    if (parts[0] === 'orgs' && parts.length >= 2) {
      core.debug(`[same-org] Org-level URL, treating as valid: ${link.url}`);
      const r = { ok: true };
      resultCache.set(link.url, r);
      return { link, ...r };
    }

    if (parts.length < 2) {
      core.debug(`[same-org] Could not parse pathname: ${parsed.pathname}`);
      const r = { ok: false, error: 'Could not parse GitHub URL' };
      resultCache.set(link.url, r);
      return { link, ...r };
    }

    const repoOwner = parts[0];
    const repoName = parts[1];

    // Self-repo link: suggest rewriting as a local path instead of a full URL
    if (repoOwner.toLowerCase() === config.owner.toLowerCase()
        && repoName.toLowerCase() === config.repo.toLowerCase()) {
      core.debug(`[same-org] URL points to current repo, suggesting local path: ${link.url}`);
      return suggestLocalPath(link, parts, config);
    }

    core.debug(`[same-org] Verifying repo ${repoOwner}/${repoName} via authenticated API`);

    // Verify repo exists and retrieve the default branch name
    let defaultBranch: string | undefined;
    try {
      const repoData = await octokit.rest.repos.get({ owner: repoOwner, repo: repoName });
      defaultBranch = repoData.data.default_branch;
      core.debug(`[same-org] Repo ${repoOwner}/${repoName} found - private=${repoData.data.private}, default_branch=${defaultBranch}`);
    } catch (err: unknown) {
      const status = getStatusCode(err);
      core.debug(`[same-org] Repo ${repoOwner}/${repoName} returned HTTP ${status ?? 'unknown'}: ${String(err)}`);
      if (status === 404) {
        // 404 can mean the repo is private and the token can't see it, or that
        // it truly doesn't exist. Try an unauthenticated request to tell them apart:
        // public repos return 200 without auth; private repos return 404 either way.
        const isPrivate = await looksPrivate(repoOwner, repoName);
        if (isPrivate) {
          core.debug(`[same-org] ${repoOwner}/${repoName} is likely private or inaccessible - skipping silently`);
          const r = { ok: true };
          resultCache.set(link.url, r);
          return { link, ...r };
        }
        core.debug(`[same-org] ${repoOwner}/${repoName} confirmed non-existent (public check also 404)`);
        const r = { ok: false, statusCode: 404, error: `Repository not found: ${repoOwner}/${repoName}` };
        resultCache.set(link.url, r);
        return { link, ...r };
      }
      const r = { ok: false, statusCode: status, error: `API error: ${String(err)}` };
      resultCache.set(link.url, r);
      return { link, ...r };
    }

    // If URL has a file/directory path (/blob/<ref>/<path> or /tree/<ref>/<path>), check it
    // parts: [owner, repo, 'blob'|'tree', ref, ...pathParts]
    if (parts.length > 4 && (parts[2] === 'blob' || parts[2] === 'tree')) {
      const candidates = refPathCandidates(parts.slice(3));
      let { ref, filePath } = candidates[0];

      const urlKind = parts[2] as 'blob' | 'tree';
      core.debug(`[same-org] Verifying ${urlKind} ${filePath} at ref ${ref} in ${repoOwner}/${repoName}`);

      try {
        let content: Awaited<ReturnType<typeof octokit.rest.repos.getContent>> | undefined;
        let firstError: unknown;
        for (const candidate of candidates) {
          try {
            content = await octokit.rest.repos.getContent({
              owner: repoOwner,
              repo: repoName,
              path: candidate.filePath,
              ref: candidate.ref,
            });
            ({ ref, filePath } = candidate);
            break;
          } catch (err: unknown) {
            firstError ??= err;
            // Only a 404 can mean the ref contains a slash; anything else is a real error.
            if (getStatusCode(err) !== 404) throw err;
            core.debug(`[same-org] ${candidate.filePath} not found at ref ${candidate.ref}`);
          }
        }
        if (!content) throw firstError;
        core.debug(`[same-org] File ${filePath} found at ref ${ref} in ${repoOwner}/${repoName}`);

        // Suggest fixing blob/tree mismatch: /blob/ is for files, /tree/ is for directories.
        const isArray = Array.isArray(content.data);
        const contentType = isArray ? 'dir' : (content.data as { type: string }).type;
        const expectedKind = contentType === 'dir' ? 'tree' : 'blob';
        if (urlKind !== expectedKind) {
          core.debug(`[same-org] ${filePath} is a ${contentType} but URL uses /${urlKind}/, suggesting /${expectedKind}/`);
          const correctedUrl = link.url.replace(`/${urlKind}/${ref}/`, `/${expectedKind}/${ref}/`);
          const suggestion = link.lineContent.trimEnd().replace(link.url, correctedUrl);
          const r = { ok: true, correctedUrl, suggestionOnly: true };
          resultCache.set(link.url, r);
          return { link, ...r, suggestion };
        }
      } catch (err: unknown) {
        const status = getStatusCode(err);
        core.debug(`[same-org] File ${filePath} in ${repoOwner}/${repoName} returned HTTP ${status ?? 'unknown'}: ${String(err)}`);

        // If the file was not found and the URL ref differs from the default
        // branch, retry on the default branch. GitHub's web UI redirects
        // master -> main transparently, but the API does not.
        if (status === 404 && defaultBranch && ref !== defaultBranch) {
          core.debug(`[same-org] Retrying ${filePath} with default branch ${defaultBranch} (URL used ${ref})`);
          try {
            await octokit.rest.repos.getContent({
              owner: repoOwner,
              repo: repoName,
              path: filePath,
              ref: defaultBranch,
            });
            core.debug(`[same-org] File ${filePath} found on ${defaultBranch}, suggesting branch update`);
            const correctedUrl = link.url.replace(
              `/${parts[2]}/${ref}/`,
              `/${parts[2]}/${defaultBranch}/`
            );
            const suggestion = link.lineContent.trimEnd().replace(link.url, correctedUrl);
            const r = { ok: true, correctedUrl, suggestionOnly: true };
            resultCache.set(link.url, r);
            return { link, ...r, suggestion };
          } catch {
            core.debug(`[same-org] File ${filePath} also not found on ${defaultBranch}`);
          }
        }

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
 * Query parameters a server attaches to identify the visit rather than the
 * content. support.google.com, for example, redirects to a URL carrying a
 * `visit_id` session token that is stale the moment it is written down.
 * Committing one of these into a markdown file is never what the author wants,
 * so they are dropped from redirect suggestions. Anything prefixed `utm_` is
 * treated the same way.
 */
const TRACKING_PARAMS = new Set([
  'visit_id',                             // support.google.com session token
  'rd',                                   // support.google.com redirect counter
  'sjid',                                 // Google session join id
  'gclid', 'dclid', 'fbclid', 'msclkid',  // ad platform click ids
  'mc_cid', 'mc_eid',                     // Mailchimp campaign and email ids
  '_ga', '_gl',                           // Google Analytics cross-domain linker
]);

function isTrackingParam(name: string): boolean {
  return TRACKING_PARAMS.has(name) || name.startsWith('utm_');
}

/**
 * Drop tracking parameters that the redirect introduced. A parameter already
 * present on the original link is left alone: the author put it there
 * deliberately, and this strips server noise, it does not rewrite intent.
 */
function stripTrackingParams(finalUrl: string, originalUrl: string): string {
  let parsed: URL;
  let original: URL;
  try {
    parsed = new URL(finalUrl);
    original = new URL(originalUrl);
  } catch {
    return finalUrl;
  }

  const drop = [...parsed.searchParams.keys()].filter(
    name => isTrackingParam(name) && !original.searchParams.has(name)
  );
  if (drop.length === 0) return finalUrl;

  for (const name of drop) {
    parsed.searchParams.delete(name);
  }
  return parsed.toString();
}

/**
 * Returns true if two URLs are the same once parsed, so that a redirect which
 * only added tracking noise is not mistaken for a content move.
 */
function isSameUrl(urlA: string, urlB: string): boolean {
  if (urlA === urlB) return true;
  try {
    return new URL(urlA).toString() === new URL(urlB).toString();
  } catch {
    return false;
  }
}

/**
 * Build the final redirect URL, re-attaching the fragment from the original URL
 * when the redirect target does not include one (servers typically strip
 * fragments from Location headers).
 */
function buildRedirectUrl(originalUrl: string, finalUrl: string): string {
  const cleanedUrl = stripTrackingParams(finalUrl, originalUrl);
  const originalHash = originalUrl.indexOf('#') >= 0 ? originalUrl.slice(originalUrl.indexOf('#')) : '';
  if (!originalHash) return cleanedUrl;

  // If the final URL already has a fragment, keep it as-is
  if (cleanedUrl.indexOf('#') >= 0) return cleanedUrl;

  return cleanedUrl + originalHash;
}

/**
 * Returns true if two URLs share the same hostname. Cross-domain redirects
 * are typically auth/login flows, not content moves, so we suppress
 * redirect suggestions when the host changes.
 */
function isSameHost(urlA: string, urlB: string): boolean {
  try {
    return new URL(urlA).hostname === new URL(urlB).hostname;
  } catch {
    return false;
  }
}

/**
 * GitHub user-attachment assets (uploaded images/files in issues, PRs, and
 * discussions) live under a fixed path and cannot be deleted without GitHub
 * admin intervention, so they are effectively permanent. Verifying them
 * would require passing GitHub auth headers through the S3 redirect chain,
 * adding complexity for no real benefit. Trust them unconditionally.
 */
function isGitHubUserAttachment(url: string): boolean {
  return url.startsWith('https://github.com/user-attachments/assets/');
}

/**
 * Check an external HTTP/HTTPS link.
 */
async function checkExternal(link: LinkInfo, config: Config): Promise<CheckResult> {
  if (isGitHubUserAttachment(link.url)) {
    core.debug(`[external] ${link.url} is a GitHub user-attachment asset, treating as valid`);
    return { link, ok: true };
  }

  const cached = resultCache.get(link.url);
  if (cached) {
    // Reconstruct suggestion from cached correctedUrl since lineContent varies per call site
    if (cached.correctedUrl && cached.suggestionOnly) {
      const suggestion = link.lineContent.trimEnd().replace(link.url, () => cached.correctedUrl!);
      return { link, ...cached, suggestion };
    }
    return { link, ...cached };
  }

  const timeout = config.timeout;

  try {
    let result = await followRedirects(link.url, 'HEAD', timeout, BROWSER_HEADERS);

    // Plenty of hosts mishandle HEAD: some answer 405 Method Not Allowed, others
    // return an outright error for a page they serve fine on GET (support.google.com
    // answers 404 to HEAD but 200 to GET). Retry every failing HEAD with GET so the
    // verdict matches what a reader actually gets. Only failures pay the extra
    // request, and followRedirects discards the body as soon as headers arrive.
    if (result.status >= 400) {
      core.debug(`[external] ${link.url} returned HTTP ${result.status} for HEAD - retrying with GET`);
      result = await followRedirects(link.url, 'GET', timeout, BROWSER_HEADERS);
    }

    // 401/403/429: auth-wall or bot-blocked, treat as ok. The URL exists
    // but requires authentication or is rate-limiting automated access.
    if (result.status === 401 || result.status === 403 || result.status === 429) {
      core.debug(`[external] ${link.url} returned HTTP ${result.status} - treating as auth/bot-blocked, skipping`);
      const r = { ok: true, statusCode: result.status };
      resultCache.set(link.url, r);
      return { link, ...r };
    }

    const ok = result.status < 400;

    if (ok && result.redirected) {
      // Only suggest updating the URL if the redirect stays on the same host.
      // Cross-domain redirects are typically auth/login flows, not content moves.
      if (isSameHost(link.url, result.finalUrl)) {
        const correctedUrl = buildRedirectUrl(link.url, result.finalUrl);
        // The redirect only added tracking noise, so there is nothing to fix.
        if (isSameUrl(correctedUrl, link.url)) {
          core.debug(`[external] ${link.url} redirected only to add tracking parameters - skipping suggestion`);
          const r = { ok: true, statusCode: result.status };
          resultCache.set(link.url, r);
          return { link, ...r };
        }
        const suggestion = link.lineContent.trimEnd().replace(link.url, () => correctedUrl);
        const r = { ok: true, statusCode: result.status, correctedUrl, suggestionOnly: true };
        resultCache.set(link.url, r);
        return { link, ...r, suggestion };
      }
      core.debug(`[external] ${link.url} redirected to different host ${result.finalUrl} - skipping suggestion`);
      const r = { ok: true, statusCode: result.status };
      resultCache.set(link.url, r);
      return { link, ...r };
    }

    if (!ok) {
      const r = { ok: false, statusCode: result.status, error: `HTTP ${result.status}` };
      resultCache.set(link.url, r);
      return { link, ...r };
    }

    const r = { ok: true, statusCode: result.status };
    resultCache.set(link.url, r);
    return { link, ...r };
  } catch (err: unknown) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const isRedirectError = err instanceof Error && (err.message.startsWith('Too many redirects') || err.message.startsWith('Malformed redirect'));
    const errorMsg = isTimeout
      ? `Timed out after ${timeout}ms`
      : isRedirectError
        ? err.message
        : `Network error: ${String(err)}`;
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
 * crossRepoOctokit is used for same-org checks; falls back to octokit when not provided.
 */
export async function checkLinks(
  links: LinkInfo[],
  config: Config,
  octokit: Octokit,
  crossRepoOctokit?: Octokit
): Promise<CheckResult[]> {
  const sameOrgOctokit = crossRepoOctokit ?? octokit;

  const tasks = links.map(link => () => {
    switch (link.type) {
      case 'internal':
        return checkInternal(link, config);
      case 'same-org':
        if (!config.checkSameOrg) return Promise.resolve({ link, ok: true });
        return checkSameOrg(link, sameOrgOctokit, config);
      case 'external':
        if (!config.checkExternal) return Promise.resolve({ link, ok: true });
        return checkExternal(link, config);
    }
  });

  return runWithConcurrency(tasks, config.concurrency);
}
