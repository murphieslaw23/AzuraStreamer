#!/bin/bash

# AzuraStreamer — System Uninstaller
# Reverses the installation process for Ubuntu, Debian, and Raspbian.

set -e

# --- Visuals ---
GREEN='\033[0;32m'
BLUE='\033[0;34m'
BOLD='\033[1m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${RED}${BOLD}🗑  AzuraStreamer Uninstaller${NC}"
echo -e "This script will remove AzuraStreamer and its components from your system.\n"

if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}${BOLD}Error: Please run as root (use sudo).${NC}"
  exit 1
fi

# --- 1. Container Cleanup ---
echo -e "${BLUE}[1/5] Stopping and removing containers...${NC}"
if command -v docker &> /dev/null && [ -f "docker-compose.yml" ]; then
    docker compose down --rmi all --volumes --remove-orphans || true
    echo -e "${GREEN}✓ Containers and local images removed.${NC}"
else
    echo -e "${YELLOW}Warning: Docker Compose not found or docker-compose.yml missing. Skipping container cleanup.${NC}"
fi

# --- 2. Data Removal ---
echo -e "\n${BOLD}Do you want to delete all application data (database, settings, and logs)?${NC}"
read -p "(y/N): " confirm_data
if [[ "$confirm_data" =~ ^[Yy]$ ]]; then
    echo -e "${BLUE}[2/5] Removing application data...${NC}"
    rm -rf ./server/data
    echo -e "${GREEN}✓ Data directory removed.${NC}"
else
    echo -e "${YELLOW}Skipping data removal. Your database and settings are preserved.${NC}"
fi

# --- 3. Repository & GPG Cleanup ---
echo -e "\n${BLUE}[3/5] Cleaning up repositories and GPG keys...${NC}"
rm -f /etc/apt/sources.list.d/docker.list
rm -f /etc/apt/keyrings/docker.gpg
rm -f /etc/apt/sources.list.d/nodesource.list
apt-get update -y || true
echo -e "${GREEN}✓ Custom repositories and keys removed.${NC}"

# --- 4. Optional Tool Removal ---
echo -e "\n${BOLD}Do you want to UNINSTALL the following system tools?${NC}"
echo -e "${YELLOW}Warning: Only do this if no other applications use them.${NC}"

read -p "Uninstall Docker? (y/N): " rm_docker
if [[ "$rm_docker" =~ ^[Yy]$ ]]; then
    echo -e "${BLUE}Removing Docker...${NC}"
    apt-get purge -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
    apt-get autoremove -y
fi

read -p "Uninstall Node.js? (y/N): " rm_node
if [[ "$rm_node" =~ ^[Yy]$ ]]; then
    echo -e "${BLUE}Removing Node.js...${NC}"
    apt-get purge -y nodejs
    apt-get autoremove -y
fi

read -p "Uninstall FFmpeg? (y/N): " rm_ffmpeg
if [[ "$rm_ffmpeg" =~ ^[Yy]$ ]]; then
    echo -e "${BLUE}Removing FFmpeg...${NC}"
    apt-get purge -y ffmpeg
    apt-get autoremove -y
fi

# --- 5. Group Cleanup ---
if [ "$SUDO_USER" ]; then
    echo -e "\n${BLUE}[5/5] Checking docker group...${NC}"
    if getent group docker | grep -q "$SUDO_USER"; then
        read -p "Remove user '$SUDO_USER' from 'docker' group? (y/N): " rm_group
        if [[ "$rm_group" =~ ^[Yy]$ ]]; then
            gpasswd -d "$SUDO_USER" docker || true
            echo -e "${GREEN}✓ User removed from docker group.${NC}"
        fi
    fi
fi

echo -e "\n${GREEN}${BOLD}--- Uninstallation Complete ---${NC}"
echo -e "AzuraStreamer has been successfully removed."
echo -e "Note: If you kept your project folder, you can delete it manually with: ${BOLD}rm -rf $(pwd)${NC}"
