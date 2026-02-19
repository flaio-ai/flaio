# Changesets

This project uses [Changesets](https://github.com/changesets/changesets) to manage versioning and npm releases.

## Adding a changeset

When you make a change that should be included in the next release, run:

```sh
npx changeset
```

This will prompt you to:
1. Select the package (`agent-manager`)
2. Choose the semver bump type (patch / minor / major)
3. Write a summary of the change

A markdown file will be created in this directory. Commit it along with your changes.

## How releases work

When changesets are merged to `main`, the CI creates a **"Version Packages"** PR that bumps versions and updates the changelog. Merging that PR triggers `npm publish`.
