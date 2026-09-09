# Working with `reviews`

For coding agents in a repository that uses the `review-ledger` module. Point your own agent instructions at this file.

`reviews` records who read which version of which file. `REVIEWS.md` reports what is left. Every entry names a person who actually looked; an entry for a reading that did not happen destroys the point of the record.

## Rules for an agent

**Only record what the person tells you they read.** *"I've carefully reviewed foo.txt"* is something you can transcribe: run `reviews record` for them, match the level they describe, and say back what you recorded. Never decide for them that a file has been reviewed — not because you read it, not because you wrote it, not because it looks right.

**Reading a file is not reviewing it.** You will read many files to do your work. The tool cannot record that. It exists to say a person looked.

**Directing the work is not reviewing it.** Someone can approve an approach, choose between options and tell you to fix anything wrong without ever opening the file. Record what they say about files they read.

**Evidence is the person's.** A formal review names a file that records it. You may draft that file, but the person has to say in writing that they accept it, and that file is declared `human`.

## Declaring origins

`reviews declare` is yours to run without being asked. An origin says where a file's content came from — a checkable fact, not a claim about anyone's attention.

- `vendor` — copied in unaltered
- `generated` — produced by a program
- `human` — written by a person by hand
- `authored` — written for this repository (the default)

Declare a file as soon as it lands. Undeclared, a vendored file shows as ❌, which reads as *nobody has reviewed this* when the truth is *nobody here should*.

```
make reviews -- declare Makefile vendor
make reviews -- declare REVIEWS.md generated
```

Declare this module's own two files too. Their origins are the same in every repository; only the directory name changes, following the name you required the module under.

```
make reviews -- declare .review-ledger/.gitignore vendor
make reviews -- declare .review-ledger/reviews.jsonl generated
```

Declaring `authored` on an undeclared file does nothing — that is already its origin. On a file declared `vendor` it is a real correction: an edited vendor file is no longer a copy, and saying so ends its exemption from review.

## Reporting

After writing or editing files, run `reviews show --stale` and say which of them nobody has read.

A count of ❌ is never a reason to wait. Unread work can be committed and pushed honestly, because the report travels in the same commit and names those files. What is not honest is a report that disagrees with the commit carrying it. So when a commit comes into view, offer to regenerate the report.

## Running it

```
make reviews -- show --stale
```

The bare `--` is needed; everything after it reaches the command.

If `reviews` refuses because the log is ignored by git, run `reviews track`. That fixes it.

If the `reviews` target does not exist, add this line to `repro-config`:

```make
-include .review-ledger/host-makefile
```

That is yours to add. Use `-include`, not `include`: the trim directory does not exist until the REPRO has started once, so `include` fails on a fresh clone.

See <https://github.com/CIRSS/review-ledger> for the rest.
