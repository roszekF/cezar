import { describe, expect, it } from 'vitest'

import { DEFAULT_COCKPIT_ORIGIN, bookmarkletUrl, gitlabHostsFromProjects } from './bookmarklet'

/** The program text a browser would actually execute when the bookmarklet is clicked. */
const program = (url: string) => decodeURIComponent(url.replace(/^javascript:/, ''))

describe('bookmarkletUrl (spec 011, protected /new deep-link contract)', () => {
  it('is a javascript: URL wrapping one URI-encoded expression', () => {
    const url = bookmarkletUrl('om-fix', true, 'sekret')
    expect(url.startsWith('javascript:')).toBe(true)
    // The raw URL carries no whitespace or double quotes — it must survive a bookmarks bar.
    expect(url).not.toMatch(/[\s"]/)
  })

  it('the generic launcher (no skill) omits skill= and never auto-starts', () => {
    const code = program(bookmarkletUrl('', false, 'sekret'))
    expect(code).toContain(`q='auto=0&key=sekret&ref='`)
    expect(code).not.toContain('skill=')
  })

  it('a per-skill launcher bakes skill=, the auto flag and the launch key into /new', () => {
    const code = program(bookmarkletUrl('om-fix', true, 'sekret'))
    expect(code).toContain(`q='skill=om-fix&auto=1&key=sekret&ref='`)
    expect(code).toContain(`/new?'+q`)
  })

  it('opens the baked cockpit origin directly — no CSP-blocked localhost fetch', () => {
    // GitHub's CSP blocks fetch/XHR to localhost, so the launcher must NAVIGATE, not probe.
    const code = program(bookmarkletUrl('om-fix', true, 'sekret', 'http://localhost:4327'))
    expect(code).toContain(`open('http://localhost:4327/new?'+q,'_blank')`)
    expect(code).not.toContain('/api/v1/health')
    expect(code).not.toContain('fetch(')
  })

  it('defaults to the cockpit default origin when a caller supplies none', () => {
    const code = program(bookmarkletUrl('', false, ''))
    expect(code).toContain(`open('${DEFAULT_COCKPIT_ORIGIN}/new?'+q,'_blank')`)
    expect(DEFAULT_COCKPIT_ORIGIN).toBe('http://localhost:4321')
  })

  it('the page URL rides along as ref= at click time', () => {
    const code = program(bookmarkletUrl('om-fix', false, 'k'))
    expect(code).toContain(`ref='+encodeURIComponent(location.href)`)
  })

  it("escapes apostrophes in skill and key — they would break the embedded '…' string", () => {
    const code = program(bookmarkletUrl("bob's-skill", false, "k'ey"))
    expect(code).toContain('skill=bob%27s-skill')
    expect(code).toContain('key=k%27ey')
    // No stray apostrophe beyond the intentional string delimiters around the query.
    expect(code).toContain(`q='skill=bob%27s-skill&auto=0&key=k%27ey&ref='`)
  })

  it('names the project in the path when one is given (multi-project spec, step 3.6)', () => {
    const code = program(bookmarkletUrl('om-fix', true, 'acme-key', 'http://localhost:4321', 'acme'))
    expect(code).toContain(`open('http://localhost:4321/p/acme/new?'+q,'_blank')`)
    // Only the PATH gained a prefix — the protected query grammar is character-for-character
    // what it was, and the key is the one that project's cockpit scope will accept.
    expect(code).toContain(`q='skill=om-fix&auto=1&key=acme-key&ref='`)
  })

  it('omits the prefix without a project — byte-identical to the legacy launcher', () => {
    // The single-project spelling must survive verbatim: it is what every already-saved
    // bookmarklet contains, and the cockpit redirects it onto the boot project.
    const scoped = bookmarkletUrl('om-fix', true, 'sekret', 'http://localhost:4327')
    expect(scoped).toBe(bookmarkletUrl('om-fix', true, 'sekret', 'http://localhost:4327', null))
    expect(scoped).toBe(bookmarkletUrl('om-fix', true, 'sekret', 'http://localhost:4327', ''))
    expect(program(scoped)).toContain(`open('http://localhost:4327/new?'+q,'_blank')`)
  })

  it("escapes a project id — a slug with an apostrophe would break the embedded '…' string", () => {
    const code = program(bookmarkletUrl('', false, 'k', 'http://localhost:4321', "o'brien/repo"))
    expect(code).toContain(`open('http://localhost:4321/p/o%27brien%2Frepo/new?'+q,'_blank')`)
    expect(bookmarkletUrl('', false, 'k', 'http://localhost:4321', "o'brien")).not.toMatch(/[\s"]/)
  })

  it('only fires on GitHub PR/issue pages', () => {
    const code = program(bookmarkletUrl('', false, ''))
    expect(code).toContain('github\\.com')
    expect(code).toContain('(pull|issues)')
  })
})

describe('bookmarkletUrl GitLab matcher (spec 2026-08-10-forge-provider-adapters, Step 4.5)', () => {
  it('with no GitLab host known, the matcher and alert are byte-identical to the pre-GitLab output', () => {
    const withoutHosts = bookmarkletUrl('om-fix', true, 'sekret', 'http://localhost:4321', 'acme')
    const explicitlyEmpty = bookmarkletUrl('om-fix', true, 'sekret', 'http://localhost:4321', 'acme', [])
    expect(withoutHosts).toBe(explicitlyEmpty)
    const code = program(withoutHosts)
    expect(code).toContain(
      String.raw`match(/^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/(pull|issues)\/\d+/)`,
    )
    expect(code).toContain(`alert('Open a GitHub PR or issue first')`)
    expect(code).not.toContain('gitlab')
  })

  it('with gitlab.com and a self-managed host, the matcher also accepts GitLab MR/issue URLs on those hosts', () => {
    const code = program(
      bookmarkletUrl('', false, 'k', 'http://localhost:4321', null, ['gitlab.com', 'gitlab.acme.internal']),
    )
    const matcher = new RegExp(
      code.match(/location\.href\.match\(\/(.+?)\/\);/)?.[1] ?? (() => { throw new Error('no matcher found') })(),
    )
    expect(matcher.test('https://gitlab.com/group/sub/repo/-/merge_requests/5')).toBe(true)
    expect(matcher.test('https://gitlab.com/group/repo/-/issues/3')).toBe(true)
    expect(matcher.test('https://gitlab.acme.internal/group/sub/repo/-/merge_requests/5')).toBe(true)
    expect(matcher.test('https://gitlab.acme.internal/group/repo/-/issues/3')).toBe(true)
    // GitHub still matches — this is additive, not a replacement.
    expect(matcher.test('https://github.com/open-mercato/cezar/pull/1')).toBe(true)
    // Rejects a host that is not in the known list.
    expect(matcher.test('https://gitlab.other.example/group/repo/-/merge_requests/5')).toBe(false)
    expect(code).toContain(`alert('Open a GitHub or GitLab pull/merge request or issue first')`)
  })

  it('escapes dots in a GitLab host so it cannot match an arbitrary character in their place', () => {
    const code = program(bookmarkletUrl('', false, 'k', 'http://localhost:4321', null, ['gitlab.acme.internal']))
    expect(code).toContain(String.raw`gitlab\.acme\.internal`)
    const matcher = new RegExp(
      code.match(/location\.href\.match\(\/(.+?)\/\);/)?.[1] ?? (() => { throw new Error('no matcher found') })(),
    )
    // A host with the dot swapped for any other character must NOT match.
    expect(matcher.test('https://gitlabXacmeXinternal/group/repo/-/merge_requests/5')).toBe(false)
  })

  it('rejects a GitLab-shaped path with only one segment', () => {
    const code = program(bookmarkletUrl('', false, 'k', 'http://localhost:4321', null, ['gitlab.com']))
    const matcher = new RegExp(
      code.match(/location\.href\.match\(\/(.+?)\/\);/)?.[1] ?? (() => { throw new Error('no matcher found') })(),
    )
    expect(matcher.test('https://gitlab.com/repo/-/issues/3')).toBe(false)
  })
})

describe('gitlabHostsFromProjects', () => {
  it('always includes gitlab.com even with no registered projects', () => {
    expect(gitlabHostsFromProjects(undefined)).toEqual(['gitlab.com'])
    expect(gitlabHostsFromProjects([])).toEqual(['gitlab.com'])
  })

  it('adds a self-managed host from a forge: gitlab project with a repoUrl', () => {
    const hosts = gitlabHostsFromProjects([
      { forge: 'gitlab', repoUrl: 'https://gitlab.acme.internal/group/sub/repo' },
      { forge: 'github', repoUrl: 'https://github.com/o/r' },
      { forge: 'gitlab' }, // no repoUrl — skipped
      {},
    ])
    expect(hosts).toContain('gitlab.com')
    expect(hosts).toContain('gitlab.acme.internal')
    expect(hosts).not.toContain('github.com')
    expect(hosts).toHaveLength(2)
  })

  it('de-duplicates when a project already lives on gitlab.com', () => {
    const hosts = gitlabHostsFromProjects([{ forge: 'gitlab', repoUrl: 'https://gitlab.com/group/repo' }])
    expect(hosts).toEqual(['gitlab.com'])
  })

  it('skips a malformed repoUrl without throwing', () => {
    expect(() => gitlabHostsFromProjects([{ forge: 'gitlab', repoUrl: 'not a url' }])).not.toThrow()
    expect(gitlabHostsFromProjects([{ forge: 'gitlab', repoUrl: 'not a url' }])).toEqual(['gitlab.com'])
  })
})
