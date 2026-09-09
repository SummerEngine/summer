import type { BootDriftNotice } from "../installer/version-check.js";

let cachedBootDriftNotice: BootDriftNotice | null = null;

export function getCachedBootDriftNotice(): BootDriftNotice | null {
  return cachedBootDriftNotice;
}

export function setCachedBootDriftNotice(notice: BootDriftNotice | null): void {
  cachedBootDriftNotice = notice;
}
