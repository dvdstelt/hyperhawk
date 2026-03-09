import * as fs from 'fs';
import * as path from 'path';
import { LinkInfo, LinkType, Config } from './types';

/**
 * Classify a URL as internal, same-org, or external.
 */
function classifyUrl(url: string, owner: string): LinkType {
  // Strip leading/trailing whitespace
  url = url.trim();

  // Anchors-only links are internal
  if (url.startsWith('#')) return 'internal';

  // No scheme: relative or absolute path
  if (!url.includes('://') && !url.startsWith('mailto:')) {
    return 'internal';
  }

  // Same-org GitHub links (repo-level and org-level)
  const sameOrgPrefix = `https://github.com/${owner}/`;
  const sameOrgOrgsPrefix = `https://github.com/orgs/${owner}/`;
  if (url.startsWith(sameOrgPrefix) || url.startsWith(sameOrgOrgsPrefix)) {
    return 'same-org';
  }

  return 'external';
}

/**
 * Extract all links from a single markdown file.
 */
export function extractLinks(filePath: string, config: Config): LinkInfo[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const links: LinkInfo[] = [];

  // Collect reference definitions: [ref]: url
  const refDefs = new Map<string, string>();
  const refDefRegex = /^\s*\[([^\]]+)\]:\s*(\S+)/;
  for (const line of lines) {
    const m = refDefRegex.exec(line);
    if (m) {
      refDefs.set(m[1].toLowerCase(), m[2]);
    }
  }

  // Regex patterns
  const inlineRegex = /!?\[([^\]]*)\]\(([^)]+)\)/g;
  const refLinkRegex = /!?\[([^\]]+)\]\[([^\]]*)\]/g;
  const htmlHrefRegex = /(?:href|src)="([^"]+)"/g;
  const autolinkRegex = /<(https?:\/\/[^>]+)>/g;

  for (let i = 0; i < lines.length; i++) {
    const lineContent = lines[i];
    const lineNumber = i + 1;

    // Skip reference definition lines themselves
    if (refDefRegex.test(lineContent)) continue;

    // Inline links: [text](url) and ![alt](url)
    let m: RegExpExecArray | null;
    inlineRegex.lastIndex = 0;
    while ((m = inlineRegex.exec(lineContent)) !== null) {
      const text = m[1];
      // URL may include title: extract just the URL part
      const urlPart = m[2].trim().split(/\s+/)[0];
      if (!urlPart) continue;
      links.push({
        url: urlPart,
        text,
        filePath: path.relative(config.repoRoot, filePath).replace(/\\/g, '/'),
        line: lineNumber,
        lineContent,
        type: classifyUrl(urlPart, config.owner),
      });
    }

    // Reference links: [text][ref]
    refLinkRegex.lastIndex = 0;
    while ((m = refLinkRegex.exec(lineContent)) !== null) {
      const text = m[1];
      const ref = (m[2] || m[1]).toLowerCase();
      const url = refDefs.get(ref);
      if (!url) continue;
      links.push({
        url,
        text,
        filePath: path.relative(config.repoRoot, filePath).replace(/\\/g, '/'),
        line: lineNumber,
        lineContent,
        type: classifyUrl(url, config.owner),
      });
    }

    // HTML href/src attributes
    htmlHrefRegex.lastIndex = 0;
    while ((m = htmlHrefRegex.exec(lineContent)) !== null) {
      const url = m[1];
      if (!url) continue;
      links.push({
        url,
        text: url,
        filePath: path.relative(config.repoRoot, filePath).replace(/\\/g, '/'),
        line: lineNumber,
        lineContent,
        type: classifyUrl(url, config.owner),
      });
    }

    // Autolinks: <https://...>
    autolinkRegex.lastIndex = 0;
    while ((m = autolinkRegex.exec(lineContent)) !== null) {
      const url = m[1];
      links.push({
        url,
        text: url,
        filePath: path.relative(config.repoRoot, filePath).replace(/\\/g, '/'),
        line: lineNumber,
        lineContent,
        type: classifyUrl(url, config.owner),
      });
    }
  }

  // Deduplicate by url+filePath+line
  const seen = new Set<string>();
  return links.filter(link => {
    const key = `${link.filePath}:${link.line}:${link.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Filter links based on ignore patterns.
 */
export function filterIgnored(links: LinkInfo[], ignorePatterns: RegExp[]): LinkInfo[] {
  if (ignorePatterns.length === 0) return links;
  return links.filter(link => !ignorePatterns.some(pattern => pattern.test(link.url)));
}
