import React from 'react'
import { PanelLeft } from 'lucide-react'
import { useUIStore } from '../../store/ui'
import { Button } from '../ui/button'

/**
 * TitleBar — cross-platform window drag region.
 * On macOS this provides the hiddenInset space for traffic lights.
 * On Windows it fills the gap at top.
 */
export function TitleBar(): React.ReactElement {
  const { sidebarOpen, toggleSidebar } = useUIStore()
  const isMac = navigator.platform.includes('Mac')

  return (
    <div
      className="titlebar-drag flex items-center shrink-0 border-b border-[var(--color-border)]"
      style={{ height: 'var(--titlebar-height)', minHeight: 'var(--titlebar-height)' }}
    >
      {isMac && (
        /* Space for macOS traffic lights */
        <div style={{ width: 72 }} className="titlebar-no-drag" />
      )}
      {!sidebarOpen && (
        <div className="titlebar-no-drag flex items-center px-2">
          <Button variant="ghost" size="icon" onClick={toggleSidebar}>
            <PanelLeft size={14} />
          </Button>
        </div>
      )}
      <div className="flex-1" />
    </div>
  )
}
