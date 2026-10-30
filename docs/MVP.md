# Git Workbench — MVP specification

## Goal and user

An independent desktop Git client for a solo developer who is comfortable with Git. GitKraken Desktop is a functional reference only. Do not copy its code, name, branding, text, or assets. This project is locally owned; the MIT licence does not authorise public publication or launch.

The first release supports this workflow on an existing local repository:

1. Inspect repository state, history, and diffs without changing the repository.
2. Selectively stage or unstage changes and preview the exact staged content.
3. Create an explicit local commit with a non-empty message.
4. Explicitly push to the displayed upstream and verify the remote result.

Support targets to validate: Windows 10+ x64; macOS 12+ Intel/Apple Silicon; Linux x86_64 Ubuntu 22.04 LTS and Debian 12. ARM and other Linux distributions are out of initial scope. Do not declare an OS supported until tested there.

## MVP requirements and acceptance evidence

- A1. Show modified, untracked, and deleted files accurately. Inspection does not modify the repository. Verify with before/after integration fixtures.
- A2. Stage or unstage an individual file without staging unrelated changes. Verify `git diff` and `git diff --cached`.
- A3. Do not stage independent hunks silently together. Support reliable hunk staging or explicitly exclude it from MVP. Verify with an integration test or documented capability test.
- A4. Preview and commit only staged changes. Verify the commit tree/patch against fixtures.
- A5. Require an explicit user action and non-empty message before committing. Verify commit object and message.
- A6. Push only after explicit action, to the displayed upstream, never with force. Explain missing upstream and rejection. Verify with a local bare remote and ref/command inspection.
- A7. Report push success only after Git succeeds and the remote ref is verified. Distinguish rejection from indeterminate outcomes such as network interruption. Test success, rejection, and interruption.
- A8. Keep inspection, staging, and commit usable without network. Verify with a local repository without a reachable remote.
- A9. Send no Git content, paths, history, credentials, or tokens to third parties. Disable telemetry by default. Verify through network/proxy tests and configuration review.
- A10. Use existing Git/OS credential helpers or SSH. Never store credentials in clear text in preferences or logs. Verify configuration and logs.
- A11. Do not destroy or rewrite the working tree on success or failure. Compare fixtures before and after.

## Security and privacy

No hosted service, account, or telemetry by default. Do not transmit repository content or credentials to third parties. Use existing Git/OS authentication mechanisms. Keep local inspection/staging/commit available offline.

## Explicitly out of scope

Clone/init; branch operations; automatic fetch/pull; merge, rebase, cherry-pick, stash, or conflict resolution; PR/MR and hosting-provider integrations; cloud accounts or collaboration; file editing; AI, extensions, automatic hooks; force-push, reset, discard, amend/squash; submodules/worktrees; server/CI runtime; auto-update or package publication.

## Architecture and delivery decisions

The UI framework, Git binding/library, and packaging remain open until a test-first capability spike compares candidates against A1–A11. Record the choice in a short ADR before implementation. The standard Company OS quality/release pipeline uses `rc` for prerelease and `main` for stable. No server-side staging is required for this local desktop MVP. Public release, production, spending, and server-side staging are not authorised by this specification.
