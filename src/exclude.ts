import * as core from '@actions/core';
import minimatch from 'minimatch';
import { parse as parseYaml } from 'yaml';
import { Config, ExcludableFeature } from './types';

const EXCLUDABLE_FEATURES: readonly ExcludableFeature[] = ['suggest-local-path'];

/**
 * Parse the exclude input: YAML that maps a feature to the glob patterns of
 * the files where that feature is off. A single pattern can be given as a
 * string instead of a list. Invalid YAML, unknown features, and values that
 * are not patterns give a warning and are ignored.
 */
export function parseExclude(raw: string): Config['exclude'] {
  const exclude: Config['exclude'] = {};
  if (!raw.trim()) return exclude;

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
    core.warning(
      `Ignoring the exclude input because it is not valid YAML: ${reason}. ` +
      `Quote patterns that start with *, for example '**/drafts/**'.`
    );
    return exclude;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    core.warning('Ignoring the exclude input because it is not a map from feature to file patterns.');
    return exclude;
  }

  for (const [feature, value] of Object.entries(parsed)) {
    if (!EXCLUDABLE_FEATURES.includes(feature as ExcludableFeature)) {
      core.warning(`Ignoring unknown feature "${feature}" in exclude. Supported features: ${EXCLUDABLE_FEATURES.join(', ')}.`);
      continue;
    }
    const patterns: unknown = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(patterns) || !patterns.every(p => typeof p === 'string')) {
      core.warning(`Ignoring exclude.${feature} because it is not a list of file patterns.`);
      continue;
    }
    exclude[feature as ExcludableFeature] = patterns;
  }

  return exclude;
}

/**
 * Return true when the exclude input turns off the feature for the file.
 * filePath is relative to the repository root.
 */
export function isExcluded(config: Config, feature: ExcludableFeature, filePath: string): boolean {
  // dot: true so that patterns such as **/*.md also match files in .github/
  return (config.exclude[feature] ?? []).some(pattern => minimatch(filePath, pattern, { dot: true }));
}
