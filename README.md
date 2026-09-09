# review-ledger

A [REPRO](https://github.com/repros-dev) capability module for keeping a person in control of code they did not write. One program so far, `reviews`; the module is shaped for more.

## Programs

### `reviews`

Records which files a person has reviewed, how closely, and reports what has changed since.

```
reviews record <path>...             record a cursory review of files as they stand
    --careful                        record a careful review instead
    --formal --evidence <artifact>   record a formal one; it must name its record
    --evidence <artifact>            name what records the review
    --by NAME                        credit someone other than yourself
reviews declare <path> <origin>      authored | generated | vendor | human
reviews show                         the report
    --stale                          only the files that want a reviewer
reviews track                        make the log visible to git
```

### Review types

Reviews vary in degree of care and formality.  This tool distinguishes three successive levels of attention paid to the contents of each file.  The iconography employed in review reports indicates these levels:

```
👀        cursory   file eyeballed. No claim that it is correct
👀 ✅     careful   file read through and judged likely correct by the reader
👀 ✅ 🔬  formal    file inspected via a defined protocol, and the review names
                    the artifact recording its conclusion
```

Files that currently need at least a minimal review of their current contents are indicated by these icons:

```
   ⚠️     reviewed earlier; changed since
   ❌     no review recorded
```

Files not requiring review in a particular repository are indicated as follows:

```
⚙️           vendored files unreviewed; not ours to review
🛠️           generated files unreviewed; review the generator
✍️     🟢    written by a person; reviewed by definition
```

The first three columns record what somebody did. 🟢 is the exception: it says a file needs no attention because a person wrote it, not because anyone read it.

Reviewing a ⚙️ or 🛠️ file anyway keeps its origin — the review's icons appear beside it, not in place of it, since reading a file does not make it ours.

Reading one turns the circle into a check — 👀 ✅, with ✍️ still in front. A cursory review counts as careful here: the file was clear before anyone looked, so a glance is not what makes it so. Editing one puts the circle back; a file a person writes never wants re-reading, so it does not go ⚠️ and does not appear under `--stale`.

A report summary section serves as a heads-up of reviews currently needed.

### Evidence

`--evidence` names a file in this repository that records the review. It is optional at `cursory` and `careful`, and required at `formal`.

The artifact is a person's record of what they did. Evidence an agent wrote is not evidence: a formal review would then rest on the same thing it exists to check. Declaring it `human` says so.

It may still rest on an agent's work, as long as a person says so in it:

```
Reviewed and approved the agent-authored review in
[agent-reviews/review-2026-11-05.md](agent-reviews/review-2026-11-05.md).
```

That sentence is the point. An agent's review can be relied on; nobody's reliance on it should be silent.

The artifact is pinned by hash, so it names the version that existed when the review was recorded. It must be a file git carries. It can be as small as a sentence and a link; this tool does not follow links.

The report names the artifact at the end of the reviewing file's row:

```
👀 ✅ 🔬  exports/reviews  A Person  unchanged since a1b2c3d, per inspection.md
```

The artifact is not itself judged there — an inspection record is written by the person inspecting, so nobody having reviewed it is the ordinary case.

If the artifact is deleted, or the version pinned leaves the object store, the review falls back to `careful` and the row stops naming it. A formal review is one that names the record of itself, so a review whose record has gone no longer is one. The log still holds what was claimed at the time.

### What a review is recorded against

The git blob: the object holding exactly the bytes reviewed. A blob exists as soon as the file does, so a review can be recorded before the file is committed.

No commit is stored. The report resolves the blob to a commit each time it runs, so a review recorded before a commit starts naming that commit once it lands, and stops naming one an amend or rebase has orphaned.

A file edited after review is not reported as unreviewed. The report says how far it has moved.

### Who reviewed it

Taken from `--by`, else `REVIEWS_BY`, else `git config user.name`. A container has no git identity of its own, so a `repro-config` can carry the host's in:

```make
REPRO_DOCKER_OPTIONS = --env REVIEWS_BY="$(shell git config user.name)"
```

### The report

`reviews show` writes a table at a terminal and Markdown when redirected. Dates are UTC.

## In a consuming repository

```
.review-ledger/reviews.jsonl    the log — append-only, written only by reviews
REVIEWS.md                      the report — generated
```

The log is the only file anyone touches, through `reviews record` and `reviews declare`. Everything else is derived from it and from git.

The report describes only the present, and can afford to because the log holds the past — so a log git never sees is a record nobody else will ever read, and the loss surfaces at the first fresh clone, when it is already gone. `record` and `declare` stop when the log is ignored, naming the pattern responsible. At a terminal they offer to fix it; anywhere else — under make, in a script, in CI — they refuse and say what to run, since a question nobody can answer is worse than a message. `reviews track` writes the exception and verifies it took. It never stages anything: what goes into a commit is the committer's to choose.

`REVIEWS_LOG` sets where the log is kept. This module's `exports/base-setup` sets it for every consuming REPRO, derived from the name the consumer required the module under — so a consumer neither declares it nor should, a hardcoded path pinning the repository to a module name it would otherwise follow automatically. Unset entirely, the log is `.review-ledger/reviews.jsonl`.

Records are one JSON object per line:

```jsonl
{"kind":"review","path":"exports/reviews","blob":"cc0cc52","by":"A Person","date":"2026-08-29","type":"careful"}
{"kind":"origin","path":"Makefile","origin":"framework"}
```

A correction is a new record, not an edit. A record with no `type` predates review types, and the report says *type not recorded* rather than assuming the weakest.

Reviews and origin declarations both follow a file across renames.

## Requiring the module

```
repro.require review-ledger main ${CIRSS}
```

**The consuming REPRO must provide Node.** `repro.require` copies programs, not runtimes, and the REPRO base image has none. Any repository with a JavaScript test suite already satisfies this.

Two profiles beyond the base:

```
--report    adds make build-reports, writing the report to ${REVIEWS_REPORT}
--code      adds make test-code, for a repository running Mocha
```

Add one line to the consuming REPRO's `repro-config`:

```make
-include .review-ledger/host-makefile
```

This is part of adopting the module rather than an extra. It provides `make reviews`, and `.review-ledger/agents.md` — delivered to every consumer whether or not the line is present — tells agents to run it; without the include every command in those instructions fails with `No rule to make target 'reviews'`.

`-include`, not `include`: the trim directory is written when the REPRO starts, so a fresh clone has to be able to build without it.

**Upgrading.** `make build-image` will not pick up a new version of the module: `repro.require` runs in a cached layer, and nothing reports the miss. Use `make rebuild-image`, then `make reset-repro` — an existing trim file is not replaced either. A repository that already has a `REVIEW.md` should `git mv REVIEW.md REVIEWS.md`, or the old one stays behind, stale.

`REVIEWS_REPORT` defaults to `REVIEWS.md` at the root of the consuming REPRO and can be overridden with `repro.env`. `REVIEWS_LOG` and `REVIEWS_BY` are not declared: the log belongs to whichever repository the command runs in, and the reviewer to the session.

## Instructions for agents

`exports/agents.md` states the workflow the tool assumes and how a coding agent should behave in a repository that uses it — chiefly that recording a review is a person's act, and that an agent reading a file is not one. It is delivered to `.review-ledger/agents.md`, so a consuming project's own agent instructions can point at it in a line and add whatever else that project needs.

Like everything else in the trim directory it arrives at the first session start, and a later version of it does not replace a copy already there.

## Build and test

```
make build-parent
make build-image
make test-code
make build-reports     rewrite REVIEWS.md and show who has reviewed what
```

`build-reports` comes from the `--report` profile, so every consuming REPRO has it. `repro-config` here also names it `update-reviews`.

## Running it from the host

```
make reviews -- show                               the report
make reviews -- show --stale                       only what wants a reviewer
make reviews -- record --careful exports/reviews   record a review
```

Everything after `--` reaches the command. The `--` is needed because make claims any argument beginning with a dash as one of its own options, and would reject `--careful` before the recipe ran.

Each invocation starts a fresh container from the current image, so a rebuild takes effect immediately. A long-running session does not: it keeps the tool it started with, and a review recorded there is written by that older copy into a log that is append-only.

No arguments prints the usage. The reviewer comes from `REVIEWS_BY`, so no `--by` is needed, and the command's exit status is make's.
