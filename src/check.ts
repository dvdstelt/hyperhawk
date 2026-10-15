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

// ---------------------------------------------------------------------------
// Repository index: every non-ignored file, plus the heading anchors of every
// markdown file. From it, the list of every URL the repository exposes: each
// file, and each file with one of its anchors. Built once per run, on first
// use.
// ---------------------------------------------------------------------------

interface IndexedFile {
  abs: string;           // absolute path on disk
  rel: string;           // repo-relative, forward slashes
  dirSegments: string[]; // directory part of rel, split and lowercased
  basename: string;      // file name with extension, original case
  ext: string;           // extension, lowercased (".md")
  stem: string;          // file name without extension, lowercased
  anchors: string[];     // heading slugs; empty for non-markdown files
}

/** One URL the repository exposes: a file, or a file with one of its anchors. */
interface IndexedUrl {
  file: IndexedFile;
  anchor: string; // heading slug, or "" for the file itself
}

let repoIndexCache: IndexedFile[] | null = null;
let repoUrlsCache: IndexedUrl[] | null = null;

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);

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

/**
 * Convert heading text to the anchor slug GitHub generates for it:
 * markup removed, lowercase, punctuation removed, spaces replaced by hyphens.
 */
function headingSlug(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')                   // HTML tags: <code>foo</code>
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')      // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // inline links: keep the text
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')  // reference links: keep the text
    .replace(/[`*~]/g, '')                     // inline formatting
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-_]/gu, '')
    .replace(/\s/g, '-');
}

/**
 * Extract every anchor a markdown file exposes: ATX headings (# Title),
 * Setext headings (Title over === or ---), both with GitHub's "-1", "-2"
 * suffixes for duplicates, and explicit id="" / name="" attributes.
 */
function extractAnchors(content: string): string[] {
  const anchors: string[] = [];
  const seen = new Map<string, number>();
  const addHeading = (text: string): void => {
    const base = headingSlug(text);
    if (!base) return;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.push(count === 0 ? base : `${base}-${count}`);
  };

  let inFence = false;
  let previous = ''; // previous line outside fences, for Setext headings

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trimEnd();
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      previous = '';
      continue;
    }
    if (inFence) continue;

    const atx = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (atx) {
      addHeading(atx[1]);
      previous = '';
      continue;
    }

    const isUnderline = /^\s{0,3}(=+|-+)\s*$/.test(line);
    const previousIsText =
      previous.trim() !== '' && !/^\s{0,3}([-*+]|\d+[.)])\s/.test(previous) && !/^\s{0,3}#/.test(previous);
    if (isUnderline && previousIsText) {
      addHeading(previous);
      previous = '';
      continue;
    }

    for (const attr of line.matchAll(/\b(?:id|name)="([^"]+)"/g)) {
      anchors.push(attr[1].toLowerCase());
    }
    previous = line;
  }

  return anchors;
}

function getRepoIndex(repoRoot: string): IndexedFile[] {
  if (!repoIndexCache) {
    const files: string[] = [];
    collectFiles(repoRoot, files);

    repoIndexCache = files.map(abs => {
      const ext = path.extname(abs).toLowerCase();
      let anchors: string[] = [];
      if (MARKDOWN_EXTENSIONS.has(ext)) {
        try {
          anchors = extractAnchors(fs.readFileSync(abs, 'utf8'));
        } catch {
          // unreadable file: index it without anchors
        }
      }
      const rel = path.relative(repoRoot, abs).replace(/\\/g, '/');
      return {
        abs,
        rel,
        dirSegments: dirSegmentsOf(rel),
        basename: path.basename(abs),
        ext,
        stem: path.basename(abs, path.extname(abs)).toLowerCase(),
        anchors,
      };
    });
  }
  return repoIndexCache;
}

function getRepoUrls(repoRoot: string): IndexedUrl[] {
  if (!repoUrlsCache) {
    repoUrlsCache = getRepoIndex(repoRoot).flatMap(file => [
      { file, anchor: '' },
      ...file.anchors.map(anchor => ({ file, anchor })),
    ]);
  }
  return repoUrlsCache;
}

/** Lowercased directory segments of a repo-relative path ("a/B/c.md" -> ["a", "b"]). */
function dirSegmentsOf(rel: string): string[] {
  const dir = path.posix.dirname(rel.replace(/\\/g, '/'));
  return dir === '.' ? [] : dir.toLowerCase().split('/');
}

/** decodeURIComponent that returns the input unchanged when it is malformed ("#100%"). */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Anchors that address lines, not headings: #L10, #L10-L20, #L10C5-L12C8.
const LINE_ANCHOR = /^L\d+(?:C\d+)?(?:-L\d+(?:C\d+)?)?$/i;

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

/** Similarity in [0, 1]: 1 means identical, 0 means nothing in common. */
function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// Cost of a directory segment that is added or removed, in segment edits.
// A replaced segment costs 1 minus the similarity of the two names.
const SEGMENT_GAP_COST = 0.5;

/**
 * Edit distance between two directory paths, counted in segments.
 * "rabbitmq" -> "rabbit-mq" is nearly free; "rabbitmq" -> "kafka" costs
 * almost a full segment; a missing parent folder costs SEGMENT_GAP_COST.
 */
function segmentDistance(a: string[], b: string[]): number {
  let prev = b.map((_, j) => (j + 1) * SEGMENT_GAP_COST);
  prev.unshift(0);
  for (let i = 1; i <= a.length; i++) {
    const curr = new Array<number>(b.length + 1);
    curr[0] = i * SEGMENT_GAP_COST;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + SEGMENT_GAP_COST,
        curr[j - 1] + SEGMENT_GAP_COST,
        prev[j - 1] + (1 - similarity(a[i - 1], b[j - 1])),
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

// Minimum file-name similarity for a file to be a candidate at all.
const FUZZY_THRESHOLD = 0.7;

// Weights of the three parts of a candidate score. The folder weighs most:
// a link to "Brand style guide/README.md" must prefer "brand-style-guide/"
// over any other README.
const WEIGHT_DIR = 0.5;
const WEIGHT_NAME = 0.3;
const WEIGHT_ANCHOR = 0.2;

// Anchor score of a file without the anchor when the link has one. The file
// is still a valid target: the heading may have been renamed or removed.
const NO_ANCHOR_SCORE = 0.5;

// Minimum score for a one-click suggestion. Below it, the best candidate is
// probably in another repository or unrelated. The only exception is a file
// name that exists exactly once in the repository: that is a moved file.
const MIN_SUGGESTION_SCORE = 0.8;

// Candidates whose folder is within this many segment edits of the best
// folder are treated as equally placed. The one nearest to the source file
// then wins: "../x.md" written for a file in the same folder.
const DIR_MARGIN = 0.2;

interface Candidate {
  url: IndexedUrl;
  dirEdits: number;
  nameScore: number;
  anchorScore: number;
  total: number;
  depth: number; // path segments between the source folder and the file
}

interface Replacement {
  file?: IndexedFile;   // best candidate, undefined when none or ambiguous
  anchor: string;       // anchor for the suggestion, with "#", or ""
  ambiguous: string[];  // absolute paths of candidates that tie for first place
}

/**
 * Find a replacement for a file that does not exist.
 *
 * The link (folder, file name and anchor) is matched against every URL the
 * repository exposes. Each candidate is scored on three parts:
 *   - folder: segment edit distance between the folders
 *   - name: similarity of the file name stems
 *   - anchor: similarity of the heading slugs; a file without the anchor
 *     scores NO_ANCHOR_SCORE, so a renamed heading does not hide a moved file
 * Line anchors (#L10) address lines, not headings. They are not matched and
 * are kept on the suggestion as they are.
 *
 * Among candidates with an equally placed folder, the one nearest to the
 * source file wins. An exact tie is ambiguous: no suggestion, and the tied
 * files are returned so the report can list them.
 *
 * @param targetRel  repo-relative path the link resolves to (forward slashes)
 * @param anchor     anchor from the link without "#", or "" when absent
 */
function findReplacement(
  targetRel: string,
  anchor: string,
  sourceDir: string,
  repoRoot: string,
): Replacement {
  const none: Replacement = { anchor: '', ambiguous: [] };

  const rel = targetRel.replace(/\\/g, '/');
  const basename = path.posix.basename(rel);
  const ext = path.posix.extname(basename).toLowerCase();
  const stem = path.posix.basename(basename, path.posix.extname(basename)).toLowerCase();
  if (!stem) return none;
  const dirSegments = dirSegmentsOf(rel);

  const decodedAnchor = safeDecode(anchor);
  const lineAnchor = LINE_ANCHOR.test(decodedAnchor) ? decodedAnchor : '';
  const heading = lineAnchor ? '' : decodedAnchor.toLowerCase().replace(/^user-content-/, '');

  const index = getRepoIndex(repoRoot);
  const exactNameCount = index.filter(f => f.basename === basename).length;

  const candidates: Candidate[] = [];
  for (const url of getRepoUrls(repoRoot)) {
    const { file } = url;
    if (file.ext !== ext) continue;
    if (!heading && url.anchor) continue; // the link has no heading: only whole files
    const nameScore = similarity(stem, file.stem);
    if (nameScore < FUZZY_THRESHOLD) continue;

    const dirEdits = segmentDistance(dirSegments, file.dirSegments);
    const dirScore = 1 - dirEdits / Math.max(1, dirSegments.length, file.dirSegments.length);
    const anchorScore = !heading ? 1 : url.anchor ? similarity(heading, url.anchor) : NO_ANCHOR_SCORE;
    const total = WEIGHT_DIR * dirScore + WEIGHT_NAME * nameScore + WEIGHT_ANCHOR * anchorScore;
    const depth = path.relative(sourceDir, file.abs).split(path.sep).length;
    candidates.push({ url, dirEdits, nameScore, anchorScore, total, depth });
  }
  if (candidates.length === 0) return none;

  candidates.sort((a, b) => b.total - a.total || a.depth - b.depth);
  const best = candidates[0];

  const uniqueExactName = best.url.file.basename === basename && exactNameCount === 1;
  if (best.total < MIN_SUGGESTION_SCORE && !uniqueExactName) return none;

  // Equally placed folders: the nearest file wins, then the higher score.
  const close = candidates.filter(
    c => c.dirEdits <= best.dirEdits + DIR_MARGIN && c.nameScore >= best.nameScore && c.anchorScore >= best.anchorScore,
  );
  const minDepth = Math.min(...close.map(c => c.depth));
  const nearest = close.filter(c => c.depth === minDepth); // still sorted by total

  if (nearest.length > 1 && nearest[0].total === nearest[1].total) {
    const ties = nearest.filter(c => c.total === nearest[0].total).map(c => c.url.file.abs);
    return { anchor: '', ambiguous: [...new Set(ties)] };
  }

  const chosen = nearest[0];
  const suggestedAnchor = lineAnchor ? `#${lineAnchor}` : chosen.url.anchor ? `#${chosen.url.anchor}` : '';
  return { file: chosen.url.file, anchor: suggestedAnchor, ambiguous: [] };
}

/**
 * Error text for a missing file. Lists the tied candidates when the search
 * found several files that fit equally well.
 */
function notFoundError(resolvedPath: string, replacement: Replacement, repoRoot: string): string {
  const base = `File not found: ${resolvedPath}`;
  if (replacement.ambiguous.length === 0) return base;
  const list = replacement.ambiguous.map(abs => toRootRelative(abs, repoRoot)).join(', ');
  return `${base}. Similar files found in several places: ${list}`;
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
 *   finds the closest URL in the repository (see findReplacement) and
 *   suggests it as a root-relative path.
 */
async function checkInternal(link: LinkInfo, config: Config): Promise<CheckResult> {
  const url = link.url;

  // Same-file anchors (#section) are not verified.
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
  const decodedPath = safeDecode(urlWithoutAnchor);

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

  // --- Link is broken: search for the closest URL in the repository ---

  const anchor = hashIdx >= 0 ? url.slice(hashIdx + 1) : '';
  const targetRel = path.relative(config.repoRoot, resolvedPath);
  const replacement = findReplacement(targetRel, anchor, sourceDir, config.repoRoot);

  let suggestion: string | undefined;
  let correctedUrl: string | undefined;
  if (replacement.file) {
    correctedUrl = toRootRelative(replacement.file.abs, config.repoRoot) + replacement.anchor;
    // trimEnd() strips trailing \r on CRLF files, which would break GitHub's suggestion block
    suggestion = link.lineContent.trimEnd().replace(url, correctedUrl) + '  <!-- closest match - please verify -->';
  }

  return {
    link,
    ok: false,
    error: notFoundError(resolvedPath, replacement, config.repoRoot),
    suggestion,
    correctedUrl,
    isFuzzyMatch: !!correctedUrl,
    candidates: replacement.ambiguous.map(abs => toRootRelative(abs, config.repoRoot)),
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
    // Find the closest URL in the repository, same as checkInternal does
    // for broken internal links.
    const anchor = hashIndex !== -1 ? link.url.slice(hashIndex + 1) : '';
    const replacement = findReplacement(filePath, anchor, sourceDir, config.repoRoot);

    if (replacement.file) {
      const correctedSameFolder = path.dirname(replacement.file.abs) === sourceDir;
      localUrl = (correctedSameFolder
        ? path.basename(replacement.file.abs)
        : toRootRelative(replacement.file.abs, config.repoRoot)) + replacement.anchor;
    }

    const suggestion = link.lineContent.trimEnd().replace(link.url, localUrl);
    return {
      link,
      ok: false,
      error: notFoundError(resolvedPath, replacement, config.repoRoot),
      correctedUrl: localUrl,
      suggestion,
      isFuzzyMatch: !!replacement.file,
      candidates: replacement.ambiguous.map(abs => toRootRelative(abs, config.repoRoot)),
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
      const ref = parts[3];
      const filePath = parts.slice(4).join('/');

      const urlKind = parts[2] as 'blob' | 'tree';
      core.debug(`[same-org] Verifying ${urlKind} ${filePath} at ref ${ref} in ${repoOwner}/${repoName}`);

      try {
        const content = await octokit.rest.repos.getContent({
          owner: repoOwner,
          repo: repoName,
          path: filePath,
          ref,
        });
        core.debug(`[same-org] File ${filePath} found in ${repoOwner}/${repoName}`);

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
