#!/bin/bash

# AzuraStreamer — System Setup Script
# Installs Docker, Docker Compose, Node.js, and FFmpeg.

set -e

# --- Visuals ---
GREEN='\033[0;32m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo -e "${BLUE}${BOLD}🎙  AzuraStreamer System Setup${NC}"
echo -e "This script will install Docker, Node.js, and FFmpeg.\n"

if [ "$EUID" -ne 0 ]; then
  echo -e "Please run as root (use sudo)."
  exit 1
fi

# --- 1. System Update ---
echo -e "${BLUE}[1/4] Updating system packages...${NC}"
apt-get update -y && apt-get upgrade -y
apt-get install -y ca-certificates curl gnupg lsb-release

# --- 2. Install Docker ---
if ! command -v docker &> /dev/null; then
  echo -e "${BLUE}[2/4] Installing Docker...${NC}"
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg

  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  
  echo -e "${GREEN}✓ Docker installed successfully.${NC}"
else
  echo -e "${GREEN}✓ Docker is already installed.${NC}"
fi

# --- 3. Install Node.js ---
if ! command -v node &> /dev/null; then
  echo -e "${BLUE}[3/4] Installing Node.js (LTS)...${NC}"
  curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
  apt-get install -y nodejs
  echo -e "${GREEN}✓ Node.js installed successfully.${NC}"
else
  echo -e "${GREEN}✓ Node.js is already installed ($(node -v)).${NC}"
fi

# --- 4. Install FFmpeg ---
if ! command -v ffmpeg &> /dev/null; then
  echo -e "${BLUE}[4/4] Installing FFmpeg...${NC}"
  apt-get install -y ffmpeg
  echo -e "${GREEN}✓ FFmpeg installed successfully.${NC}"
else
  echo -e "${GREEN}✓ FFmpeg is already installed.${NC}"
fi

# --- Finalization ---
echo -e "\n${BLUE}${BOLD}--- Configuration Complete ---${NC}"

# Add current user to docker group if sudo was used
if [ "$SUDO_USER" ]; then
  usermod -aG docker $SUDO_USER
  echo -e "${GREEN}✓ Added user '$SUDO_USER' to 'docker' group.${NC}"
  echo -e "${BOLD}Note: Please log out and back in for group changes to take effect.${NC}"
fi

echo -e "\n${GREEN}${BOLD}AzuraStreamer is ready to be launched!${NC}"
echo -e "Run: ${BOLD}docker compose up -d --build${NC}"
