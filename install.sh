#!/bin/bash

# AzuraStreamer — Multi-Platform System Setup Script
# Supports: Ubuntu, Debian, Raspbian (AArch64 / x86_64)

set -e

# --- Visuals ---
GREEN='\033[0;32m'
BLUE='\033[0;34m'
BOLD='\033[1m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}${BOLD}🎙  AzuraStreamer System Setup${NC}"
echo -e "This script will prepare your environment for AzuraStreamer.\n"

if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}${BOLD}Error: Please run as root (use sudo).${NC}"
  exit 1
fi

# --- 0. Detection ---
OS_ID=$(. /etc/os-release && echo "$ID")
OS_CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
ARCH=$(dpkg --print-architecture)

echo -e "Detected OS: ${BOLD}$OS_ID ($OS_CODENAME)${NC}"
echo -e "Detected Arch: ${BOLD}$ARCH${NC}\n"

case "$OS_ID" in
    ubuntu|debian|raspbian)
        ;;
    *)
        echo -e "${YELLOW}Warning: $OS_ID is not officially tested, but we will try to proceed with Debian-style installation.${NC}"
        OS_ID="debian"
        ;;
esac

# --- 1. System Update ---
echo -e "${BLUE}[1/4] Updating system packages...${NC}"
apt-get update -y
apt-get install -y ca-certificates curl gnupg lsb-release

# --- 2. Install Docker ---
if ! command -v docker &> /dev/null; then
  echo -e "${BLUE}[2/4] Installing Docker for $OS_ID...${NC}"
  install -m 0755 -d /etc/apt/keyrings
  
  DOCKER_GPG_URL="https://download.docker.com/linux/$OS_ID/gpg"
  # Some versions of Raspbian/Debian might use the debian gpg key
  if [ "$OS_ID" = "raspbian" ]; then
    DOCKER_GPG_URL="https://download.docker.com/linux/raspbian/gpg"
  fi

  curl -fsSL "$DOCKER_GPG_URL" | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  echo \
    "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$OS_ID \
    $OS_CODENAME stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  
  echo -e "${GREEN}✓ Docker installed successfully.${NC}"
else
  echo -e "${GREEN}✓ Docker is already installed: $(docker --version)${NC}"
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
  echo -e "${GREEN}✓ FFmpeg is already installed: $(ffmpeg -version | head -n1 | cut -d ' ' -f3)${NC}"
fi

# --- Finalization ---
echo -e "\n${BLUE}${BOLD}--- Configuration Complete ---${NC}"

# Add current user to docker group if sudo was used
if [ "$SUDO_USER" ]; then
  usermod -aG docker "$SUDO_USER"
  echo -e "${GREEN}✓ Added user '$SUDO_USER' to 'docker' group.${NC}"
fi

echo -e "\n${GREEN}${BOLD}AzuraStreamer is ready to be launched!${NC}"
echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BOLD}1. Start the application:${NC}"
echo -e "   Run: ${BLUE}docker compose up -d --build${NC}"
echo -e ""
echo -e "${BOLD}2. Access the dashboard:${NC}"
echo -e "   URL:  ${BLUE}http://$(hostname -I | awk '{print $1}'):3000${NC}"
echo -e ""
echo -e "${BOLD}3. Security:${NC}"
echo -e "   On first visit, you will be prompted to create your"
echo -e "   administrator password."
echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$SUDO_USER" ]; then
  echo -e "${YELLOW}${BOLD}Important: Please log out and back in (or run 'newgrp docker') for group changes to take effect.${NC}"
fi
