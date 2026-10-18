# timesheet

A Claude Code mod that records real time per project and prints it with one command.

```
/timesheet          today
/timesheet week     this week (Mon–Sun, local time)
/timesheet month    this month
```

```
Project          Bạn làm   AI chạy   Lượt    Việc chính
acme-api            6h40     14h10     83    API checkout, fix auth, migration
acme-web            3h15      5h50     41    trang checkout, form validate
──────────────────────────────────────────────────────
Tổng                9h55     20h00
```

- **Project**: the git root's folder name (else the working directory's).
- **Bạn làm**: your prompts, slash commands and answers to questions, plus the end of each AI turn (when you start reading the answer), merged into work blocks; a gap over 10 minutes ends a block and is not counted. Blocks from parallel sessions count once (union, per day). The total unites all projects too.
- **AI chạy**: each main turn from start to end, subagents it waits on included. Parallel sessions add up, so this can exceed wall-clock time.
- **Lượt**: turns started in the period.
- **Việc chính**: a short label written by haiku from the period's prompts, cached; empty if the model call fails. The model never touches the numbers.

Every account writes to `~/.timesheet/YYYY-MM/<session-id>.jsonl` (one file per session, so parallel sessions never overwrite each other). Summaries are cached in `~/.timesheet/summaries.json`.

Tested on Claude Code **2.1.302** (Windows 11).

## Install

Add this folder to `CLAUDE_CODE_PLUGIN_DIRS` (paths separated by `;` on Windows, `:` elsewhere), as a user environment variable and in the `env` block of each account's `settings.json`; then open a new session. For one session only: `claude --plugin-dir ./timesheet`.

## Develop

```sh
claude plugin validate timesheet
claude plugin test timesheet
```
