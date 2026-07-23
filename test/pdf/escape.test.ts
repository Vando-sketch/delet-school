import { describe, expect, it } from 'vitest';
import { escapeForPandoc } from '../../src/pdf/escape.js';

describe('escapeForPandoc', () => {
  it('leaves normal prose, bold, lists, and inline code untouched', () => {
    const text = '**Wichtig:** siehe `§ 439 BGB`.\n- Punkt eins\n- Punkt zwei';
    expect(escapeForPandoc(text)).toBe(text);
  });

  it('breaks a run of 3+ colons so it cannot be parsed as a pandoc fenced-div fence', () => {
    const result = escapeForPandoc('Text mit ::: mittendrin und :::: auch');
    expect(result).not.toMatch(/:::/);
    // The zero-width breaks are invisible when rendered, so stripping them recovers the colons.
    expect(result.replace(/​/g, '')).toBe('Text mit ::: mittendrin und :::: auch');
  });

  it('escapes raw HTML angle brackets so they cannot be parsed as a raw HTML block', () => {
    expect(escapeForPandoc('Vergleiche a < b und <script>alert(1)</script>')).toBe(
      'Vergleiche a &lt; b und &lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('appends a closing backtick when the input has an odd number of backticks', () => {
    expect(escapeForPandoc('unbalanced `code')).toBe('unbalanced `code`');
  });

  it('does not touch already-balanced backticks', () => {
    expect(escapeForPandoc('balanced `code` here')).toBe('balanced `code` here');
  });
});
