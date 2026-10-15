import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import * as glob from '@actions/glob';
import minimatch from 'minimatch';
import * as path from 'path';
import { Config } from './types';
import { extractLinks, filterIgnored } from './extract';
import { checkLinks } from './check';
import { report } from './report';

async function getChangedMdFiles(octokit: ReturnType<typeof getOctokit>): Promise<string[]> {
  const pr = context.payload.pull_request!;
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const pullNumber = pr.number as number;

  const filesResponse = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  return filesResponse.data
    .filter((f: { status: string; filename: string }) => f.status !== 'removed')
    .filter((f: { filename: string }) => /\.(md|mdx)$/i.test(f.filename))
    .map((f: { filename: string }) => f.filename);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../package.json') as { version: string };

async function run(): Promise<void> {
  try {
    const banner = [
      '                           :^!7?J55PPPP55YJ?7!~^:',
      '                           :^~!7?J5B&@@@@@@@@@@&#G5J7^:',
      '                    :^!?YPGB#&&&&@&&@@@@@@@@@@@@@@@@@&#PJ!:',
      '           :~7?JY5GB&&&&&##&@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@#57!^',
      '           :^~!7??777?J5GB&&@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@&&5!:',
      '                :~?PB&@@@@@@@@@&#BGPPPPG#@@@@@@@@@@@@@@@@&BB&&&@@#7:',
      '              :!5#@@@@&#BGP5YYJ??7!~^^::^!JP#&@@&&&@@&&@&#@B55GYB#&P^',
      '            :?G&@@&&#GPYJ7!~~~^^::..........^!?J55YYPG55BGPB7^!777?#~',
      '          ^Y&@@&#BG5?!!!~~^^^^^:::....^:^JY^....::::::~^^7!~^Y#@@&G5!:',
      '        ^5&&GY5B#PJ?777777777777!!!~::J:PB7..^?^...........^5B#&&@@@#5!:',
      '      :?G5!:7GBY7!!!!!777777777777777^77?B#GG#P^.........:~5BBG5JPB5G#@B?:',
      '     ^?7: ^P#Y!!!!777!!!!7777777777777~~!!?JJ7^:::~~^^:^~7JBBJ~~7YYPPPG#@B~',
      '     ::..?#B55Y?7!~~~^~~!!77777777777??7!~^:....^!7777??JYGBBP5555PPPPPPG&&!',
      '        Y@@GY?7~^^~!!7777777777777!~~~~^^::^^^^~?Y5PGGBBBBBBP5PPPGPPPPPPPP&&^',
      '       Y@&57!^^~7777777777!777777777!^:..7P5J??J????????JJ55YYJJY5555PPPPPP@Y',
      '      J@B?!^:!777777!~~~~~~!!!!!77777!!^:~?JJJJJ?!~:........^~!7?77???J5PPPBB',
      '     7@G7^.^77777!~~!77777!!~^^^^:::^^^~^^:::^~7J5PGPY7^..7PPY!::::^^!??YPPGB:',
      '    :#G~:.7J777!!?5BGY?7!~^^::::::.::::::::.......:~?YYJ?JYJ7~:.....:^^77YPB5',
      '    JB~..YP777?5G@@P?7~~^^~~~~^^::::...............~YGGPPPPGY~!~..:7Y?^:??PB!',
      '   :B!.:PG77?5Y?GBJ7!~~~!!!~^^~~^::.............^?G#GJ!^^:^?PJ^?!JGBP?:.7?GJ',
      '   !J..Y&?7JJ^~BG77!~!7777!!77~:..:.::........~YBB5?^:!55~:!!!!5BB57^:..!YJ',
      '   !:.^&Y77~.~&G77777777777?!:::^^^^:.......^5BGJ!:...~JPGP55GBPJ!^7:..:J!',
      '   :..JB7~:.^#G7777777?777?!^~!~~~~^..::....P#5~.......^~!?JJ?7~^!YG7..~^',
      '      PY^...PB777!~7??!!77!!77~~~~~:.:^:...:PGY:....^JP5?!:.....^!JJ~',
      '     :P^...!&?7!~~7?7^:77777?7!!~^^.^!^.....~YPPYJJ5BG5?~:.::',
      '     ^!....55!~~~!~!:.^?7777777~:^~^7!:......^!JY55Y?!^....:^',
      '          :5!~~^^:::..~??^~?7?7^.^~7?~:..^:.....::::......::~^',
      '          ^!~~:.......^?7.:??7~^.:~!?!:.:~~:.............::^~~~:',
      '          ~!~:........:7!..~?!::..:~7!^..^~~:..........::^..:~~~^:',
      '         :~~...........^~...!7.....:~!~..:^~~^:..:.....:^~:...:^~~^:',
      '         :^.............:....~:.....:^~^..:^~~~:^^......^~^......:::',
      '                              :.......:^:...:~~~~:......:^~:',
      '                                              :^^.........::',
    ];
    banner.forEach(line => core.info(line));
    core.info(`HyperHawk v${version}`);
    // Load config
    const token = core.getInput('token', { required: true });
    const filesInput = core.getInput('files') || '**/*.md,**/*.mdx';
    const checkExternal = core.getInput('check-external') !== 'false';
    const checkSameOrg = core.getInput('check-same-org') !== 'false';
    const checkRelative = core.getInput('check-relative') !== 'false';
    const checkAnchors = core.getInput('check-anchors') !== 'false';
    const relativeSuggestionDepth = parseRelativeSuggestionDepth(core.getInput('relative-suggestion-depth'));
    const ignorePatternsInput = core.getInput('ignore-patterns');
    const timeout = parseInt(core.getInput('timeout') || '10000', 10);
    const concurrency = parseInt(core.getInput('concurrency') || '5', 10);
    // strict: check both input and LINK_CHECK_STRICT env var
    const strictInput = core.getInput('strict');
    const strictEnv = process.env['LINK_CHECK_STRICT'];
    const strict = strictInput === 'true' || strictEnv === 'true';
    const skipCodeBlocks = core.getInput('skip-code-blocks') === 'true';
    const reportOnlyChanged = core.getInput('report-only-changed') === 'true';

    const repoRoot = process.env['GITHUB_WORKSPACE'] || process.cwd();
    const [owner, repo] = (process.env['GITHUB_REPOSITORY'] || '/').split('/');

    const ignorePatterns: RegExp[] = ignorePatternsInput
      ? ignorePatternsInput.split(',').map(p => new RegExp(p.trim()))
      : [];

    const filePatterns = filesInput.split(',').map(p => p.trim());

    const config: Config = {
      token,
      repoRoot,
      owner,
      repo,
      strict,
      checkExternal,
      checkSameOrg,
      checkRelative,
      checkAnchors,
      relativeSuggestionDepth,
      ignorePatterns,
      timeout,
      filePatterns,
      concurrency,
      skipCodeBlocks,
      reportOnlyChanged,
    };

    const octokit = getOctokit(token);
    const crossRepoTokenInput = core.getInput('cross-repo-token');
    const crossRepoOctokit = crossRepoTokenInput ? getOctokit(crossRepoTokenInput) : undefined;

    // Determine files to scan
    let filesToScan: string[];

    if (context.payload.pull_request) {
      core.info('PR context detected - scanning only changed .md/.mdx files');
      try {
        let changedFiles = await getChangedMdFiles(octokit);
        // Apply include/exclude file patterns so exclusions like !docs/test.md work on PRs too
        changedFiles = changedFiles.filter(f => {
          const included = filePatterns.filter(p => !p.startsWith('!')).some(p => minimatch(f, p));
          const excluded = filePatterns.filter(p => p.startsWith('!')).some(p => minimatch(f, p.slice(1)));
          return included && !excluded;
        });
        filesToScan = changedFiles.map(f => path.join(repoRoot, f));
        core.info(`Changed markdown files: ${filesToScan.length}`);
      } catch (err) {
        core.warning(`Failed to get changed files, falling back to full scan: ${String(err)}`);
        filesToScan = await globFiles(filePatterns, repoRoot);
      }
    } else {
      core.info('Non-PR context - scanning all markdown files');
      filesToScan = await globFiles(filePatterns, repoRoot);
    }

    core.info(`Scanning ${filesToScan.length} file(s)`);

    if (filesToScan.length === 0) {
      core.info('No files to scan');
      return;
    }

    // Extract links from all files
    const allLinks = filesToScan.flatMap(file => {
      try {
        return extractLinks(file, config);
      } catch (err) {
        core.warning(`Failed to extract links from ${file}: ${String(err)}`);
        return [];
      }
    });

    core.info(`Extracted ${allLinks.length} link(s)`);

    // Filter ignored patterns
    const filteredLinks = filterIgnored(allLinks, ignorePatterns);
    const ignored = allLinks.length - filteredLinks.length;
    if (ignored > 0) {
      core.info(`Ignored ${ignored} link(s) matching ignore patterns`);
    }

    core.info(`Checking ${filteredLinks.length} link(s)...`);

    // Check all links
    const results = await checkLinks(filteredLinks, config, octokit, crossRepoOctokit);

    // Report results
    const brokenCount = await report(results, octokit, config);

    // Fail workflow if strict mode
    if (strict && brokenCount > 0) {
      core.setFailed(`HyperHawk found ${brokenCount} broken link(s). Set strict=false to allow failures.`);
    }
  } catch (err) {
    core.setFailed(`HyperHawk encountered an unexpected error: ${String(err)}`);
  }
}

// Relative links deeper than this should be disabled outright via
// check-relative rather than exempted from suggestions one level at a time.
const MAX_RELATIVE_SUGGESTION_DEPTH = 5;

/**
 * Parse and validate the relative-suggestion-depth input. Falls back to 0
 * (only same-folder links exempt) for empty/invalid values, and clamps to
 * MAX_RELATIVE_SUGGESTION_DEPTH with a warning when set too high.
 */
function parseRelativeSuggestionDepth(raw: string): number {
  if (!raw) return 0;
  const value = parseInt(raw, 10);
  if (Number.isNaN(value) || value < 0) {
    core.warning(`Invalid relative-suggestion-depth "${raw}"; falling back to 0.`);
    return 0;
  }
  if (value > MAX_RELATIVE_SUGGESTION_DEPTH) {
    core.warning(
      `relative-suggestion-depth ${value} exceeds the maximum of ${MAX_RELATIVE_SUGGESTION_DEPTH}; ` +
      `clamping to ${MAX_RELATIVE_SUGGESTION_DEPTH}. To skip relative-link checks entirely, set check-relative: false.`
    );
    return MAX_RELATIVE_SUGGESTION_DEPTH;
  }
  return value;
}

async function globFiles(patterns: string[], repoRoot: string): Promise<string[]> {
  const excludePatterns = [
    '!**/node_modules/**',
    '!**/.git/**',
    '!**/dist/**',
    '!**/lib/**',
  ];

  const globPatterns = [
    ...patterns.map(p => path.join(repoRoot, p)),
    ...excludePatterns,
  ];

  const globber = await glob.create(globPatterns.join('\n'));
  return globber.glob();
}

run();
