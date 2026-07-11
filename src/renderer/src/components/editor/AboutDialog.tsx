import React, { useEffect, useState } from 'react'
import { Info, Copy } from 'lucide-react'
import { useUIStore } from '../../store/ui'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from '../ui/dialog'
import { Button } from '../ui/button'

export function AboutDialog(): React.ReactElement | null {
  const aboutOpen = useUIStore((s) => s.aboutOpen)
  const setAboutOpen = useUIStore((s) => s.setAboutOpen)
  const [version, setVersion] = useState<string>('…')
  const [copied, setCopied] = useState(false)

  // 每次打开时拉取版本（生产环境为注入的滚动版本号，如 1.0.0-20260111T120000Z.a1b2c3d）
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
      // 忽略剪贴板不可用的情况
    }
  }

  return (
    <Dialog open={aboutOpen} onOpenChange={(o) => { if (!o) close() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Info size={16} className="text-accent" />
            About MarkFlow
          </DialogTitle>
        </DialogHeader>

        <div className="py-1">
          <div className="text-2xs uppercase tracking-wide text-[var(--color-text-tertiary)]">Version</div>
          <div className="text-sm text-[var(--color-text-primary)] font-mono mt-1 flex items-center gap-2">
            {version}
            <Button variant="outline" size="sm" onClick={copyVersion} className="gap-1">
              <Copy size={12} /> {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>

        <p className="text-xs text-[var(--color-text-tertiary)] mt-3 leading-relaxed">
          A privacy-first, local-first Markdown editor. All your data stays on your machine.
        </p>

        <div className="flex items-center justify-end mt-5">
          <DialogClose asChild>
            <Button variant="accent" size="sm">Close</Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  )
}
