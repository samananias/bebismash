import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  detectHardwareProfile,
  calculateImageReservation,
  calculateOfficeReservation,
  calculatePdfReservation,
  calculateVideoStreamingReservation,
  calculateGenericReservation,
  RESERVATION_CONTROL_BUFFER_BYTES,
} from './hardware';

describe('Hardware Profile Detection', () => {
  const originalNavigator = globalThis.navigator;
  const originalWindow = globalThis.window;

  beforeEach(() => {
    // Reset or stub globals as needed
  });

  afterEach(() => {
    // Restore
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: originalWindow,
      writable: true,
      configurable: true,
    });
  });

  it('detects constrained profile when memory is unknown or low', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        hardwareConcurrency: 2,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      writable: true,
      configurable: true,
    });

    const profile = detectHardwareProfile();
    expect(profile.tier).toBe('constrained');
    expect(profile.maxWorkers).toBe(1);
    expect(profile.memoryBudgetBytes).toBe(192 * 1024 * 1024);
  });

  it('detects standard profile when memory > 4 GiB and cores > 2 without mobile hint', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        hardwareConcurrency: 4,
        deviceMemory: 6,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      writable: true,
      configurable: true,
    });

    const profile = detectHardwareProfile();
    expect(profile.tier).toBe('standard');
    expect(profile.maxWorkers).toBe(2);
    expect(profile.memoryBudgetBytes).toBe(384 * 1024 * 1024);
  });

  it('detects high profile when memory >= 8 GiB and cores > 2 without mobile hint', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        hardwareConcurrency: 8,
        deviceMemory: 16,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      writable: true,
      configurable: true,
    });

    const profile = detectHardwareProfile();
    expect(profile.tier).toBe('high');
    expect(profile.maxWorkers).toBe(4);
    expect(profile.memoryBudgetBytes).toBe(768 * 1024 * 1024);
  });

  it('clamps mobile devices to constrained mode even with high cores and memory', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        hardwareConcurrency: 8,
        deviceMemory: 8,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
        userAgentData: { mobile: true },
      },
      writable: true,
      configurable: true,
    });

    const profile = detectHardwareProfile();
    expect(profile.tier).toBe('constrained');
    expect(profile.maxWorkers).toBe(1);
    expect(profile.memoryBudgetBytes).toBe(192 * 1024 * 1024);
  });

  it('clamps core count to between 1 and 16', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        hardwareConcurrency: 64,
        deviceMemory: 32,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      writable: true,
      configurable: true,
    });

    const profile = detectHardwareProfile();
    expect(profile.cores).toBe(16);
  });
});

describe('Reservation Formulas', () => {
  it('calculates image reservation according to blueprint formula', () => {
    const sourceBytes = 1_000_000;
    const width = 1920;
    const height = 1080;
    const expected = 2 * sourceBytes + 20 * width * height + RESERVATION_CONTROL_BUFFER_BYTES;
    expect(calculateImageReservation(sourceBytes, width, height)).toBe(expected);
  });

  it('calculates office reservation according to blueprint formula', () => {
    const sourceBytes = 500_000;
    const expandedBudget = 10_000_000;
    const largestImage = 5_000_000;
    const expected =
      2 * sourceBytes + expandedBudget + largestImage + RESERVATION_CONTROL_BUFFER_BYTES;
    expect(calculateOfficeReservation(sourceBytes, expandedBudget, largestImage)).toBe(expected);
  });

  it('calculates pdf reservation according to blueprint formula', () => {
    const sourceBytes = 2_000_000;
    const expected = 6 * sourceBytes + 64 * 1024 * 1024;
    expect(calculatePdfReservation(sourceBytes)).toBe(expected);
  });

  it('calculates streaming video reservation with 8 frame ceiling', () => {
    const width = 1920;
    const height = 1080;
    const expected = 64 * 1024 * 1024 + 8 * width * height * 4 + 64 * 1024 * 1024;
    expect(calculateVideoStreamingReservation(width, height)).toBe(expected);
  });

  it('calculates generic reservation with bounded slice buffers', () => {
    const expected = 16 * 1024 * 1024 + 1024 * 1024;
    expect(calculateGenericReservation()).toBe(expected);
  });
});
