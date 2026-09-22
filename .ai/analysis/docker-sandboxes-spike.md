# Docker Sandboxes: Phase 0 spike results

Spec: `.ai/specs/2026-09-22-docker-sandboxes.md`. Run on 2026-09-22 against `sbx` v0.45.0 (server API 0.36.0), Ubuntu 24.04, host uid 1000. The throwaway repo had a worktree; sandbox `cez-spike1` was created with the spec's exact mount layout (worktree primary, `.git`, `:ro` hold-outs for `config`, `hooks/`, `info/`, `worktrees/<id>/commondir` and `gitdir`, scratch dir), from template `docker.io/docker/sandbox-templates:claude-code` with `--skills off`.

| # | Check | Result |
|---|-------|--------|
| a | stdio through `sbx exec -i` without `-t` | **PASS.** 2 MB of random bytes round-tripped byte-exact through `cat`, with 0 bytes of stderr noise. stdin EOF reaches the inner process. stdout and stderr stay separate. |
| b | Exit codes | **PASS.** 0, 1, 42, 130, 137 and 143 all pass through exactly. An inner self-SIGTERM returns 143. |
| c | Killing the `sbx exec` client | **Inner process survives.** TERM, INT and KILL on the client all leave it running. Client exit is 1 for TERM/INT (`inspect exec: context deadline exceeded`) and 137 for KILL. Closing the client's stdin *is* delivered. → The spec's "kill client, then `sbx stop`" is mandatory. |
| d | Host uid ≠ 1000 | **Not testable here** (host uid is 1000). Files written in the VM land as 1000:1000 on the host. This needs a host with a different uid. |
| e | Claude `/login` carries to a new VM | **PASS.** A fresh VM first reports `Not logged in · Please run /login` (exit 1); keep that text for the auth-hint mapping. After one interactive `/login` in `cez-spike1`, a newly created `cez-spike2` answered `claude -p` with no login. The VM's `~/.claude/.credentials.json` holds a 26-char `sk-ant-oat01…` **stand-in token**, identical in both VMs and different from the host's, so the real token never enters the VM. |
| f | Worktree-primary mount plus `.git` resolves the gitlink | **PASS.** `git status` and `git commit` work inside the VM, and the commit is visible on the host branch. |
| g | `:ro` hold-outs | **PASS, including root.** Writes, `rm`, `mv` (the rename-and-replace attempt), `mount -o remount,rw` and `umount` all fail under `sudo` in the VM. `.git` stays writable (objects, refs). File-level hold-outs don't show in `mountinfo`, but they're enforced anyway. |
| — | Planted gitlink attack | The VM *can* rewrite the worktree's `.git` gitlink (e.g. `gitdir: /evil`). Plain host `git -C <worktree>` then follows it (`fatal: not a git repository: /evil`). Host git with pinned `GIT_DIR`, `GIT_COMMON_DIR` and `GIT_WORK_TREE` ignores it. → Confirms the spec's host-git hardening is required. |
| — | Visibility | The main checkout, `.ai/cezar/runs.json`, `/home/<host user>` and `~/.ssh` are all absent in the VM. The scratch dir is writable. `SANDBOX_NAME` is set. The VM user is `agent` (uid 1000) **with passwordless sudo**. |
| h | Per-VM memory readable | **PASS, via exec.** `sbx inspect --json` has no usage stats; `/proc/meminfo` inside the VM works (used = `MemTotal` − `MemAvailable`). Default VM memory is about 30 GiB on this host. The guard can poll this at about one exec per sample. |
| i | Latency | `sbx create`: 21.7 s including the first image pull. `sbx exec true`: about 0.55 s. |
| j | `sbx version --json` doesn't start the daemon | **PASS.** With the daemon stopped, it returns `server.state: "unavailable"` and starts nothing; `sbx create --help` probes are passive too. Note: `sbx daemon start` runs in the foreground, so cezar must never call it; `sbx ls`/`create` start the daemon on their own. |

## Go/no-go

The required checks (a), (b), (f), (g) and (j) pass, and so does (e). Only (d) (host uid ≠ 1000) is untested. **GO.** No design change is needed; (c) and (h) select the fallbacks the spec already describes.

## Spec deltas

- A one-time Claude login for sandboxes needs the same temp-dir env: `sbx run --name <any> -e CLAUDE_CODE_TMPDIR=<writable dir>`, then `/login`. The README setup step must say so.
- Parent directories of the mount points exist inside the VM **owned by root**. Claude Code refuses a temp dir it doesn't own (`Temp directory … is owned by uid 0 … Refusing to use it`), so sandboxed runs must set both `TMPDIR` and `CLAUDE_CODE_TMPDIR` to the per-run scratch `tmp/`.

- The memory guard polls `/proc/meminfo` through `sbx exec` every ~10 s, not per `ps` cycle, because of the ~0.55 s per exec.
- Document that the VM user has sudo. The `:ro` hold-outs held against root, so the design doesn't depend on the agent being unprivileged.
