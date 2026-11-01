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
- A3. Staging is file-level in v1. Hunk- and line-level staging and unstaging come in wave 1 (see roadmap): after each partial operation the app re-reads `git diff --cached` and rolls back if the index differs from the expected result. Verify with integration fixtures showing that the selected hunk or lines, and nothing else, are staged.
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

Clone/init; branch deletion; local merge; automatic fetch/pull; PR/MR creation and hosting-provider APIs; cloud accounts or collaboration; AI, extensions, automatic hooks; force-push, reset, discard; stash management; submodules; server/CI runtime; auto-update or package publication.

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
- B2a. Syntax highlighting in diffs and the editor: Monaco's built-in Monarch grammars, extended by the TextMate grammars of VS Code extensions (installed in `~/.vscode/extensions` / `~/.vscode-oss/extensions`, or imported as `.vsix` from the app menu and removable there). An installed or imported extension takes precedence over Monarch for the languages it covers; the grammars bundled with VS Code only color files Monarch does not know. Extension files are read locally by the main process, never downloaded (ADR 0007).
- B3. Integrated file editor (Monaco): explorer of tracked and untracked non-ignored files, tabs, quick open (Ctrl+P), save (Ctrl+S). It only writes existing text files inside the repository (no `..`, absolute paths, `.git/` or symlink escapes).
- B4. Integrated conflict resolution for an interrupted rebase, cherry-pick, merge or revert: both sides against their common base, an editable result with per-conflict actions, each resolution tracked (choice made, hand-edited or not, restorable to its original markers), a review mode comparing the result side by side with either side or the base and still editable, save-and-stage, then continue, skip or abort (skip and abort ask for confirmation).
- B5. Amend of the last commit (message and/or staged content) with a recovery ref; confirmation only when the commit is already on its upstream.
- B6. Interactive rebase supports pick, reword, squash, fixup and drop, with the final messages chosen before the rebase starts and reapplied after a conflict.
- B7. Conventional Commits helper for the commit summary; quick access to the repository folder and a terminal opened in it.
- B8. Commit review: every file changed by a commit, stacked with its own diff (collapsed to the changed regions), reached from the commit panel; files can be listed flat or grouped by folder.
- B9. Interactive rebase plan editor: full-window, one colour and icon per action, rows reordered by dragging. Starting it from the validated plan needs no second confirmation; the recovery ref remains.
- B10. Application menu in an icon left of the tabs (no native menu bar); informational messages are short toasts, confirmations stay for push, branch rewrite, abort, skip and amend of a pushed commit.
- B11. Rename a local branch from its context menu: the name is validated with `git check-ref-format --branch` and applied with `git branch -m` (never `-M`), so a name already taken is refused and no branch is replaced; the upstream configuration follows. Renaming the tracked remote branch too is a separate, unchecked-by-default option that asks for confirmation: it is refused before any change unless the remote branch points at the local commit and the new name is free remotely, then pushes the new name (no force-push, verified with `ls-remote`), tracks it, and deletes the old remote name only with a lease on that exact commit, so no remote commit can be lost (A12/A13).
- B12. Worktrees: a WORKTREES section of the branch panel lists `git worktree list --porcelain` (folder, branch or detached HEAD, main, locked, missing/prunable, and the current one). A worktree is created from a free existing branch or a new branch, in a folder chosen in the native dialog (an empty or new folder; a non-empty one gets a sub-folder named after the branch); it opens in its own tab like any repository, with its own status and in-progress operation. Removal asks for confirmation, uses `git worktree remove` without `--force` (Git refuses when uncommitted or untracked files would be lost), keeps the branch, then runs `git worktree prune`; the main, current and locked worktrees cannot be removed. A branch checked out in another worktree is marked as such and switching to it offers to open that worktree instead of failing.
- B13. Sync without repeated clicks (supersedes "automatic fetch" in the v1 exclusions; automatic pull stays excluded). A background fetch runs every N minutes (5 by default, configurable or disabled from the application menu, persisted with the other preferences), when a repository tab opens and when the window regains focus (debounced). It never runs during an interrupted rebase, merge or cherry-pick nor while another fetch is in flight, never opens a credential prompt (`GIT_TERMINAL_PROMPT=0`, SSH `BatchMode=yes`, no Git Credential Manager UI) and reports a failure as a discreet marker on the Fetch button, not a dialog. The toolbar shows the current branch ahead/behind its upstream (↑n ↓m). The explicit fast-forward-only Pull additionally reports success only once HEAD equals the fetched upstream commit; uncommitted changes stay protected by Git's own refusal. Verified with a local bare remote: background fetch reporting the branch behind without moving it, skipped background fetch during an operation, fast-forward, divergence left untouched, conflicting uncommitted changes refused.

## Architecture and delivery decisions

The implementation decision is recorded in `docs/adr/0001-desktop-architecture.md`. The standard Company OS quality/release pipeline uses `rc` for prerelease and `main` for stable. No server-side staging is required for this local desktop MVP. Public release, production, spending, and server-side staging are not authorised by this specification. Verified execution environments and the precise test evidence are maintained in `docs/VERIFICATION.md`; an environment smoke test is not a supported-platform claim.
