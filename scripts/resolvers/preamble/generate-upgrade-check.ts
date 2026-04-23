import type { TemplateContext } from '../types';

export function generateUpgradeCheck(ctx: TemplateContext): string {
  const defaultModel = ctx.model ?? 'none';
  return `If \`PROACTIVE\` is \`"false"\`, do not proactively suggest gstack skills AND do not
auto-invoke skills based on conversation context. Only run skills the user explicitly
types (e.g., /qa, /ship). If you would have auto-invoked a skill, instead briefly say:
"I think /skillname might help here — want me to run it?" and wait for confirmation.
The user opted out of proactive behavior.

If \`SKILL_PREFIX\` is \`"true"\`, suggest/invoke \`/gstack-*\` names. Disk paths stay \`${ctx.paths.skillRoot}/[skill-name]/SKILL.md\`.

If output shows \`UPGRADE_AVAILABLE <old> <new>\`: read \`${ctx.paths.skillRoot}/gstack-upgrade/SKILL.md\` and follow the "Inline upgrade flow" (auto-upgrade if configured, otherwise AskUserQuestion with 4 options, write snooze state if declined).

If output shows \`JUST_UPGRADED <from> <to>\`: print "Running gstack v{to} (just updated!)". If \`SPAWNED_SESSION\` is true, skip feature discovery.

**Feature discovery markers and prompts** (one at a time, max one per session):

1. \`${ctx.paths.skillRoot}/.feature-prompted-continuous-checkpoint\` →
   Prompt: "Continuous checkpoint auto-commits your work as you go with \`WIP:\` prefix
   so you never lose progress to a crash. Local-only by default — doesn't push
   anywhere unless you turn that on. Want to try it?"
   Options: A) Enable continuous mode, B) Show me first (print the section from
   the preamble Continuous Checkpoint Mode), C) Skip.
   If A: run \`${ctx.paths.binDir}/gstack-config set checkpoint_mode continuous\`.
   Always: \`touch ${ctx.paths.skillRoot}/.feature-prompted-continuous-checkpoint\`

2. \`${ctx.paths.skillRoot}/.feature-prompted-model-overlay\` →
   Inform only (no prompt): "Model overlays are active. \`MODEL_OVERLAY: {model}\`
   shown in the preamble output tells you which behavioral patch is applied.
   Override with \`--model\` when regenerating skills (e.g., \`bun run gen:skill-docs
   --model gpt-5.4\`). Default for this generated skill is ${defaultModel}."
   Always: \`touch ${ctx.paths.skillRoot}/.feature-prompted-model-overlay\`

After handling JUST_UPGRADED (prompts done or skipped), continue with the skill
workflow.`;
}
