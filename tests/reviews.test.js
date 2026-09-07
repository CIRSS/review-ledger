// Runs reviews against throwaway git repositories with real commit histories.

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The log's default home: this module's trim directory in the repository.
const logIn = (dir) => path.join(dir, '.review-ledger', 'reviews.jsonl');

// Builds a repository with one commit per entry of `steps`, each a map of file
// to content. Returns its path.
function repository(steps) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-'));
    const run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

    run(['init', '-q']);
    run(['config', 'user.email', 'test@example.org']);
    run(['config', 'user.name', 'A Person']);

    for (const files of steps) {
        for (const [name, content] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
            fs.writeFileSync(path.join(dir, name), content);
        }
        run(['add', '-A']);
        run(['commit', '-qm', 'step']);
    }
    return dir;
}

// Runs reviews in a repository and returns { exit, stdout, stderr }. stdout is
// not a terminal here, so show emits Markdown.
// REVIEWS_BY is cleared unless a case sets it: the container these tests run in
// carries the host's, and a suite that inherits it tests the developer's shell.
function reviews(dir, args, env = {}) {
    const options = { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, REVIEWS_BY: '', REVIEWS_LOG: '', ...env } };
    try {
        return { exit: 0, stdout: execFileSync('reviews', args, options), stderr: '' };
    } catch (error) {
        return { exit: error.status, stdout: error.stdout || '', stderr: error.stderr || '' };
    }
}

// Runs reviews under a pseudo-terminal, so show takes its terminal branch.
function reviewsAtTerminal(dir, args) {
    const output = execFileSync('script',
        ['-qec', ['reviews', ...args].join(' '), '/dev/null'],
        { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, REVIEWS_LOG: '' } });
    return output.split('\r').join('');
}

const move = (dir, from, to) => {
    execFileSync('git', ['mv', from, to], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'rename'], { cwd: dir });
};

describe('reviews', function () {
    it('reports a file nobody has reviewed as unreviewed', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        const { stdout } = reviews(dir, ['show']);
        assert.match(stdout, /\| ❌ \|[\s|]*`a\.txt`/);
    });

    it('reports a file as current when nothing has changed since the review', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        reviews(dir, ['record', 'a.txt']);
        const { stdout } = reviews(dir, ['show']);
        assert.match(stdout, /\| 👀 \|[\s|]*`a\.txt` \| A Person/);
        assert.match(stdout, /unchanged/);
    });

    it('reports how much has changed since the review', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        reviews(dir, ['record', 'a.txt']);
        fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
        execFileSync('git', ['commit', '-qam', 'grow'], { cwd: dir });
        const { stdout } = reviews(dir, ['show']);
        assert.match(stdout, /\| ⚠️ \|[\s|]*`a\.txt`/);
        assert.match(stdout, /\+2 −0 since/);
    });

    it('measures change that has not been committed yet', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        reviews(dir, ['record', 'a.txt']);
        fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
        const { exit, stdout } = reviews(dir, ['show']);
        assert.strictEqual(exit, 0, stdout);
        assert.match(stdout, /\+1 −0 since/);
    });

    it('names the level of a review that has gone stale', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        reviews(dir, ['record', 'a.txt', '--careful']);
        fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
        execFileSync('git', ['commit', '-qam', 'edit it'], { cwd: dir });
        // A drifted row cannot carry its level in the icons — ⚠️ takes the
        // column ✅ would — so the text is the only place the report can say
        // whether what went stale was a glance or an inspection.
        const line = reviews(dir, ['show']).stdout
            .split('\n').find((l) => l.includes('a.txt'));
        assert.match(line, /since careful review at [0-9a-f]{7}/);
    });

    it('names no commit when what was reviewed is in none', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        fs.writeFileSync(path.join(dir, 'a.txt'), 'edited\n');
        reviews(dir, ['record', 'a.txt']);
        assert.match(reviews(dir, ['show']).stdout, /unchanged since a cursory review/);
    });

    it('stores no commit, so the report cannot cache a stale one', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        reviews(dir, ['record', 'a.txt']);
        const record = JSON.parse(fs.readFileSync(logIn(dir), 'utf8')
            .split('\n')[0]);
        assert.ok(!record.commit, 'a stored commit is an answer that goes stale');
        assert.ok(record.blob, 'the blob is what identifies the reviewed content');
    });

    it('names the commit once content reviewed before it was committed lands', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        fs.writeFileSync(path.join(dir, 'a.txt'), 'edited\n');
        reviews(dir, ['record', 'a.txt']);
        assert.match(reviews(dir, ['show']).stdout, /unchanged since a cursory review/);

        execFileSync('git', ['commit', '-qam', 'land it'], { cwd: dir });
        const head = execFileSync('git', ['rev-parse', 'HEAD'],
            { cwd: dir, encoding: 'utf8' }).trim().slice(0, 7);
        assert.match(reviews(dir, ['show']).stdout,
            new RegExp(`unchanged since cursory review at ${head}`));
    });

    it('stops naming a commit an amend has orphaned', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        reviews(dir, ['record', 'a.txt']);
        const before = execFileSync('git', ['rev-parse', 'HEAD'],
            { cwd: dir, encoding: 'utf8' }).trim().slice(0, 7);
        assert.match(reviews(dir, ['show']).stdout,
            new RegExp(`unchanged since cursory review at ${before}`));

        execFileSync('git', ['commit', '-q', '--amend', '-m', 'reworded'], { cwd: dir });
        const stdout = reviews(dir, ['show']).stdout;
        assert.doesNotMatch(stdout, new RegExp(before),
            'named a commit no longer reachable, which 404s for anyone who cloned');
        const after = execFileSync('git', ['rev-parse', 'HEAD'],
            { cwd: dir, encoding: 'utf8' }).trim().slice(0, 7);
        assert.match(stdout, new RegExp(`unchanged since cursory review at ${after}`));
    });

    it('records a cursory review when no type is given', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        reviews(dir, ['record', 'a.txt']);
        const record = JSON.parse(fs.readFileSync(logIn(dir), 'utf8')
            .split('\n')[0]);
        assert.strictEqual(record.type, 'cursory', 'the cheapest claim must be the weakest');
        assert.match(reviews(dir, ['show']).stdout, /\| 👀 \|[\s|]*`a\.txt`/);
    });

    it('records a careful review when asked for one', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        reviews(dir, ['record', 'a.txt', '--careful']);
        assert.match(reviews(dir, ['show']).stdout, /\| 👀 \| ✅ \|[\s|]*`a\.txt`/);
    });

    it('records a formal review when asked for one', function () {
        const dir = repository([{ 'a.txt': 'one\n', 'record.md': 'what we found\n' }]);
        reviews(dir, ['record', 'a.txt', '--formal', '--evidence', 'record.md']);
        const { stdout } = reviews(dir, ['show']);
        // A formal review is a careful one and more, so it keeps the tick.
        assert.match(stdout, /\| 👀 \| ✅ \| 🔬 \| `a\.txt`/);
        assert.match(stdout, /per record\.md/);
    });

    it('lets a review below formal name its evidence too', function () {
        const dir = repository([{ 'a.txt': 'one\n', 'notes.md': 'what I checked\n' }]);
        const { exit } = reviews(dir,
            ['record', 'a.txt', '--careful', '--evidence', 'notes.md']);
        assert.strictEqual(exit, 0, 'evidence is optional below formal, not forbidden');
        const { stdout } = reviews(dir, ['show']);
        assert.match(stdout, /\| 👀 \| ✅ \|[\s|]*`a\.txt`/);
        assert.match(stdout, /per notes\.md/);
    });

    it('refuses a formal review that names no record of itself', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        const { exit, stderr } = reviews(dir, ['record', 'a.txt', '--formal']);
        assert.strictEqual(exit, 2);
        assert.match(stderr, /a formal review names what records it/);
    });

    it('refuses evidence that is not in the repository', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        const { exit, stderr } = reviews(dir,
            ['record', 'a.txt', '--formal', '--evidence', 'absent.md']);
        assert.strictEqual(exit, 2);
        assert.match(stderr, /no such file: absent\.md/);
    });

    it('pins the evidence to the version that existed at the time', function () {
        const dir = repository([{ 'a.txt': 'one\n', 'record.md': 'what we found\n' }]);
        reviews(dir, ['record', 'a.txt', '--formal', '--evidence', 'record.md']);
        const recorded = JSON.parse(fs.readFileSync(logIn(dir), 'utf8')
            .split('\n')[0]);
        const pinned = execFileSync('git', ['hash-object', 'record.md'],
            { cwd: dir, encoding: 'utf8' }).trim();
        assert.strictEqual(recorded.evidence.path, 'record.md');
        assert.strictEqual(recorded.evidence.blob, pinned);
    });

    it('names the evidence without judging it', function () {
        const dir = repository([{ 'a.txt': 'one\n', 'record.md': 'what we found\n' }]);
        reviews(dir, ['record', 'a.txt', '--formal', '--evidence', 'record.md']);
        // An inspection record is written by the person inspecting, so nobody
        // reviewing it is ordinary and a mark beside it would report a gap
        // where there is none.
        const { stdout } = reviews(dir, ['show']);
        assert.match(stdout, /per record\.md \|/);
        assert.doesNotMatch(stdout, /per record\.md [👀✅🔬❌⚠️]/);
    });

    it('refuses evidence git cannot carry', function () {
        const dir = repository([{ 'a.txt': 'one\n', '.gitignore': 'notes.md\n' }]);
        fs.writeFileSync(path.join(dir, 'notes.md'), 'what I checked\n');
        const { exit, stderr } = reviews(dir,
            ['record', 'a.txt', '--formal', '--evidence', 'notes.md']);
        assert.strictEqual(exit, 2, 'the file is on disk, so existence is not the test');
        assert.match(stderr, /git does not carry notes\.md/);
    });

    it('drops to careful, and says nothing more, when the evidence is gone', function () {
        const dir = repository([{ 'a.txt': 'one\n', 'record.md': 'what we found\n' }]);
        reviews(dir, ['record', 'a.txt', '--formal', '--evidence', 'record.md']);
        execFileSync('git', ['rm', '-q', 'record.md'], { cwd: dir });
        execFileSync('git', ['commit', '-qm', 'drop the record'], { cwd: dir });
        const { stdout } = reviews(dir, ['show']);
        // A formal review is one that names the record of itself, so when the
        // record goes it is a careful review and nothing more is said: the
        // mark has already fallen, and a path to nothing helps nobody.
        assert.match(stdout, /\| 👀 \| ✅ \|[\s|]*`a\.txt`/);
        assert.doesNotMatch(stdout, /🔬/);
        assert.doesNotMatch(stdout, /record\.md/);
        // The prose falls with the mark: naming it formal would assert a level
        // nothing in the repository can still back.
        assert.match(stdout, /since careful review at/);
        assert.doesNotMatch(stdout, /formal review/);
        // The log still holds what was claimed at the time.
        const recorded = JSON.parse(fs.readFileSync(logIn(dir), 'utf8')
            .split('\n')[0]);
        assert.strictEqual(recorded.type, 'formal');
    });

    it('refuses two review types at once', function () {
        const dir = repository([{ 'a.txt': 'one\n', 'record.md': 'what we found\n' }]);
        const { exit, stderr } = reviews(dir,
            ['record', 'a.txt', '--careful', '--formal', '--evidence', 'record.md']);
        assert.strictEqual(exit, 2);
        assert.match(stderr, /one review type/);
    });

    it('shows a review recorded before types as type not recorded', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        const blob = execFileSync('git', ['hash-object', '-w', 'a.txt'],
            { cwd: dir, encoding: 'utf8' }).trim();
        fs.mkdirSync(path.dirname(logIn(dir)), { recursive: true });
        fs.writeFileSync(logIn(dir),
            `${JSON.stringify({ kind: 'review', path: 'a.txt', blob,
                by: 'A Person', date: '2026-08-01' })}\n`);
        const { stdout } = reviews(dir, ['show']);
        assert.match(stdout, /\| ❔ \|[\s|]*`a\.txt`/, 'an absent type is not a cursory claim');
        assert.match(stdout, /type not recorded/);
    });

    it('keeps the terminal columns aligned when an icon is two glyphs', function () {
        const dir = repository([{ 'a.txt': 'one\n', 'b.txt': 'two\n',
            'record.md': 'what we found\n' }]);
        reviews(dir, ['record', 'a.txt', '--formal', '--evidence', 'record.md']);
        reviews(dir, ['record', 'b.txt']);
        const rows = reviewsAtTerminal(dir, ['show']).split('\n')
            .filter((line) => /`?[ab]\.txt/.test(line));
        // Terminal columns are display cells, not string indices: an emoji
        // occupies two cells and may be one or two UTF-16 units, so neither
        // length nor glyph count says where a column starts.
        const cells = (text) => [...new Intl.Segmenter().segment(text)]
            .reduce((n, { segment }) =>
                n + (/\p{Extended_Pictographic}/u.test(segment) ? 2 : 1), 0);
        const columns = rows.map((line) => cells(line.slice(0, line.indexOf('.txt'))));
        assert.strictEqual(new Set(columns).size, 1,
            `file column did not line up:\n${rows.join('\n')}`);
    });

    it('holds the icon columns fixed across views', function () {
        const dir = repository([{ 'a.txt': 'one\n', 'b.txt': 'two\n',
            'record.md': 'what we found\n' }]);
        reviews(dir, ['record', 'a.txt', '--formal', '--evidence', 'record.md']);
        // The three columns mean looked, judged, and done to protocol, so they
        // are structural: a verdict belongs in the same place in every view.
        const rowFor = (args) => reviewsAtTerminal(dir, args)
            .split('\n').find((line) => line.includes('b.txt'));
        assert.strictEqual(rowFor(['show']).indexOf('❌'),
            rowFor(['show', '--stale']).indexOf('❌'),
            'the same file should sit in the same column whichever view lists it');
    });

    it('says what to do when no reviewer can be determined', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        execFileSync('git', ['config', '--unset', 'user.name'], { cwd: dir });
        const { exit, stderr } = reviews(dir, ['record', 'a.txt']);
        assert.strictEqual(exit, 2);
        assert.match(stderr, /pass --by NAME/);
        assert.doesNotMatch(stderr, /Command failed/,
            'git exits non-zero for an unset key; the throw must not reach the reviewer');
    });

    it('takes the reviewer from REVIEWS_BY where git has no identity', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        execFileSync('git', ['config', '--unset', 'user.name'], { cwd: dir });
        const { exit } = reviews(dir, ['record', 'a.txt'], { REVIEWS_BY: 'A Reviewer' });
        assert.strictEqual(exit, 0, 'a container has no git identity; this is the usual path');
        assert.match(reviews(dir, ['show']).stdout, /A Reviewer/);
    });

    it('prefers --by over REVIEWS_BY', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        reviews(dir, ['record', 'a.txt', '--by', 'Named Explicitly'],
            { REVIEWS_BY: 'From The Environment' });
        const { stdout } = reviews(dir, ['show']);
        assert.match(stdout, /Named Explicitly/);
        assert.doesNotMatch(stdout, /From The Environment/);
    });

    it('carries an origin declaration across a rename', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        reviews(dir, ['declare', 'a.txt', 'vendor']);
        move(dir, 'a.txt', 'moved.txt');
        const { stdout } = reviews(dir, ['show']);
        assert.match(stdout, /\| ⚙️ \|[\s|]*`moved\.txt`/);
    });

    it('gives a conflicted file one row, not one per stage', function () {
        const dir = repository([{ 'a.txt': 'base\n' }]);
        const run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
        run(['checkout', '-q', '-b', 'other']);
        fs.writeFileSync(path.join(dir, 'a.txt'), 'theirs\n');
        run(['commit', '-qam', 'theirs']);
        run(['checkout', '-q', '-']);
        fs.writeFileSync(path.join(dir, 'a.txt'), 'ours\n');
        run(['commit', '-qam', 'ours']);
        try {
            run(['merge', '-q', 'other']);
        } catch {
            // the conflict is the point
        }
        const rows = reviews(dir, ['show']).stdout
            .split('\n').filter((line) => line.includes('`a.txt`'));
        assert.strictEqual(rows.length, 1, `expected one row, got:\n${rows.join('\n')}`);
    });

    it('carries a review across a rename', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        reviews(dir, ['record', 'a.txt']);
        move(dir, 'a.txt', 'moved.txt');
        const { stdout } = reviews(dir, ['show']);
        assert.match(stdout, /\| 👀 \|[\s|]*`moved\.txt`/);
    });

    it('records a review of a file that has uncommitted changes', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        fs.writeFileSync(path.join(dir, 'a.txt'), 'edited\n');
        assert.strictEqual(reviews(dir, ['record', 'a.txt']).exit, 0);
        assert.match(reviews(dir, ['show']).stdout, /\| 👀 \|[\s|]*`a\.txt`/);
    });

    it('records a review in a repository with no commits', function () {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-'));
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 'A Person'], { cwd: dir });
        fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
        assert.strictEqual(reviews(dir, ['record', 'a.txt']).exit, 0);
        assert.match(reviews(dir, ['show']).stdout,
            /\| 👀 \|.*`a\.txt`.*since a cursory review/);
    });

    it('refuses to record a review of a file that does not exist', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        const { exit, stderr } = reviews(dir, ['record', 'nope.txt']);
        assert.strictEqual(exit, 2);
        assert.match(stderr, /no such file/);
    });

    it('credits a review to the name given', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        reviews(dir, ['record', 'a.txt', '--by', 'Someone Else']);
        const { stdout } = reviews(dir, ['show']);
        assert.match(stdout, /Someone Else/);
    });

    it('exempts a file declared as vendor', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        reviews(dir, ['declare', 'a.txt', 'vendor']);
        const { stdout } = reviews(dir, ['show']);
        assert.match(stdout, /\| ⚙️ \|[\s|]*`a\.txt`/);
    });

    it('sends a file declared as generated to its generator', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        reviews(dir, ['declare', 'a.txt', 'generated']);
        const { stdout } = reviews(dir, ['show']);
        assert.match(stdout, /\| 🛠️ \|[\s|]*`a\.txt`/);
    });

    it('keeps the origin when someone reviews a vendored file anyway', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        reviews(dir, ['declare', 'a.txt', 'vendor']);
        reviews(dir, ['record', 'a.txt']);
        const { stdout } = reviews(dir, ['show']);
        assert.match(stdout, /\| ⚙️ \| 👀 \|[\s|]*`a\.txt`/,
            'a review must not erase the fact that the file was never ours to review');
    });

    it('counts a reviewed framework file in both tallies', function () {
        const dir = repository([{ 'a.txt': 'one\n', 'b.txt': 'two\n' }]);
        reviews(dir, ['declare', 'a.txt', 'vendor']);
        reviews(dir, ['record', 'a.txt']);
        reviews(dir, ['declare', 'b.txt', 'vendor']);
        const summary = reviews(dir, ['show']).stdout.split('❌ means')[0];
        // Review state and origin are independent, so a file that is both is
        // counted in each; counting it once dropped it from the vendor tally.
        // The origin line shows what is left undone, of how many there are.
        assert.match(summary, /\| ⚙️ \|[\s|]*1 \| of 2 vendored files unreviewed/);
        assert.match(summary, /\| 👀 \|[\s|]*1 \| reviewed cursorily/);
    });

    it('marks a file declared human as clear without a review', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        reviews(dir, ['declare', 'a.txt', 'human']);
        const { stdout } = reviews(dir, ['show']);
        // ✍️ says why no review is wanted; 🟢 says the answer to "does this
        // need attention" is no. Neither is a recorded review, and ✅ would
        // claim one that no record backs.
        assert.match(stdout, /\| ✍️ \|[\s|]*🟢 \|[\s|]*`a\.txt`/);
        assert.doesNotMatch(stdout, /\| ✍️ \|[\s|]*✅/);
        assert.match(stdout, /written by a person; reviewed by definition/);
    });

    it('turns the circle into a check when someone reads a human file', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        reviews(dir, ['declare', 'a.txt', 'human']);

        reviews(dir, ['record', 'a.txt']);
        // 🟢 is clear because a person wrote it; ✅ is clear because a person
        // read it. Reading says the more of the two, so the check takes over
        // and the eyeballs stand in front of it. A glance counts as careful
        // here, so the row and the line counting it show the same marks.
        const glanced = reviews(dir, ['show']).stdout;
        assert.match(glanced, /\| ✍️ \| 👀 \| ✅ \|[\s|]*`a\.txt`/);
        assert.match(glanced, /\|[\s|]*👀 \| ✅ \|[\s|]*1 \| reviewed carefully/);
        assert.doesNotMatch(glanced, /reviewed cursorily/);

        fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
        // Editing a file a person writes does not make it want re-reading, so
        // it falls back to the circle rather than going stale.
        const { stdout } = reviews(dir, ['show']);
        assert.match(stdout, /\| ✍️ \|[\s|]*🟢 \|/);
        assert.doesNotMatch(stdout, /⚠️/);
    });

    it('leaves an edited human file off the list of what wants a reviewer', function () {
        const dir = repository([{ 'a.txt': 'one\n', 'b.txt': 'two\n' }]);
        reviews(dir, ['declare', 'a.txt', 'human']);
        reviews(dir, ['record', 'a.txt', '--careful']);
        fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');

        // --stale asks what wants a reviewer, which is what the verdict column
        // says wants one. A human file shows 🟢 however much it is edited.
        const { stdout } = reviews(dir, ['show', '--stale']);
        assert.doesNotMatch(stdout, /`a\.txt`/);
        assert.match(stdout, /`b\.txt`/);
    });

    it('refuses to record into a log git cannot see', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        fs.writeFileSync(path.join(dir, '.gitignore'), '*.jsonl\n');

        // A log git never sees is a record nobody else will ever read, and the
        // loss shows up at the first fresh clone, when it is already too late.
        const { exit, stderr } = reviews(dir, ['record', 'a.txt']);
        assert.strictEqual(exit, 2);
        // The message names the pattern responsible, so it can be acted on.
        assert.match(stderr, /ignored by \.gitignore:1 \(\*\.jsonl\)/);
        assert.match(stderr, /reviews track/);
        assert.strictEqual(fs.existsSync(logIn(dir)), false);
    });

    it('makes an ignored log visible, and stages nothing', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        fs.writeFileSync(path.join(dir, '.gitignore'), '*.jsonl\n');

        assert.strictEqual(reviews(dir, ['track']).exit, 0);
        assert.strictEqual(reviews(dir, ['record', 'a.txt']).exit, 0);

        // Which files go into a commit is the committer's choice, so track
        // makes the log trackable and leaves the index alone.
        const staged = execFileSync('git', ['diff', '--cached', '--name-only'],
            { cwd: dir, encoding: 'utf8' });
        assert.strictEqual(staged, '');
    });

    it('reaches a log inside a directory git does not descend into', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        fs.writeFileSync(path.join(dir, '.gitignore'), '.*\n!.gitignore\n');
        fs.mkdirSync(path.join(dir, '.mod'));
        fs.writeFileSync(path.join(dir, '.mod', '.gitignore'), '*\n');
        const env = { REVIEWS_LOG: path.join(dir, '.mod', 'reviews.jsonl') };

        // git does not descend into an excluded directory, so a negation for a
        // file inside one is never read. The directory has to be re-included
        // first, and the exception list has to except itself or it is never
        // committed and a fresh clone ignores the log again.
        assert.strictEqual(reviews(dir, ['track'], env).exit, 0);
        assert.strictEqual(reviews(dir, ['record', 'a.txt'], env).exit, 0);

        const listed = execFileSync('git',
            ['ls-files', '--others', '--exclude-standard'], { cwd: dir, encoding: 'utf8' });
        assert.match(listed, /\.mod\/reviews\.jsonl/);
        assert.match(listed, /\.mod\/\.gitignore/);
    });

    it('says a visible log is already visible, and changes nothing', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        const { exit, stdout } = reviews(dir, ['track']);
        assert.strictEqual(exit, 0);
        assert.match(stdout, /already visible/);
        assert.strictEqual(fs.existsSync(path.join(dir, '.gitignore')), false);
    });

    it('refuses an origin it does not define', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        const { exit, stderr } = reviews(dir, ['declare', 'a.txt', 'invented']);
        assert.strictEqual(exit, 2);
        assert.match(stderr, /origin must be one of/);
    });

    it('lists a directory before descending into it', function () {
        const dir = repository([{
            'Zebra.txt': 'z\n',
            'apple.txt': 'a\n',
            'src/inner.txt': 'i\n',
            'src/deeper/nested.txt': 'n\n',
        }]);
        const listed = reviews(dir, ['show']).stdout
            .split('\n').map((line) => (line.match(/`([^`]+)`/) || [])[1])
            .filter((file) => file && file.includes('.txt'));
        assert.deepStrictEqual(listed, [
            // Case-insensitive, so apple comes before Zebra; a directory's own
            // files before its subdirectory trees, at every level.
            'apple.txt',
            'Zebra.txt',
            'src/inner.txt',
            'src/deeper/nested.txt',
        ]);
    });

    it('names the list it is showing', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        assert.match(reviews(dir, ['show']).stdout, /## All files/);
        // --stale shows a subset, so the heading must not claim every file.
        assert.match(reviews(dir, ['show', '--stale']).stdout, /## Files wanting a reviewer/);
    });

    it('lists only what wants a reviewer with --stale', function () {
        const dir = repository([{ 'a.txt': 'one\n', 'b.txt': 'two\n' }]);
        reviews(dir, ['record', 'a.txt']);
        const { stdout } = reviews(dir, ['show', '--stale']);
        assert.doesNotMatch(stdout, /`a\.txt`/);
        assert.match(stdout, /`b\.txt`/);
    });

    it('keeps the log append-only across several reviews', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        reviews(dir, ['record', 'a.txt']);
        reviews(dir, ['declare', 'a.txt', 'authored']);
        reviews(dir, ['record', 'a.txt', '--by', 'Someone Else']);
        const lines = fs.readFileSync(logIn(dir), 'utf8')
            .split('\n').filter(Boolean);
        assert.strictEqual(lines.length, 3);
        assert.strictEqual(JSON.parse(lines[0]).kind, 'review');
        assert.strictEqual(JSON.parse(lines[1]).kind, 'origin');
    });

    it("does not take the reader's name for a path", function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        assert.strictEqual(reviews(dir, ['record', 'a.txt', '--by', 'Someone Else']).exit, 0);
    });

    it('writes nothing when any path in the command is bad', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        assert.strictEqual(reviews(dir, ['record', 'a.txt', 'nope.txt']).exit, 2);
        assert.ok(!fs.existsSync(logIn(dir)),
            'a failed command left records behind');
    });

    it('writes a table rather than Markdown at a terminal', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        const output = reviewsAtTerminal(dir, ['show']);
        assert.match(output, /❌\s+a\.txt/);
        assert.doesNotMatch(output, /\| --- \|/);
    });

    it('keeps the columns apart when a reader\'s name is long', function () {
        const dir = repository([{ 'a.txt': 'one\n' }]);
        reviews(dir, ['record', 'a.txt', '--by', 'A Person With A Very Long Name Indeed']);
        const line = reviewsAtTerminal(dir, ['show']).split('\n')
            .find((l) => l.includes('a.txt'));
        assert.match(line, /Indeed, \d{4}-\d{2}-\d{2} {2}unchanged since/);
    });

    it('refuses to run outside a git repository', function () {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
        assert.strictEqual(reviews(dir, ['show']).exit, 2);
    });
});
