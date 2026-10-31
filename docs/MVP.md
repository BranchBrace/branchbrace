# Git Workbench — MVP specification

## Goal and user

An independent, local desktop Git client for a solo developer who is comfortable with Git. GitKraken Desktop is a functional reference only. Do not copy its code, name, branding, text, or assets. This repository is proprietary and private: `UNLICENSED`, All Rights Reserved (see `LICENSE`). No public publication or launch is authorised.

The first release supports this workflow on an existing local repository with Git CLI installed:

1. Inspect repository state, history, and diffs without changing the repository.
2. Selectively stage or unstage changes and preview the exact staged content.
3. Create an explicit local commit with a non-empty message.
4. Explicitly push to the displayed upstream and verify the remote result.
5. Display, create, and safely switch local branches; cherry-pick, rebase, and interactively rebase only after explicit user action and with a recovery path.

Support targets to validate: Windows 10+ x64; macOS 12+ Intel/Apple Silicon; Linux x86_64 Ubuntu 22.04 LTS and Debian 12. ARM and other Linux distributions are out of initial scope. Do not declare an OS supported until tested there.

## MVP requirements and acceptance evidence

- A1. Show modified, untracked, and deleted files accurately. Inspection does not modify the repository. Verify with before/after integration fixtures.
- A2. Stage or unstage an individual file without staging unrelated changes. Verify `git diff` and `git diff --cached`.
- A3. Staging is file-level only; partial/hunk staging is explicitly excluded from v1, so the UI must state that a selected file's full diff is staged. Verify with integration fixtures showing one selected file and unrelated files remain untouched.
- A4. Preview and commit only staged changes. Verify the commit tree/patch against fixtures.
- A5. Require an explicit user action and non-empty message before committing. Verify commit object and message.
- A6. Push only after explicit action, to the displayed upstream, never with force. Explain missing upstream and rejection. Verify with a local bare remote and ref/command inspection.
- A7. Report push success only after Git succeeds and the remote ref is verified. Distinguish rejection from indeterminate outcomes such as network interruption. Test success, rejection, and interruption.
- A8. Keep inspection, staging, and commit usable without network. Verify with a local repository without a reachable remote.
- A9. Send no Git content, paths, history, credentials, or tokens to third parties. Disable telemetry by default. Verify through network/proxy tests and configuration review.
- A10. Use existing Git/OS credential helpers or SSH. Never store credentials in clear text in preferences or logs. Verify configuration and logs.
- A11. Do not destroy or rewrite the working tree on success or failure. Compare fixtures before and after.
- A12. Never force-push. A push targets only the displayed upstream and reports success only after verifying its remote ref.
- A13. Create/switch local branches without deleting branches or losing local changes; Git must refuse unsafe switches.
- A14. Cherry-pick and rebase operations are explicit, preview their target/range, preserve a recovery point, and explain conflicts/failures; no silent history rewrite.
- A15. Interactive rebase exposes each planned action, requires confirmation, preserves a recovery point, and supports an explained abort/recovery path.
- A16. Respect the installed Git CLI's hooks and credential helpers; make their execution visible and never log their secret values.

## Security and privacy

No hosted service, account, or telemetry by default. Inspection, history, diffs, staging, and local commits stay local. An explicit push sends the selected commits to the displayed, user-configured upstream through Git CLI; Git's configured credential helper/SSH handles authentication. The app does not collect or log credentials, and does not transmit repository data except as a direct result of that confirmed push. Existing Git hooks remain enabled and are user-controlled programs; their own side effects are outside the app's network guarantee. Keep inspection/staging/commit available offline.

## Explicitly out of scope for v1

Clone/init; branch deletion; local merge; automatic fetch/pull; PR/MR creation and hosting-provider APIs; cloud accounts or collaboration; AI, extensions, automatic hooks; force-push, reset, discard; stash management; submodules/worktrees; server/CI runtime; auto-update or package publication.

## Added after v1 (explicit user actions only)

- B1. Explicit fetch (`git fetch --all --prune`): updates remote-tracking refs only. The branch panel shows, per local branch, whether it is in sync, ahead/behind, local-only or whose upstream is gone, and groups remote branches by remote with a "remote only" marker; a remote-only branch can be checked out as a tracking branch. The remote web page (GitHub, GitLab…) is derived from the Git URL with credentials stripped and opened only on click.
- B2. Diffs use the Monaco diff editor (side-by-side or inline, collapsed unchanged regions, word-level highlighting). An unstaged file's working copy is editable from the diff.
- B3. Integrated file editor (Monaco): explorer of tracked and untracked non-ignored files, tabs, quick open (Ctrl+P), save (Ctrl+S). It only writes existing text files inside the repository (no `..`, absolute paths, `.git/` or symlink escapes).
- B4. Integrated conflict resolution for an interrupted rebase, cherry-pick, merge or revert: both sides against their common base, an editable result with per-conflict actions, each resolution tracked (choice made, hand-edited or not, restorable to its original markers), a review mode comparing the result side by side with either side or the base and still editable, save-and-stage, then continue, skip or abort (skip and abort ask for confirmation).
- B5. Amend of the last commit (message and/or staged content) with a recovery ref; confirmation only when the commit is already on its upstream.
- B6. Interactive rebase supports pick, reword, squash, fixup and drop, with the final messages chosen before the rebase starts and reapplied after a conflict.
- B7. Conventional Commits helper for the commit summary; quick access to the repository folder and a terminal opened in it.
- B8. Commit review: every file changed by a commit, stacked with its own diff (collapsed to the changed regions), reached from the commit panel; files can be listed flat or grouped by folder.
- B9. Interactive rebase plan editor: full-window, one colour and icon per action, rows reordered by dragging. Starting it from the validated plan needs no second confirmation; the recovery ref remains.
- B10. Application menu in an icon left of the tabs (no native menu bar); informational messages are short toasts, confirmations stay for push, branch rewrite, abort, skip and amend of a pushed commit.

## Architecture and delivery decisions

The implementation decision is recorded in `docs/adr/0001-desktop-architecture.md`. The standard Company OS quality/release pipeline uses `rc` for prerelease and `main` for stable. No server-side staging is required for this local desktop MVP. Public release, production, spending, and server-side staging are not authorised by this specification. Verified execution environments and the precise test evidence are maintained in `docs/VERIFICATION.md`; an environment smoke test is not a supported-platform claim.
