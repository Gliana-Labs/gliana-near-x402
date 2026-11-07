import { describe, expect, it } from 'vitest';
import { describeHeld, newlyHeld, type HeldPayment } from './watch-held.js';

const held = (id: string, status = 'waiting'): HeldPayment => ({ id, to: '0x7662E00f8Ab4C362166e1FF649Ff6c2A638c80AD', value: '18000', why: 'over the approval limit', status });

describe('telling the owner about held payments', () => {
  it('announces each waiting payment once', () => {
    const seen = new Set<string>();
    expect(newlyHeld([held('1'), held('2')], seen).map((h) => h.id)).toEqual(['1', '2']);
    expect(newlyHeld([held('1'), held('2'), held('3')], seen).map((h) => h.id)).toEqual(['3']);
  });
  it('stays quiet about ones already decided', () => {
    expect(newlyHeld([held('1', 'signed'), held('2', 'rejected'), held('3', 'signing')], new Set())).toEqual([]);
  });
  it('says the amount, who gets it, and what to do', () => {
    const text = describeHeld(held('7'), 'allowance.you.near');
    expect(text).toContain('$0.02');
    expect(text).toContain('0x7662E00f');
    expect(text).toContain('approve 7');
  });
});
