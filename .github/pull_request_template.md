## What this changes

<!-- One paragraph. Link the issue if there is one. -->

## How it was verified

<!-- Commands you ran and what passed. Name the platform and the CLI/SDK versions for anything that touched a provider. -->

- [ ] `npm run lint`
- [ ] `npm run compile`
- [ ] `npm test`
- [ ] Integration cases (`npm run test:integration -- --fixtures=… --work=…`)
- [ ] Tried by hand in an Extension Development Host or an installed VSIX

## What is not verified

<!-- Be explicit. "Not tested on macOS" is useful; silence is not. -->

## Checklist

- [ ] No credential reading, storing or forwarding was added
- [ ] No write or command runs without an explicit permission request
- [ ] Automated tests send no provider request
- [ ] Documentation updated in this pull request (README, guide, changelog)
