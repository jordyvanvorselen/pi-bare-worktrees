# pi-bare-worktrees

Git worktrees for `--bare` checkouts in [pi](https://pi.dev). One worktree per task, shared env files linked in, protected branches kept read-only, and a `worktree` tool the agent calls itself.

## What it does

- **Every change gets its own worktree.** `main` and other protected branches are read-only. The first edit on them is blocked with a message that tells the model to call `worktree create`. It then continues in the new worktree without a `cd`.
- **Shared env, zero config.** Every file under `<root>/.shared-env/` is symlinked into each worktree at the same relative path. Real files are never overwritten.
- **Fast.** No git process on session start or on tool calls. Root detection, worktree listing and link checks read the filesystem. Git runs only when you create, remove, clean, or in the background for the footer.
- **Native.** The tool shows up in the system prompt, the footer shows the active worktree, state survives `/resume`, and subagents inherit the worktree.

## Layout it expects

```
project/
├── .bare/            bare repo (core.bare = true)
├── .shared-env/      gitignored files to mirror, e.g. connect-backend/.env.keys
├── main/             worktree for main
└── feat/login/       worktree for feat/login
```

Path equals branch name. Create one with:

```sh
mkdir project && cd project
git clone --bare git@github.com:org/repo.git .bare
git --git-dir=.bare config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git --git-dir=.bare fetch
git --git-dir=.bare worktree add main main
```

Outside this layout the extension turns itself off and says so once at startup.

## Install

```sh
pi install git:github.com/jordyvanvorselen/pi-bare-worktrees
```

Then, inside a worktree:

```
/wt setup
```

The wizard asks for the shared env directory (default `.shared-env`), base branch, protected patterns, branch template, post-create commands and copy list. It saves to `.bare/config` under `[bare-worktrees]` and runs `doctor` right away.

## Commands

| Command | What it does |
|---|---|
| `/wt` | Pick a worktree and switch the session into it |
| `/wt new <branch> [--from <ref>] [--move]` | Create at `<root>/<branch>`, link env, run post-create, switch |
| `/wt use <branch> [--move]` | Switch into an existing worktree |
| `/wt list` | Worktrees with active and read-only marks |
| `/wt link` | Re-sync shared env links into the active worktree |
| `/wt rm <branch> [--force] [--branch]` | Remove a worktree, optionally its branch |
| `/wt clean` | Fetch with prune, then pick which gone or missing worktrees to remove |
| `/wt doctor [--fix]` | Missing links, conflicts, detached HEADs, prunable entries |
| `/wt sync` | Move the session cwd into the active worktree after the model created it |
| `/wt on` / `/wt off` | Enforcement for this session. Off needs a confirm |
| `/wt setup` | Run the wizard again |

`--move` stashes uncommitted changes and pops them in the target.

## The `worktree` tool

```ts
worktree({ action: "create" | "use" | "list" | "status" | "link" | "remove" | "doctor",
           branch?, from?, move?, force? })
```

After `create` or `use`, every built-in tool call is routed into that worktree: relative paths are resolved there and bash runs there. The model never needs `cd`. Run `/wt sync` when you want the session itself to move too.

## Enforcement

| Call | Protected worktree | Feature worktree |
|---|---|---|
| read, grep, find, ls | allow | allow |
| bash: build, test, `git status/log/diff` | allow | allow |
| bash: `git commit/push/rebase/reset/...`, `rm`, `sed -i`, `>` | block | allow |
| bash: `git worktree`, `git switch`, `git checkout <branch>` | block | block |
| edit, write | block | allow |
| subagent | `cwd` set to active worktree | same |

Blocked calls return a reason that names the exact `worktree create` call to make. Bash detection is a regex over the command; it catches the common cases and is cheap. `git checkout -- <file>` is allowed.

## Configuration

Per repo, in `.bare/config`:

```ini
[bare-worktrees]
	sharedEnv = .shared-env
	baseBranch = main
	protected = release/*
	branchTemplate = feat/{slug}
	fetchBeforeCreate = false
	postCreate = yarn install --immutable
	copy = .idea
	autoLink = true
```

Global, in `~/.pi/agent/pi-bare-worktrees.json`:

```json
{
  "warnWhenNotBare": true,
  "systemPrompt": true,
  "systemPromptFile": "/path/to/custom-section.md",
  "defaults": { "branchTemplate": "task/{slug}" }
}
```

`systemPromptFile` replaces the built-in `<worktrees>` section. Placeholders: `{root}` `{active}` `{activePath}` `{state}` `{branchTemplate}` `{example}` `{baseBranch}` `{protected}`.

## Footer and other extensions

The extension publishes its state through `ctx.ui.setStatus("wt", ...)`, which the built-in footer shows. In [pi-powerline-footer](https://github.com/nicobailon/pi-powerline-footer) add a custom item with `"statusKey": "wt"`.

Text looks like `⎇ feat/login ↑2 ●` or `⌂ main · ro`. `↪` means tools are routed into a worktree the session cwd is not in.

For richer bars, subscribe on the shared bus:

```ts
pi.events.on("bare-worktrees:changed", (s) => {
  // { root, active: { branch, path, name, protected } | null, enforcement, routed,
  //   live: { dirty, ahead, behind, gone, missingLinks } | null }
});
```

## Performance notes

- Session start: one directory walk of `.bare/worktrees/*` and one `lstat` per shared file. About 5 ms for 40 worktrees and 12 shared files.
- Tool calls: string operations only. Under 0.1 ms.
- Dirty and ahead/behind run in the background after the agent settles, debounced, and stale results are dropped.
- `/wt clean` is the only command that touches the network.

## Development

```sh
npm install
npm run typecheck
npm test
pi -e ./src/index.ts
```
