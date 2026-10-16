import type { HardwareProfile } from './types';

/**
 * Normalizes hardware hints and detects system execution profile.
 * Follows Section 3.1 of Master Engineering Blueprint.
 */
export function detectHardwareProfile(): HardwareProfile {
  const isIsolated = typeof window !== 'undefined' && window.crossOriginIsolated === true;
  const rawCores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 2;
  const cores = Math.max(1, Math.min(16, Number.isFinite(rawCores) ? rawCores : 2));

  // deviceMemory is an experimental hint; may be undefined
  const nav =
    typeof navigator !== 'undefined' ? (navigator as unknown as { deviceMemory?: number }) : {};
  const memoryGiB =
    typeof nav.deviceMemory === 'number' &&
    Number.isFinite(nav.deviceMemory) &&
    nav.deviceMemory > 0
      ? nav.deviceMemory
      : null;

  // Mobile detection
  const navData =
    typeof navigator !== 'undefined'
      ? (navigator as unknown as { userAgentData?: { mobile?: boolean } })
      : {};
  const isMobileHint = Boolean(
    navData.userAgentData?.mobile ||
    (typeof navigator !== 'undefined' &&
      /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(
        navigator.userAgent || ''
      ))
  );

  const fileSystemSink = typeof window !== 'undefined' && 'showSaveFilePicker' in window;

  // Determine hardware tier
  let tier: HardwareProfile['tier'];
  let maxWorkers: HardwareProfile['maxWorkers'];
  let memoryBudgetBytes: number;
  let blobLimitBytes: number;

  if (!isMobileHint && memoryGiB !== null && memoryGiB >= 8 && cores > 2) {
    tier = 'high';
    const computedWorkers = Math.max(1, Math.min(4, cores - 1));
    maxWorkers = (
      computedWorkers >= 1 && computedWorkers <= 4 ? computedWorkers : 2
    ) as HardwareProfile['maxWorkers'];
    memoryBudgetBytes = 768 * 1024 * 1024; // 768 MiB
    blobLimitBytes = 256 * 1024 * 1024; // 256 MiB
  } else if (!isMobileHint && memoryGiB !== null && memoryGiB > 4 && cores > 2) {
    tier = 'standard';
    maxWorkers = 2;
    memoryBudgetBytes = 384 * 1024 * 1024; // 384 MiB
    blobLimitBytes = 128 * 1024 * 1024; // 128 MiB
  } else {
    // constrained: unknown memory, <=4 GiB, <=2 cores, or mobile hint
    tier = 'constrained';
    maxWorkers = 1;
    memoryBudgetBytes = 192 * 1024 * 1024; // 192 MiB
    blobLimitBytes = 64 * 1024 * 1024; // 64 MiB
  }

  return {
    tier,
    cores,
    memoryGiB,
    isolated: isIsolated,
    maxWorkers,
    memoryBudgetBytes,
    blobLimitBytes,
    fileSystemSink,
  };
}

/**
 * Reservation Formulas (Section 3.2 of Master Engineering Blueprint)
 */
export const RESERVATION_CONTROL_BUFFER_BYTES = 32 * 1024 * 1024; // 32 MiB

export function calculateImageReservation(
  sourceBytes: number,
  width: number,
  height: number
): number {
  return 2 * sourceBytes + 20 * width * height + RESERVATION_CONTROL_BUFFER_BYTES;
}

export function calculateOfficeReservation(
  sourceBytes: number,
  expandedBudget: number,
  largestImageReservation: number
): number {
  return (
    2 * sourceBytes + expandedBudget + largestImageReservation + RESERVATION_CONTROL_BUFFER_BYTES
  );
}

export function calculatePdfReservation(sourceBytes: number): number {
  return 6 * sourceBytes + 64 * 1024 * 1024; // 6 * sourceBytes + 64 MiB
}

export function calculateVideoStreamingReservation(width: number, height: number): number {
  const containerAllowance = 64 * 1024 * 1024;
  const decodedFrames = 8 * width * height * 4; // 8 decoded RGBA frames
  const encoderAllowance = 64 * 1024 * 1024;
  return containerAllowance + decodedFrames + encoderAllowance;
}

export function calculateGenericReservation(): number {
  return 16 * 1024 * 1024 + 1024 * 1024; // 16 MiB compression allowance + 1 MiB slice buffer
}
