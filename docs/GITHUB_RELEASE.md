# Publish the standalone source from macOS

This adds only the standalone MCP package to the selected repository. It does
not copy the iOS app, the parent repository's Git history, Firebase
configuration, uploads, databases, or task data.

## Enable private vulnerability reporting

Before inviting reports or announcing the repository, open:

**GitHub repository → Settings → Security → Code security and analysis →
Private vulnerability reporting → Enable**

After enabling it, verify that the repository's **Security** tab offers
**Report a vulnerability**. Until then, no private report form exists. If
GitHub does not offer the setting, add a private maintainer contact method to
`SECURITY.md` before inviting security reports.

## Add the package to the empty repository

Download the standalone source archive supplied with this release preparation.
It contains package files at its root. On a Mac with Node 22.13 or later:

```sh
node --version
git clone https://github.com/anuragatmakuri/cleartask.git cleartask
cd cleartask
unzip -o ~/Downloads/cleartask-mcp-source.zip -d .
```

Review `git status --short` and `git diff -- LICENSE`. The package license is
MIT and applies only to this MCP project. Confirm the copyright attribution is
the one you want before committing.

Run the package checks from this clean clone:

```sh
npm ci
npm run check
npm test
npm audit --omit=dev
npm pack --dry-run
```

The standalone test run skips app-source parity tests because the iOS app is
deliberately absent. All independent tests should pass. Inspect the package
contents printed by `npm pack --dry-run`; they should not contain the MCP test
suite, scripts, development files, Firebase configuration, app source, or
private data.

Stage only the extracted standalone source, inspect it, then push:

```sh
git add .gitignore CHANGELOG.md CONTRIBUTING.md LICENSE README.md SECURITY.md \
  package.json package-lock.json src test scripts docs examples
git status --short
git diff --cached --stat
git commit -m "Add standalone ClearTask MCP"
git push -u origin HEAD
```

Do not add or push a checkout of the original app repository.

## Publish the npm package separately

The package is named `@cleartask/mcp`. Its availability in the registry does not
give an account permission to publish under the `@cleartask` scope. Sign in to
the npm account that controls that scope, then check:

```sh
npm login
npm whoami
npm view @cleartask/mcp
```

If the scope is not controlled by that account, create or join the appropriate
npm organization or choose a name under a scope you control. Do not publish
until `npm whoami` shows the intended publisher and the scope is authorized.
From the standalone repository root, publish only after reviewing the package
contents and running the checks above:

```sh
npm publish --access public
```

The GitHub push and npm publication are separate actions. The npm lookup can
return 404 for an unpublished name; that alone does not reserve the name or
confirm scope access.
