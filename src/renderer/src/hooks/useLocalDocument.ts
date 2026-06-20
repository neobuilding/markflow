import { useState, useCallback, useEffect, useRef } from 'react'
import type { Document } from '../types'
import type { UseMutationResult } from '@tanstack/react-query'

export function useLocalDocument(
  doc: Document | null | undefined,
  activeDocumentId: string | null,
  updateMut: UseMutationResult<Document | null, Error, { id: string; updates: { title?: string; content?: string } }, unknown>
) {
  const [localContent, setLocalContent] = useState('')
  const [localTitle, setLocalTitle] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const lastSavedRef = useRef('')

  useEffect(() => {
    if (doc) {
      setLocalContent(doc.content)
      setLocalTitle(doc.title)
      lastSavedRef.current = doc.content
    }
  }, [doc?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleContentChange = useCallback(
    (newContent: string) => {
      setLocalContent(newContent)
      if (activeDocumentId && newContent !== lastSavedRef.current) {
        lastSavedRef.current = newContent
        updateMut.mutate({ id: activeDocumentId, updates: { content: newContent } })
      }
    },
    [activeDocumentId, updateMut]
  )

  const handleTitleSave = useCallback(() => {
    setEditingTitle(false)
    if (activeDocumentId && localTitle !== doc?.title && localTitle.trim()) {
      updateMut.mutate({ id: activeDocumentId, updates: { title: localTitle.trim() } })
    } else {
      setLocalTitle(doc?.title ?? 'Untitled')
    }
  }, [activeDocumentId, localTitle, doc?.title, updateMut])

  return {
    localContent,
    setLocalContent,
    localTitle,
    setLocalTitle,
    editingTitle,
    setEditingTitle,
    handleContentChange,
    handleTitleSave
  }
}
