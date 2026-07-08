import { useState, useCallback, useEffect, useRef } from 'react'
import type { Document } from '../types'
import { useUIStore } from '../store/ui'

export function useLocalDocument(
  doc: Document | null | undefined,
  activeDocumentId: string | null
) {
  const [localContent, setLocalContent] = useState('')
  const [localTitle, setLocalTitle] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [dirty, setDirtyState] = useState(false)

  // 最近一次“已保存”的内容/标题基准，用于计算脏状态
  const savedContentRef = useRef('')
  const savedTitleRef = useRef('')
  // 当前文档 id，用于区分“切换文档”与“同一文档内容刷新”
  const prevIdRef = useRef<string | null>(null)
  // 最新 dirty，供 effect 内判断（避免闭包拿到旧值）
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty

  useEffect(() => {
    if (!doc) return
    // 切换到另一篇文档：始终以权威内容（磁盘/数据库）覆盖本地草稿
    if (doc.id !== prevIdRef.current) {
      prevIdRef.current = doc.id
      setLocalContent(doc.content)
      setLocalTitle(doc.title)
      savedContentRef.current = doc.content
      savedTitleRef.current = doc.title
      setDirtyState(false)
      useUIStore.getState().setDirty(false)
      return
    }
    // 同一文档的权威内容发生变更（保存 / 重载 / 重新打开 / 导入）：
    // 若用户有未保存改动，则不覆盖本地草稿，仅更新“已保存”基准以便后续比较。
    if (dirtyRef.current) {
      savedContentRef.current = doc.content
      savedTitleRef.current = doc.title
      return
    }
    setLocalContent(doc.content)
    setLocalTitle(doc.title)
    savedContentRef.current = doc.content
    savedTitleRef.current = doc.title
    setDirtyState(false)
    useUIStore.getState().setDirty(false)
  }, [doc?.id, doc?.updatedAt]) // eslint-disable-line react-hooks/exhaustive-deps

  const setDirty = useCallback((d: boolean) => {
    setDirtyState(d)
    useUIStore.getState().setDirty(d)
  }, [])

  // 内容变更：仅更新本地草稿并标记脏状态，不再自动写入磁盘
  const handleContentChange = useCallback(
    (newContent: string) => {
      setLocalContent(newContent)
      setDirty(newContent !== savedContentRef.current)
    },
    [setDirty]
  )

  // 标题编辑完成：仅标记脏状态（真正的重命名/写入由 Save / Save As 完成）
  const handleTitleSave = useCallback(() => {
    setEditingTitle(false)
    const trimmed = localTitle.trim()
    if (!trimmed) {
      setLocalTitle(savedTitleRef.current)
      setDirty(false)
      return
    }
    setDirty(trimmed !== savedTitleRef.current)
  }, [localTitle, setDirty])

  // 在 Save / Save As / Reload 成功后调用：把“已保存”基准更新为最新内容/标题
  const markSaved = useCallback((content: string, title: string) => {
    savedContentRef.current = content
    savedTitleRef.current = title
    setLocalContent(content)
    setLocalTitle(title)
    setDirtyState(false)
    useUIStore.getState().setDirty(false)
  }, [])

  return {
    localContent,
    setLocalContent,
    localTitle,
    setLocalTitle,
    editingTitle,
    setEditingTitle,
    handleContentChange,
    handleTitleSave,
    dirty,
    markSaved
  }
}
