# AI Log

I used Claude (Anthropic) throughout, across two sessions (the first hit a usage limit
partway through and I continued in a second session).

## What I asked for

Read the brief, review the codebase for issues, rank them, fix the top five, then build
the Part 2 SLA feature — deciding and documenting the spec gaps rather than guessing
silently or emailing in. I asked it to narrate what it was doing as it went rather than
just handing me a finished zip, and to check in with me specifically on the two
Part 2 decisions that are genuinely judgment calls (what counts as "responded," and
whether closed tickets keep the breach badge) rather than deciding those for me.

## Where it was wrong or misleading, and how I caught it

**The biggest one:** the first session actually stood up a local MySQL instance, ran the
app, and verified every Part 1 exploit live with curl (I watched it do this). But when I
picked the work up in a second session by handing over the codebase, none of that work
was actually in the files — the zip was still the untouched starter, no git history, none
of the five fixes present. The first session's narration made it sound like the fixes
existed in a deliverable; they only existed in that session's own temporary sandbox and
were never exported. I caught this because I had it diff the actual uploaded codebase
against its own claims line-by-line before touching anything, rather than trusting the
handoff summary at face value. Lesson for me: "I ran it and it works" from an AI session
means nothing until the changed files are actually in the repo I'm submitting.

**Git commit mistake, caught and fixed:** while splitting the Part 1 fixes into separate
commits, it ran `git commit --amend` intending to fix an earlier commit's message, but
by that point `HEAD` had moved to a later commit — the amend silently rewrote the wrong
commit (attaching the #2/#3/#5 fix message to the #4 XSS-fix diff). I caught it by
having it `git show --stat` the result and checking the file list against what the
message claimed, which didn't match. It fixed it properly with `git reset --soft` back
to before both commits and recommitted them in the right order with matching messages.
I only found this because I asked it to verify each commit's diff against its message
afterward — it did not flag the mistake unprompted.

**No live verification in the second session:** the second session's sandbox had no
network access, so it couldn't actually install/run MySQL or the app the way the first
session did — meaning nothing in Part 2 (or the re-implemented Part 1 fixes) was tested
against a running server this time. It was upfront about this limitation rather than
pretending to have run tests it hadn't. It compensated by bundle-compiling every changed
file (server and client) with esbuild to at least catch syntax and import errors, and by
manually tracing through the generated SQL strings by eye. That's real, but it is not
the same as the first session's live curl-based verification, and I'm treating the Part
2 SQL in particular as "should work, not yet proven against real data" until I run
`npm run db:reset` myself.

## What I didn't take at face value

Before it built anything for Part 2, I made it walk me through each spec ambiguity in
plain language until I understood the actual trade-off, rather than just picking an
option because it sounded reasonable. On "what counts as a response," I picked option C
(non-internal agent/admin comment only) and on "do closed tickets keep the badge," I
picked "no, open/pending only" — both are recorded with the reasoning in
`DECISIONS.md`. I did not just accept its default recommendation on either without
first having it spell out what each option would actually do to a concrete example
ticket.
