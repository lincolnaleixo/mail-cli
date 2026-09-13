import { describe, expect, test } from 'bun:test';
import { cleanWhitespace, stripHtml } from './text';

describe('stripHtml', () => {
  test('removes tags and leaves readable text', () => {
    expect(stripHtml('<p>Dear reader,</p><p>Check in is from 4pm.</p>')).toBe(
      'Dear reader,\nCheck in is from 4pm.',
    );
  });

  test('drops style and script content entirely', () => {
    const html = "<style>.a{color:red}</style><script>alert('x')</script><p>Hello</p>";
    const out = stripHtml(html);
    expect(out).toBe('Hello');
    expect(out).not.toContain('color');
    expect(out).not.toContain('alert');
  });

  test('turns br and table rows into line breaks', () => {
    expect(stripHtml('a<br>b')).toBe('a\nb');
    expect(stripHtml('<tr><td>a</td></tr><tr><td>b</td></tr>')).toBe('a\nb');
  });

  test('decodes the common entities', () => {
    expect(stripHtml('<p>Tom &amp; Jerry&#39;s &quot;book&quot; &lt;here&gt;</p>')).toBe(
      'Tom & Jerry\'s "book" <here>',
    );
  });

  test('leaves no angle brackets from a full booking-mail layout', () => {
    const html = `<html><body bgcolor='#F1F0EE'><table bgcolor='#F1F0EE' border='0'>
      <tr><td width='600'><p>Dear reader,</p>
      <p>We are looking forward to welcoming you.</p></td></tr></table></body></html>`;
    const out = stripHtml(html);
    expect(out).toContain('Dear reader,');
    expect(out).toContain('We are looking forward to welcoming you.');
    expect(out).not.toContain('<');
    expect(out).not.toContain('bgcolor');
  });
});

describe('cleanWhitespace', () => {
  test('collapses runs of spaces and blank lines, and trims', () => {
    expect(cleanWhitespace('  a   b  ')).toBe('a b');
    expect(cleanWhitespace('a\n\n\n\nb')).toBe('a\n\nb');
  });

  test('strips carriage returns', () => {
    expect(cleanWhitespace('a\r\nb')).toBe('a\nb');
  });
});
