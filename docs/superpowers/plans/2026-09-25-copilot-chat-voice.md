# Copilot Chat Voice Controls Implementation Plan

**Goal:** Support spoken tool approval and question answers in local Copilot Chat using official hooks.

**Approved Design:** Reuse `voiceApprove` and `handsFree`, the existing microphone IPC, choice parsing and safety rules. Local `PreToolUse` returns nested `permissionDecision` output. Question answers are conveyed through a denied question tool's feedback, not by clicking the UI. Pre-tool approval can prompt for already-authorized commands. Unknown tools, sensitive operations, malformed forms, cancellation and unclear speech retain manual handling. No blanket auto-approval or UI automation.

**Architecture:** Normalize only explicitly supported Chat tool names and schemas in `src/copilot.ts`. Route Chat pre-tool calls in `src/hook.ts` separately from CLI permission events. Register a shared unfiltered pre-tool hook, with source-specific filtering in the handler so CLI behavior stays unchanged.

**Tech Stack:** TypeScript, VS Code hooks, existing named-pipe IPC, Vitest and esbuild.

## Steps

- [x] Add failing local Chat approval and question cases in `test/copilot-hook.test.ts`; run `npm test -- test/copilot-hook.test.ts -t "Copilot Chat voice"`.
- [x] Normalize Chat tools/questions and implement source-specific hook decisions. Rerun the same tests.
- [x] Cover malformed forms, unsafe commands, unknown tools, disabled settings, silence, cancellation, freeform and multi-select answers in existing Copilot tests. Register the hook and test CLI isolation.
- [x] Update setting descriptions and README with actual support and limitations. The pictured card implementation is absent from this checkout; no replacement UI was created.
- [x] Run affected tests, full tests, typecheck and build. Review the diff. Report runtime verification limits; do not imply the installed extension has been updated by building the repo.

## Verification Criteria

- Explicit spoken confirmation is required for an allowed known command; denial uses the local hook schema.
- Unsafe or unsupported Chat calls never get voice-generated permission to execute.
- Valid question selections reach the agent with question identity and labels intact; incomplete answers never produce partial feedback.
- Claude Code and CLI hook outputs remain unchanged.
- Hook registration reaches Local and CLI once, without opening CLI approval microphones from its pre-tool hook.