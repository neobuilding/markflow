import React, { useEffect, useState } from 'react'
import { FileText, Copy } from 'lucide-react'
import { useUIStore } from '../../store/ui'
import { Dialog, DialogContent, DialogClose, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'

export function AboutDialog(): React.ReactElement | null {
  const aboutOpen = useUIStore((s) => s.aboutOpen)
  const setAboutOpen = useUIStore((s) => s.setAboutOpen)
  const [version, setVersion] = useState<string>('…')
  const [copied, setCopied] = useState(false)

  // Fetch the version each time it opens (in production this is the injected rolling version,
  // e.g. 1.0.0-20260111T120000Z.a1b2c3d)
  useEffect(() => {
    if (!aboutOpen) return
    window.api.app
      .getVersion()
      .then((v) => setVersion(v))
      .catch(() => setVersion('unknown'))
  }, [aboutOpen])

  const close = () => setAboutOpen(false)

  const copyVersion = async () => {
    try {
      await navigator.clipboard.writeText(version)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Ignore when the clipboard is unavailable
    }
  }

  return (
    <Dialog open={aboutOpen} onOpenChange={(o) => { if (!o) close() }}>
      <DialogContent className="max-w-sm">
        {/* Screen-reader-visible title, ensures dialog accessibility */}
        <DialogTitle className="sr-only">About MarkFlow</DialogTitle>

        {/* Brand area: reuses the same logo visual language as the sidebar (FileText + accent square) */}
        <div className="flex flex-col items-center text-center pt-1">
          <div className="w-14 h-14 rounded-2xl bg-accent flex items-center justify-center shadow-lg shadow-accent/20 mb-3">
            <FileText size={28} className="text-white" strokeWidth={2.25} />
          </div>
          <h2 className="text-lg font-semibold text-[var(--color-text-primary)] leading-none">
            MarkFlow
          </h2>
          <p className="text-2xs uppercase tracking-wider text-[var(--color-text-tertiary)] mt-1.5">
            Markdown Editor
          </p>

          {/* Version number (copyable) */}
          <div className="mt-4 flex items-center gap-2 text-sm text-[var(--color-text-primary)] font-mono">
            {version}
            <Button variant="outline" size="sm" onClick={copyVersion} className="gap-1">
              <Copy size={12} /> {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>

        <p className="text-xs text-[var(--color-text-tertiary)] mt-4 leading-relaxed text-center">
          A privacy-first, local-first Markdown editor. All your data stays on your machine.
        </p>

        <div className="flex items-center justify-center mt-5">
          <DialogClose asChild>
            <Button variant="accent" size="sm" className="px-8">Close</Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  )
}
