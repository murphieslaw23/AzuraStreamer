#!/bin/bash

# AzuraStreamer Git Sync Tool
# Automatically stages, commits, and pushes changes based on active tasks.

set -e

# --- Configuration ---
GREEN='\033[0;32m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BLUE}${BOLD}🚀 AzuraStreamer Git Sync${NC}"

# Check for changes
if [[ -z $(git status -s) ]]; then
    echo -e "${GREEN}Everything up to date. No changes to push.${NC}"
    exit 0
fi

# --- Task-Based Commits ---

# 1. Auth & Security Improvements
if git status -s | grep -E "server/index.js|public/setup.html" > /dev/null; then
    echo -e "${BLUE}Staging Auth & Security changes...${NC}"
    git add server/index.js public/setup.html
    git commit -m "feat: implement setup optimization and auth session handling" || true
fi

# 2. System Tools (Uninstaller)
if git status -s | grep -E "uninstall.sh|README.md" > /dev/null; then
    echo -e "${BLUE}Staging System Tool changes...${NC}"
    git add uninstall.sh README.md
    git commit -m "feat: add system uninstaller and update README documentation" || true
fi

# 3. Remaining changes
if [[ -n $(git status -s) ]]; then
    echo -e "${BLUE}Staging remaining changes...${NC}"
    git add .
    git commit -m "refactor: minor UI and backend refinements" || true
fi

# --- Push ---
echo -e "${BLUE}Pushing to origin main...${NC}"
git push origin main

echo -e "${GREEN}${BOLD}✓ All tasks pushed successfully!${NC}"
