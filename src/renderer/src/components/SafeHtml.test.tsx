import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SafeHtml } from './SafeHtml'

describe('SafeHtml', () => {
  it('renders sanitized HTML via dangerouslySetInnerHTML', () => {
    const { container } = render(<SafeHtml html="<p>hello</p>" />)
    const div = container.firstChild as HTMLElement
    expect(div).toBeInTheDocument()
    expect(div.querySelector('p')?.textContent).toBe('hello')
  })

  it('strips script tags (XSS gate)', () => {
    const { container } = render(<SafeHtml html="<p>ok</p><script>alert(1)</script>" />)
    const div = container.firstChild as HTMLElement
    expect(div.querySelector('script')).toBeNull()
    expect(div.querySelector('p')?.textContent).toBe('ok')
  })

  it('applies the className prop', () => {
    const { container } = render(<SafeHtml html="x" className="preview-body" />)
    expect((container.firstChild as HTMLElement).className).toContain('preview-body')
  })

  it('exposes the element to screen queries', () => {
    render(<SafeHtml html="<span>visible</span>" />)
    expect(screen.getByText('visible')).toBeInTheDocument()
  })
})
