# Release process

Approved. The steps for each release of the npm package `clank-talk`. A human runs the publish; agents do not publish to npm.

## Steps

1. Run `npm test`. All tests must pass.
2. Set the version in `package.json`. The code reads it from there (`VERSION` in `src/js/clank-talk.js`, and the MCP server info).
3. If the minor version changes, change `clank-talk@0.x` in `README.md`, `docs/index.md` and `docs/docs.md`.
4. Do a security review of the changes since the last release. Look most at hooks, paths, git, taint and policies. Fix what it finds, with a test for each finding.
5. Run `npm run package-test`. It packs the package, installs it in an empty folder, and runs the CLI and the MCP server from it. It publishes nothing.
6. Before the first public push of new history, check the history for secrets: `.env` files and key formats.
7. Deploy the site, because the README and the install steps link to it.
8. The human runs `npm whoami`, then `npm publish`.
9. Tag the release, `v<version>`, and push the tag.

## Why

- The package test found a wrong version in the MCP server info for 0.1.0, and the security review found four ways to get past a folder hook. See [hooks.md](../features/hooks.md).
- npm does not let a version be published twice, so a mistake costs a new version.

## Not done

- A changelog.
- The VS Code extension has its own version and release.

## Site mirror

- Approved (built, 2026-11-11): the site has a mirror at https://clanktalk.github.io/, for networks that filter the `.talk` domain. `site.yml` builds `_site` once, uploads it to Pages for `clank.talk`, then force-pushes the same files (with `.nojekyll`) to `main` of `clanktalk/clanktalk.github.io`, with the `MIRROR_TOKEN` secret (a fine-grained token with Contents write on that repo only). With no secret, the step does nothing. Each page has `<link rel="canonical" href="https://clank.talk/...">`, so search engines treat the mirror as a copy. Why: GitHub Pages gives a repo one custom domain, and `bigskysoftware.github.io/clank-talk` redirects to `clank.talk`. Rejected: a second domain on the same repo (not possible), and a redirect only (a filter blocks the target too). The checkout has `persist-credentials: false`, so the GITHUB_TOKEN does not reach the mirror push.