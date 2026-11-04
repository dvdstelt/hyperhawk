import * as glob from '@actions/glob';
import * as path from 'path';

/**
 * Find the files to scan outside a pull request. Patterns are relative to
 * repoRoot. A pattern that starts with ! excludes files.
 */
export async function globFiles(patterns: string[], repoRoot: string): Promise<string[]> {
  const excludePatterns = [
    '!**/node_modules/**',
    '!**/.git/**',
    '!**/dist/**',
    '!**/lib/**',
  ];

  // The ! must stay in front of the absolute path. Exclusions go after all
  // includes, because in @actions/glob the last matching pattern wins.
  const includes = patterns.filter(p => !p.startsWith('!'));
  const excludes = patterns.filter(p => p.startsWith('!'));
  const globPatterns = [
    ...includes.map(p => path.join(repoRoot, p)),
    ...excludes.map(p => '!' + path.join(repoRoot, p.slice(1))),
    ...excludePatterns,
  ];

  const globber = await glob.create(globPatterns.join('\n'));
  return globber.glob();
}
