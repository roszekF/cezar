import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { githubAssetInputSchema, isGitlabAttachmentUrl } from '@open-mercato/cezar-api-client'
import { ProjectScopeProvider } from '@/api/project-scope-context'
import { getGithubAsset } from '@/api/client'
import { GithubMarkdown } from './github-markdown'

vi.mock('@/api/client', () => ({ getGithubAsset: vi.fn() }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

function markdown(body: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><ProjectScopeProvider projectId="demo"><GithubMarkdown>{body}</GithubMarkdown></ProjectScopeProvider></QueryClientProvider>)
}

const upload = '/uploads/0123456789abcdef0123456789abcdef/screenshot.png'
const dataUrl = 'data:image/png;base64,YQ=='

describe('GitLab feedback screenshots', () => {
  it('loads multiple relative and absolute uploads through the authenticated project endpoint', async () => {
    vi.mocked(getGithubAsset).mockResolvedValue({ available: true, dataUrl })
    const absolute = `https://gitlab.example.test:4443/group/sub/demo${upload}`
    markdown(`![First](${upload})\n\n![Second](${absolute})`)
    await waitFor(() => expect(screen.getByRole('img', { name: 'First' }).getAttribute('src')).toBe(dataUrl))
    expect(screen.getByRole('img', { name: 'Second' }).getAttribute('src')).toBe(dataUrl)
    expect(getGithubAsset).toHaveBeenCalledTimes(2)
    expect(vi.mocked(getGithubAsset).mock.calls.every((call) => call[2] === 'demo')).toBe(true)
    expect(vi.mocked(getGithubAsset).mock.calls.map(([source]) => source)).toEqual([upload, absolute])
  })

  it('does not load ordinary external images with forge credentials', () => {
    markdown('![External](https://example.org/picture.png)')
    expect(screen.getByRole('img', { name: 'External' }).getAttribute('src')).toBe('https://example.org/picture.png')
    expect(getGithubAsset).not.toHaveBeenCalled()
  })

  it('keeps GitHub attachment loading working', async () => {
    vi.mocked(getGithubAsset).mockResolvedValue({ available: true, dataUrl })
    markdown('![GitHub](https://github.com/user-attachments/assets/01234567-89ab-cdef-0123-456789abcdef)')
    await waitFor(() => expect(screen.getByRole('img', { name: 'GitHub' }).getAttribute('src')).toBe(dataUrl))
  })

  it('accepts upload syntax without treating it as project authorization', () => {
    expect(githubAssetInputSchema.safeParse({ url: upload }).success).toBe(true)
    for (const value of [upload + '?token=secret', upload + '#fragment', 'http://gitlab.example.test' + upload, 'https://user:token@gitlab.example.test' + upload, '/uploads/short/image.png']) {
      expect(isGitlabAttachmentUrl(value), value).toBe(false)
    }
  })
})
