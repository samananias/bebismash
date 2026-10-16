import { describe, expect, it } from 'vitest';
import { saveOptions } from './saveOptions';
describe('local save picker options', () => {
  it('keeps the MP4 name and supplies valid video filters', () => {
    expect(saveOptions('holiday.MP4')).toEqual({
      suggestedName: 'holiday.MP4',
      types: [{ description: 'MP4 file', accept: { 'video/mp4': ['.mp4'] } }],
    });
  });
  it('bounds untrusted names, removes paths and supplies a fallback extension', () => {
    expect(saveOptions('../unsafe\u202e').suggestedName).toBe('unsafe_.bin');
    expect(saveOptions('README').types[0]?.accept).toEqual({
      'application/octet-stream': ['.bin'],
    });
    const name = saveOptions(`${'長'.repeat(200)}.pdf`).suggestedName;
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(220);
    expect(name.endsWith('.pdf')).toBe(true);
  });
});
