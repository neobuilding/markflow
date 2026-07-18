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
  // 原始换行符：从权威内容（磁盘/数据库）推断，保存时把编辑器规范化后的 LF 还原回去，
  // 避免 CRLF 文件被编辑保存后变成 LF（CodeMirror 内部统一用 \n 表示行分隔符）。
  const eolRef = useRef<'\r\n' | '\n'>('\n')

  useEffect(() => {
    if (!doc) return
    // 切换到另一篇文档：始终以权威内容（磁盘/数据库）覆盖本地草稿
    if (doc.id !== prevIdRef.current) {
      prevIdRef.current = doc.id
      eolRef.current = doc.content.includes('\r\n') ? '\r\n' : '\n'
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
    eolRef.current = doc.content.includes('\r\n') ? '\r\n' : '\n'
    setLocalContent(doc.content)
    setLocalTitle(doc.title)
    savedContentRef.current = doc.content
    savedTitleRef.current = doc.title
    setDirtyState(false)
    useUIStore.getState().setDirty(false)
  }, [doc?.id, doc?.updatedAt]) // eslint-disable-line react-hooks/exhaustive-deps

  // 以磁盘文件本身的换行符为准（异步，覆盖上面的同步推断）：
  // 数据库内容可能被旧版本改写过，磁盘才是行尾真相。仅读取前 64KB，开销可忽略。
  useEffect(() => {
    if (!doc?.filePath) return
    let cancelled = false
    window.api.documents.eol(doc.filePath).then((eol) => {
      if (!cancelled) eolRef.current = eol
    }).catch(() => {})
    return () => { cancelled = true }
  }, [doc?.id, doc?.filePath])

  const setDirty = useCallback((d: boolean) => {
    setDirtyState(d)
    useUIStore.getState().setDirty(d)
  }, [])

  // 保存前把编辑器规范化后的 LF 还原为文档原始换行符，避免改动文件行尾。
  // eol 默认取自 eolRef（异步从磁盘读取的结果）；保存瞬间也可显式传入
  // （见 EditorPane 在保存时再读一次磁盘，作为最终权威来源，避免依赖异步 effect 是否完成）。
  const toDiskFormat = useCallback((text: string, eol: '\r\n' | '\n' = eolRef.current): string => {
    if (eol === '\r\n') {
      return text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
    }
    return text
  }, [])

  // 返回当前推断的原始换行符（保存瞬间 IPC 失败时的回退）
  const getEol = useCallback((): '\r\n' | '\n' => eolRef.current, [])

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
    markSaved,
    toDiskFormat,
    getEol
  }
}
