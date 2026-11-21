#!/usr/bin/env bash
# orca.sh — Orca + orca-box in one file.
#
# Run Claude Code, Codex and pi from Orca (https://orca.dev) inside a separate
# container per workspace (Podman, or Docker), so agents can run without
# permission prompts without reaching the rest of your machine. Installs the
# Orca app too, with an application-menu entry.
#
# This file is generated from src/ by build.sh -- edit the sources there, not
# here. See README.md for the layout and for how to contribute.
#
# Recommended usage (download, review, then run):
#   curl -fsSLO https://github.com/ggpwnkthx/orca-box/releases/latest/download/orca.sh
#   less orca.sh
#   bash orca.sh --git=rw --yolo
#
# One-liner (pipe directly to bash):
#   curl -fsSL https://github.com/ggpwnkthx/orca-box/releases/latest/download/orca.sh | bash
#
# One-liner with options (everything after "--" goes to the script):
#   curl -fsSL https://github.com/ggpwnkthx/orca-box/releases/latest/download/orca.sh | bash -s -- --git=rw --yolo
#
# Options (all optional; full list with: bash orca.sh --help):
#   --git=rw   let agents stage and commit (default: read-only .git)
#   --yolo     set Claude Code, Codex and pi to Orca's Yolo permission mode
#              (no prompts; the container is the boundary)
#
# Run as your normal user, not with sudo. Keep Orca open, or let the installer
# start it: Orca has to be running for its agent settings to change.
#
# Installing copies this file to ~/.local/share/orca-box/orca.sh and links
# these commands in ~/.local/bin to it; each acts on the name it's called by:
#   orca-box AGENT [ARGS]      run an agent in the current workspace's box
#                              (what Orca's Claude Code/Codex/pi commands run)
#   orca-box-login             sign in to the agents once, for every box
#   orca-box-archive [--all]   remove boxes now instead of waiting for idle
#   orca-box-configure-orca    point Orca's agents at orca-box (or --unset)
#   orca-box-install-orca      install/update the Orca app + menu entry
#   orca-box-update            update orca-box from the repository (--check,
#                              --agents, --orca, --restart, --enable-auto)
#   orca-box-setup             this installer (--update, --uninstall, ...)
# Before installing, the same tools are reachable as: bash orca.sh TOOL ...
# (e.g. bash orca.sh orca-box-install-orca --help). Each takes --help.
#
# Updating later: orca-box-update (this script, from the URL above);
# orca-box-update --agents --orca also refreshes the agent image and Orca;
# orca-box-update --enable-auto checks for script updates daily.
