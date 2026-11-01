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
- A3. Staging is file-level in v1. Hunk staging and unstaging were added in wave 1 (B11); line-level staging remains planned (see roadmap): after each partial operation the app re-reads `git diff --cached` and rolls back if the index differs from the expected result. Verify with integration fixtures showing that the selected hunk or lines, and nothing else, are staged.
- A4. Preview and commit only staged changes. Verify the commit tree/patch against fixtures.
- A5. Require an explicit user action and non-empty message before committing. Verify commit object and message.
- A6. Push only after explicit action, to the displayed upstream. A rejected push is never retried with force; force-push is the separate action of A12. Explain missing upstream and rejection. Verify with a local bare remote and ref/command inspection.
- A7. Report push success only after Git succeeds and the remote ref is verified. Distinguish rejection from indeterminate outcomes such as network interruption. Test success, rejection, and interruption.
- A8. Keep inspection, staging, and commit usable without network. Verify with a local repository without a reachable remote.
- A9. Send no Git content, paths, history, credentials, or tokens to third parties. Disable telemetry by default. Verify through network/proxy tests and configuration review.
- A10. Use existing Git/OS credential helpers or SSH. Never store credentials in clear text in preferences or logs; the optional vault keeps tokens in the OS keychain only (ADR 0006). Refuse remote URLs that embed credentials. Verify configuration and logs.
- A11. Do not destroy or rewrite the working tree on success or failure, except through a confirmed destructive operation under A17. Compare fixtures before and after.
- A12. A push targets only the displayed upstream and reports success only after verifying its remote ref. Force-push always uses `--force-with-lease`, is a separate explicit action, never an automatic fallback, and its confirmation lists the remote commits it will drop (ADR 0006).
- A13. Create/switch local branches without losing local changes; Git must refuse unsafe switches. Branch deletion follows A17.
- A14. Cherry-pick and rebase operations are explicit, preview their target/range, preserve a recovery point, and explain conflicts/failures; no silent history rewrite.
- A15. Interactive rebase exposes each planned action, requires confirmation, preserves a recovery point, and supports an explained abort/recovery path.
- A16. Respect the installed Git CLI's hooks and credential helpers; make their execution visible and never log their secret values.
- A17. Reversible first (ADR 0006): a destructive operation (reset, discard, deletion of a branch, tag or stash entry, removal of a worktree with changes) requires an explicit action, a confirmation, and a recovery point recorded before acting. The recovery point includes uncommitted changes when the working tree is affected. Undo restores the latest recovery point and Redo the state recorded at Undo; both are local only and never rewrite a pushed commit.

## Security and privacy

No hosted service, account, or telemetry by default. Inspection, history, diffs, staging, and local commits stay local. An explicit push sends the selected commits to the displayed, user-configured upstream through Git CLI; Git's configured credential helper/SSH handles authentication. By default the app does not see credentials: Git Credential Manager handles provider sign-in (delegated sign-in). Optionally, the app keeps personal access tokens in the OS keychain (the vault), never in clear text and never logged (ADR 0006). The app does not transmit repository data except as a direct result of an explicit push, fetch, pull or clone. Existing Git hooks remain enabled and are user-controlled programs; their own side effects are outside the app's network guarantee. Keep inspection/staging/commit available offline.

## Explicitly out of scope for v1

Clone/init; branch deletion; local merge; automatic fetch/pull; PR/MR creation and hosting-provider APIs; cloud accounts or collaboration; AI, extensions, automatic hooks; force-push, reset, discard; stash management; submodules/worktrees; server/CI runtime; auto-update or package publication.

The roadmap below lifts most of this list. Still out of scope: automatic fetch/pull; cloud accounts or collaboration; AI, extensions, automatic hooks; Git Flow; a hook-editing UI; custom themes; server/CI runtime.

## Roadmap by wave (decided 2026-11-01)

Comparison with GitKraken, one decision per feature. Terms are defined in `CONTEXT.md`; the safety doctrine and credentials in ADR 0006. Each wave depends on the previous one.

1. **Safety and daily flow.** Recovery points extended to uncommitted changes; local Undo/Redo (A17). Revert; reset soft, mixed and hard. Local merge with a preview and a recovery point, merge commit by default, fast-forward optional, no squash merge. Pull is fetch plus fast-forward only; on divergence it explains and offers merge or rebase. Stash: save (message, untracked optional), list with content, apply/pop/drop an entry chosen by SHA, never "the top one" (the stack is shared across worktrees). Rename a local branch; delete a local branch (warning if unmerged); delete a remote branch as a separate confirmed action, never cascaded. Tags: create (annotated by default, lightweight optional), delete locally, push a single tag, delete a remote tag separately; never `--tags`. Lease-protected force-push (A12). Add, rename, re-URL and remove remotes. Hunk- and line-level staging (A3).
2. **Identities and repositories.** Settings screen; dark, light and follow-system themes (Monaco included). Profiles: name, email, signing key and format (GPG or SSH), provider accounts; assigning a profile writes the repository's local Git config, with a warning when it drifts. Signature status shown in commit details. Delegated sign-in through Git Credential Manager, optional vault (ADR 0006). Workspaces: named sets of repositories opened as tabs, with a default profile, local only. Clone by URL and `git init`, each with a profile and an optional workspace. Command palette (Ctrl+Shift+P) listing the actions available in the current state.
3. **History.** Progressive graph loading in batches of 500 while scrolling. History search run by Git over the whole history (message, author, SHA, optional diff content with `-S`) that brings the graph to the selected commit. File history (`--follow`) and blame in the editor margin, with blame-at-parent. Comparison of two refs in the commit review view: contribution (since the merge base) by default, direct difference as a toggle, plus the commits unique to each side. Worktrees: list, create from a branch, open as a tab, remove. Submodules: status, init, update. LFS: detection, warning when `git-lfs` is missing, no pointer shown as a diff.
4. **Hosting providers.** GitHub and GitLab APIs: create and review pull/merge requests, browse a provider's repositories to clone. Whether delegated-sign-in tokens carry enough API scope, or the vault is required, is decided then.

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
- B11. Hunk staging: in a modified file's diff, each change block (`git diff --unified=0`) can be staged, or unstaged from the staged side, alone. A block is identified by its content, so a block that changed since it was displayed is refused, never applied elsewhere. Patches are applied byte for byte (`git apply --cached`), keeping line endings and encodings; the diff is then re-read and the index entry is restored if anything other than that block changed (A3). New, deleted, renamed, binary and conflicted files remain whole-file only. Unrelated blocks and the working tree are untouched.
- B12. Commit split: from the graph ("Découper ce commit…") or as a "split" action in the interactive rebase editor. After a confirmation, the rebase stops on the commit (`edit`) and removes it alone (`reset HEAD~1`), so its changes return unstaged to the working tree. They are recommitted in pieces (by file or by block, with the original message offered), then "Continue" replays the rest of the branch. The working tree must be clean to start; root and merge commits, commits outside the current branch and ranges containing merges are refused; a recovery ref is kept and abort returns to the state before.

## Architecture and delivery decisions

The implementation decision is recorded in `docs/adr/0001-desktop-architecture.md`. The standard Company OS quality/release pipeline uses `rc` for prerelease and `main` for stable. No server-side staging is required for this local desktop MVP. Public release, production, spending, and server-side staging are not authorised by this specification. Verified execution environments and the precise test evidence are maintained in `docs/VERIFICATION.md`; an environment smoke test is not a supported-platform claim.
