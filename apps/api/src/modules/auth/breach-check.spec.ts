import { checkPasswordBreach, parseRangeBody } from './breach-check';

// SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
const PREFIX = '5BAA6';
const SUFFIX = '1E4C9B93F3F0682250B6CF8331B7EE68FD8';

function fakeFetch(body: string, status = 200) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    return new Response(body, { status });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

describe('checkPasswordBreach', () => {
  it('sends only the 5-character SHA-1 prefix, never the password or full hash', async () => {
    const { fn, calls } = fakeFetch('');
    await checkPasswordBreach('password', fn);
    expect(calls).toEqual([`https://api.pwnedpasswords.com/range/${PREFIX}`]);
    expect(calls[0]).not.toContain(SUFFIX);
    expect(calls[0].endsWith(`/range/${PREFIX}`)).toBe(true); // the path carries only the prefix
  });

  it('reports breached when the suffix appears with a positive count', async () => {
    const { fn } = fakeFetch(`0000000000000000000000000000000000A:0\n${SUFFIX}:3861493\n`);
    expect(await checkPasswordBreach('password', fn)).toBe('breached');
  });

  it('reports clean when the suffix is absent', async () => {
    const { fn } = fakeFetch('ABCDEF0123456789ABCDEF0123456789ABC:4\n');
    expect(await checkPasswordBreach('a-long-unique-phrase-91', fn)).toBe('clean');
  });

  it('treats padding entries (count 0) as clean', async () => {
    const { fn } = fakeFetch(`${SUFFIX}:0\n`);
    expect(await checkPasswordBreach('password', fn)).toBe('clean');
  });

  it('returns unknown on HTTP error, network failure or timeout', async () => {
    const http500 = fakeFetch('oops', 500);
    expect(await checkPasswordBreach('password', http500.fn)).toBe('unknown');

    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await checkPasswordBreach('password', down)).toBe('unknown');
  });
});

describe('parseRangeBody', () => {
  it('tolerates CRLF line endings and whitespace', () => {
    expect(parseRangeBody(`AAAA:1\r\n${SUFFIX}:7 \r\n`, SUFFIX)).toBe(true);
  });

  it('does not match a suffix that is only a prefix of another line', () => {
    expect(parseRangeBody(`${SUFFIX}X:9\n`, SUFFIX)).toBe(false);
  });
});
