# Native Copilot marketplace

The private `MKITConsulting/zensu-copilot` repository publishes the `zensu`
marketplace on its generated `marketplace` branch. It uses Copilot's native
`.github/plugin/marketplace.json` and the existing Agent Plugins 1.0 package.
There is no source-host adapter or runtime transformation.

## Install and update

```bash
copilot plugin marketplace add MKITConsulting/zensu-copilot#marketplace
copilot plugin marketplace browse zensu
copilot plugin install zensu@zensu
```

The GitHub account used by Copilot must have access to the private repository.
If authentication fails, sign in with `/login` in Copilot and retry. The
`#marketplace` suffix is required: `main` contains the source and publisher,
while `marketplace` contains the installable catalog and package.

```bash
copilot plugin marketplace update zensu
copilot plugin update zensu@zensu
```

Restart Copilot after an update. User-added marketplaces do not enable automatic
session-start updates by default; users may opt in through their Copilot user
settings. Publishing a release makes it available, but does not change that
preference. See the [official CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference).

Remove an existing direct Zensu installation before adding the marketplace
installation, using its name from `copilot plugin list --json`. Never load a
second Zensu installation through `--plugin-dir` at the same time. Use a fresh
session after migration; existing workflow state is not deleted. For an
in-place runtime update in an existing session, follow `/zensu-adopt-session`
and explicitly confirm the verified replacement when prompted.

For a fixed catalog, register an immutable distribution tag instead:

```bash
copilot plugin marketplace add MKITConsulting/zensu-copilot#marketplace/v0.2.0
copilot plugin install zensu@zensu
```

Both sources declare the same marketplace name, `zensu`; choose one source per
Copilot configuration. Updating a fixed catalog does not move it to a newer
release.

## Release publication

1. Update the package and native plugin versions together and add
   `docs/releases/vX.Y.Z.md`. Merge the reviewed source into `main`.
2. Push `vX.Y.Z` on that merged source. The existing release workflow verifies
   the version, source ancestry, complete native package and integration tests,
   then publishes the archive, build receipt and checksums.
3. After successful release creation, the release workflow calls the reusable
   `marketplace.yml` workflow directly. This is necessary because a release
   created with `GITHUB_TOKEN` does not start another `release: published` run.
4. The publisher downloads the published assets, checks both SHA-256 checksums,
   rejects unsafe archive members and verifies every file against the identical
   inner/outer build receipt. It copies those released bytes without rebuilding.
5. A package commit records `plugins/zensu`. The following catalog commit pins
   its native GitHub source to that package commit's full SHA and records the
   release tag, source commit and asset checksums in `publication.json`.
6. One atomic, non-force push advances `marketplace` and creates
   `marketplace/vX.Y.Z`. Consumers can only see a complete catalog/package pair.
   Old package commits and version tags remain available.

Only stable releases whose source commit is reachable from `main` are accepted.
Drafts, prereleases, version rollback and changed content under an existing
version are rejected. All publications share one concurrency group; a Git
non-fast-forward rejection also prevents a competing publisher from overwriting
newer state. An identical retry of the current release is a no-op. If multiple
releases are queued, a skipped older run must not be used to roll back the
catalog; publish the newest stable release instead.

No commits are generated on `main`, and neither the immutable historical source
snapshot nor an existing source tag is changed. GitHub Actions needs only the
repository's `contents: write` token for publication. Node.js is used by the
existing build; Python 3 and Git are used by the distribution tooling.

## Bootstrap or retry an existing release

After the workflow is merged, run:

```bash
gh workflow run marketplace.yml --repo MKITConsulting/zensu-copilot \
  --ref main -f release_tag=v0.2.0
```

This publishes the actual existing release assets, including when the release
predates the marketplace tooling. It does not rebuild that version from current
`main`. If publication failed after GitHub release creation, rerun the failed
marketplace job or dispatch this workflow with the same release tag. Do not
rerun release creation or move the source tag.

For local inspection without publishing, download all three release assets and
run `scripts/publish-marketplace.py` with `--assets`, `--tag`, `--source-sha`
and a new `--work-dir`. It prepares commits locally; only `--push` writes remote
refs. The workflow always verifies the release state and source ancestry first.

## Validation boundaries

`npm run test:marketplace` uses synthetic archives and temporary bare Git
repositories. It verifies exact bytes, executable mode, immutable pins,
idempotence, upgrades, rollback/mutation rejection, malformed archives and an
atomic push rejection. These checks do not claim a live Copilot installation.

A live distribution check must separately register the actual private GitHub
marketplace in an isolated `COPILOT_HOME`/`COPILOT_CACHE_HOME`, install
`zensu@zensu`, compare the installed build receipt and every package hash, and
exercise catalog/plugin updates. Such a check validates distribution, not a new
end-to-end execution of all Zensu workflows.
