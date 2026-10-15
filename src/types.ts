export type LinkType = 'internal' | 'same-org' | 'external';

export interface LinkInfo {
  url: string;
  text: string;
  filePath: string;   // relative to repo root
  line: number;
  lineContent: string; // full source line, needed for suggestions
  type: LinkType;
}

export interface CheckResult {
  link: LinkInfo;
  ok: boolean;
  statusCode?: number;
  error?: string;
  suggestion?: string;       // replacement line content (for GitHub suggestion blocks)
  correctedUrl?: string;     // corrected URL alone, used in annotation messages and comment text
  isFuzzyMatch?: boolean;    // true when correctedUrl is the closest match, not the exact target
  candidates?: string[];     // root-relative paths that tie as the best match (no single suggestion)
  anchorMissing?: boolean;   // true when the file exists but the heading in the anchor does not (does not fail strict mode)
  suggestionOnly?: boolean;  // true when link is valid but a root-relative conversion is suggested
}

export interface Config {
  token: string;
  repoRoot: string;
  owner: string;
  repo: string;
  strict: boolean;
  checkExternal: boolean;
  checkSameOrg: boolean;
  checkRelative: boolean;
  checkAnchors: boolean;
  relativeSuggestionDepth: number;
  ignorePatterns: RegExp[];
  timeout: number;
  filePatterns: string[];
  concurrency: number;
  skipCodeBlocks: boolean;
  reportOnlyChanged: boolean;
}
