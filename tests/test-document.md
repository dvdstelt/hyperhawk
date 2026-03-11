# Test Document

This document exists to test HyperHawk. It contains intentional broken links.

## Fuzzy Matches (typos in filename)

Make sure you have read the [README](../READM.md) before proceeding.

Also check the [license](../LICENS.md) for usage terms.

Here is a link to the [release script](../release.ps) which has a typo in the extension.

Check the [TypeScript config](../tsconfig.jso) for compiler settings.

The [action definition](../action.ym) describes all inputs and outputs.

## Fuzzy Match with Anchor

See the [README troubleshooting section](../READM.md#troubleshooting) with a typo and anchor.

## Broken (no match exists)

Follow the [setup guide](../docs/setup-guide.md) for detailed instructions.

For troubleshooting, see the [FAQ](../../faq/common-issues.md).

See the [contribution guide](../CONTRIBUTING.md) for how to contribute.

## Multiple Links on One Line (should produce one merged suggestion)

Read the [README](../READM.md) and the [license](../LICENS.md) before starting.

## Same-folder Link (should NOT get root-relative suggestion)

You can also refer to the [configuration reference](./configuration.md) for all available options.

See the [placeholder](./placeholder.md) for an existing same-folder link.

## Root-relative Candidates (valid but relative)

Look at the [agents guide](../AGENTS.md) for coding conventions.

The [action config](../action.yml) has all the inputs documented.

## Skipped Links (should not be checked)

Contact us at [email](mailto:user@domain.net) for support.

See the [docs](https://...) for more information.

## Self-repo URLs (should suggest local path)

The [README](https://github.com/dvdstelt/hyperhawk/blob/main/README.md) can be a local link.

See the [test document](https://github.com/dvdstelt/hyperhawk/blob/main/tests/test-document.md) which is in the same folder.

The [missing file](https://github.com/dvdstelt/hyperhawk/blob/main/does-not-exist.md) should be reported as broken.

The [configuration guide](https://github.com/dvdstelt/hyperhawk/blob/main/docs/configuraton.md) has a typo and should fuzzy-match to the real file.

## External Links (verified when external checking is enabled)

Thanks to [@dvdstelt](https://github.com/dvdstelt) for the contribution.
