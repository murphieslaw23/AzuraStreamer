'use strict';

const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

/**
 * Get available disk space for a directory (Unix/Linux)
 * Returns available space in bytes, or null if unable to determine
 */
function getAvailableDiskSpace(dirPath) {
  try {
    const result = execSync(`df "${dirPath}" | tail -1 | awk '{print $4}'`, { encoding: 'utf8' }).trim();
    return parseInt(result) * 1024; // Convert from KB to bytes
  } catch (err) {
    console.error('[diskUtils] Failed to get disk space:', err.message);
    return null;
  }
}

/**
 * Validate that enough disk space exists for streaming
 * Requires at least 500MB for safe operation
 */
function validateDiskSpace(dirPath, requiredBytes = 500 * 1024 * 1024) {
  const available = getAvailableDiskSpace(dirPath);
  
  if (available === null) {
    // Can't determine, assume ok (better UX than failing)
    console.warn('[diskUtils] Could not validate disk space, proceeding anyway');
    return true;
  }
  
  if (available < requiredBytes) {
    const availableMB = (available / 1024 / 1024).toFixed(1);
    const requiredMB = (requiredBytes / 1024 / 1024).toFixed(1);
    throw new Error(`Insufficient disk space: ${availableMB}MB available, ${requiredMB}MB required`);
  }
  
  return true;
}

module.exports = {
  getAvailableDiskSpace,
  validateDiskSpace
};
