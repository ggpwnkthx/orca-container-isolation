/**
 * The assets the box needs: the agent image's Containerfile, and the script
 * that links the host's skills into a running box.
 *
 * Both are embedded at build time, so the shipped binary is self-contained:
 * there is nothing else to install.
 */

import containerfileText from "../../container/Containerfile" with { type: "text" };
import skillSyncText from "../../container/skill-sync.sh" with { type: "text" };

/** The Containerfile the agent image is built from. */
export function containerfile(): string {
  return containerfileText;
}

/**
 * The script that links the host's skills into the box.
 *
 * It runs inside the box, where the host's skill folders are mounted: it
 * always sees them as they are now, so a skill installed on the host turns
 * up in a box that is already running.
 */
export function skillSyncScript(): string {
  // A bash heredoc's body ends without a trailing newline (the newline
  // before the terminator is the terminator). Match that exactly, so the
  // script the box runs is byte for byte the one the bash version ran.
  const body = skillSyncText.replace(/\n$/, "");
  return body.replace(
    /@SKILL_DIRS@/g,
    [".agents/skills", ".claude/skills", ".codex/skills", ".pi/agent/skills"].join(" "),
  );
}
