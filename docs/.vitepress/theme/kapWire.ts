import fs from 'node:fs'
import path from 'node:path'
import type MarkdownIt from 'markdown-it'

const VERBS = 'GET|POST|DELETE|PUT|PATCH'
const ROUTING_KEYS = new Set(['"session_id"', '"agent_id"', '"turn_id"', '"request_id"'])

const escapeHtml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;')

const span = (cls: string, text: string): string => `<span class="${cls}">${escapeHtml(text)}</span>`

const JSON_TOKEN =
  /(?<key>"(?:[^"\\]|\\.)*")(?=\s*:)|(?<str>"(?:[^"\\]|\\.)*")|(?<num>-?\d+(?:\.\d+)?)|(?<lit>true|false|null)|(?<ws>\s+)|(?<punct>.)/gu
const JSON_CLASS: Record<string, string> = {
  key: 'f',
  str: 's',
  num: 'n',
  lit: 'pr',
  punct: 'p',
}

function wireJsonSpans(text: string): string {
  const tokens = [...text.matchAll(JSON_TOKEN)].map((m) => {
    const groups = m.groups ?? {}
    const kind = Object.keys(groups).find((name) => groups[name] !== undefined) ?? 'punct'
    return { kind, text: m[0] }
  })
  let out = ''
  for (let i = 0; i < tokens.length; i++) {
    const { kind, text: token } = tokens[i]
    if (kind === 'ws') {
      out += token
      continue
    }
    if (kind !== 'key') {
      out += span(JSON_CLASS[kind] ?? 'p', token)
      continue
    }
    let j = i + 1
    while (
      j < tokens.length &&
      tokens[j].kind !== 'str' &&
      tokens[j].kind !== 'num' &&
      tokens[j].kind !== 'lit'
    ) {
      if (tokens[j].kind === 'punct' && tokens[j].text !== ':') break
      j++
    }
    const hasValue = j < tokens.length && tokens[j].kind !== 'punct'
    if (!hasValue || (token !== '"type"' && !ROUTING_KEYS.has(token))) {
      out += span('f', token)
      continue
    }
    const pair = tokens
      .slice(i, j + 1)
      .map((t, k) => {
        if (t.kind === 'ws') return t.text
        if (k === 0) return span('f', t.text)
        return span(t.kind === 'str' && token === '"type"' ? 'wt' : (JSON_CLASS[t.kind] ?? 'p'), t.text)
      })
      .join('')
    out += token === '"type"' ? pair : `<span class="route-f">${pair}</span>`
    i = j
  }
  return out
}

interface WireAstScalar {
  t: 'str' | 'num' | 'lit' | 'ell'
  v?: string
}

interface WireAstEntry {
  ell?: boolean
  key?: string
  value?: WireAstNode
}

interface WireAstCollection {
  t: 'obj' | 'arr'
  entries: WireAstEntry[]
}

type WireAstNode = WireAstScalar | WireAstCollection

const WIRE_TOKEN =
  /(?<str>"(?:[^"\\]|\\.)*")|(?<num>-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(?<lit>true|false|null)|(?<ell>…|\.\.\.)|(?<p>[{}[\],:])/uy

function parseWireJson(text: string): WireAstCollection | null {
  const tokens: { kind: string; text: string }[] = []
  for (let pos = 0; pos < text.length; ) {
    if (/\s/.test(text[pos])) {
      pos++
      continue
    }
    WIRE_TOKEN.lastIndex = pos
    const m = WIRE_TOKEN.exec(text)
    if (!m || !m.groups) return null
    const kind = Object.keys(m.groups).find((name) => m.groups?.[name] !== undefined) ?? 'p'
    tokens.push({ kind, text: kind === 'ell' ? '…' : m[0] })
    pos = WIRE_TOKEN.lastIndex
  }
  let i = 0
  const fail = (): never => {
    throw new Error('wire json')
  }
  const take = (expected: string) => (tokens[i]?.text === expected ? tokens[i++] : fail())
  const value = (): WireAstNode => {
    const token = tokens[i++] ?? fail()
    if (token.kind === 'ell') return { t: 'ell' }
    if (token.kind !== 'p') return { t: token.kind as 'str' | 'num' | 'lit', v: token.text }
    if (token.text !== '{' && token.text !== '[') fail()
    const isObj = token.text === '{'
    const close = isObj ? '}' : ']'
    const entries: WireAstEntry[] = []
    if (tokens[i]?.text === close) {
      i++
      return { t: isObj ? 'obj' : 'arr', entries }
    }
    for (;;) {
      if (tokens[i]?.kind === 'ell') {
        i++
        entries.push({ ell: true })
      } else if (isObj) {
        const key = tokens[i++]
        if (key?.kind !== 'str') fail()
        take(':')
        entries.push({ key: key.text, value: value() })
      } else {
        entries.push({ value: value() })
      }
      if (tokens[i]?.text === close) {
        i++
        break
      }
      take(',')
    }
    return { t: isObj ? 'obj' : 'arr', entries }
  }
  try {
    const root = value()
    return i === tokens.length && root.t === 'obj' ? root : null
  } catch {
    return null
  }
}

const isNode = (v: WireAstNode): v is WireAstCollection => v.t === 'obj' || v.t === 'arr'
const brackets = (v: WireAstCollection): [string, string] => (v.t === 'obj' ? ['{', '}'] : ['[', ']'])

function plainOf(v: WireAstNode): string {
  if (v.t === 'ell') return '…'
  if (!isNode(v)) return v.v ?? ''
  const [open, close] = brackets(v)
  if (v.entries.length === 0) return `${open}${close}`
  const parts = v.entries.map((e) =>
    e.ell || !e.value ? '…' : `${e.key ? `${e.key}: ` : ''}${plainOf(e.value)}`,
  )
  return `${open} ${parts.join(', ')} ${close}`
}

function scalarHtml(v: WireAstNode, key?: string | null, top = false): string {
  if (v.t === 'ell') return span('p', '…')
  if (v.t === 'str') return span(top && key === '"type"' ? 'wt' : 's', v.v ?? '')
  return span(v.t === 'num' ? 'n' : 'pr', !isNode(v) ? (v.v ?? '') : '')
}

function pairHtml(key: string, valueHtmlStr: string, focused = false): string {
  const pair = `${span('f', key)}${span('p', ':')} ${valueHtmlStr}`
  const routed = ROUTING_KEYS.has(key) ? `<span class="route-f">${pair}</span>` : pair
  return focused ? `<span class="fx">${routed}</span>` : routed
}

function focusSplit(focus: string[][]): { here: Set<string>; below: Map<string, string[][]> } {
  const here = new Set<string>()
  const below = new Map<string, string[][]>()
  for (const path of focus) {
    const [head, ...rest] = path
    if (!head) continue
    if (rest.length === 0) here.add(head)
    else below.set(head, [...(below.get(head) ?? []), rest])
  }
  return { here, below }
}

function inlineHtml(v: WireAstNode, key?: string | null): string {
  if (!isNode(v)) return scalarHtml(v, key)
  const [open, close] = brackets(v)
  if (v.entries.length === 0) return span('p', `${open}${close}`)
  const parts = v.entries.map((e) => {
    if (e.ell || !e.value) return span('p', '…')
    return e.key ? pairHtml(e.key, inlineHtml(e.value, e.key)) : inlineHtml(e.value)
  })
  return `${span('p', open)} ${parts.join(`${span('p', ',')} `)} ${span('p', close)}`
}

const SHORT_NODE = 38
const PREVIEW_ENTRIES = 3
const PREVIEW_CHARS = 56

function valueHtml(v: WireAstNode, key: string | null | undefined, focus: string[][], isEn: boolean): string {
  if (!isNode(v)) return scalarHtml(v, key)
  if (focus.length === 0 && plainOf(v).length <= SHORT_NODE) return inlineHtml(v, key)
  const expandTitle = isEn ? 'Expand' : '展开'
  return `<span class="jn${focus.length > 0 ? ' jf' : ''}"><span class="jp" role="button" tabindex="0" title="${expandTitle}">${previewHtml(v, focus, isEn)}</span><span class="jx">${blockHtml(v, focus, isEn)}</span></span>`
}

function arrayPreviewHtml(v: WireAstCollection, focus: string[][], isEn: boolean): string {
  const shown = v.entries
    .slice(0, 2)
    .map((e) => (e.ell || !e.value ? span('p', '…') : valueHtml(e.value, null, focus, isEn)))
  if (v.entries.length > 2) shown.push(span('p', '…'))
  return `${span('p', '[')}${shown.join(`${span('p', ',')} `)}${span('p', ']')}`
}

function previewHtml(v: WireAstCollection, focus: string[][], isEn: boolean): string {
  if (v.t === 'arr' && focus.length > 0) return arrayPreviewHtml(v, focus, isEn)
  const [open, close] = brackets(v)
  const { here, below } = focusSplit(focus)
  const parts: string[] = []
  let used = 0
  let skipped = false
  const maxEntries = focus.length > 0 ? 1 : PREVIEW_ENTRIES
  const maxChars = focus.length > 0 ? 24 : PREVIEW_CHARS
  v.entries.forEach((e, index) => {
    const keyName = e.key?.slice(1, -1)
    const focused = Boolean(keyName && (here.has(keyName) || below.has(keyName)))
    const fits = index < maxEntries && used < maxChars
    if (!focused && !fits) {
      skipped = true
      return
    }
    if (skipped && parts.at(-1) !== span('p', '…')) parts.push(span('p', '…'))
    skipped = false
    if (e.ell || !e.value) {
      if (parts.at(-1) !== span('p', '…')) parts.push(span('p', '…'))
      return
    }
    let inner: string
    if (focused && keyName && here.has(keyName)) inner = inlineHtml(e.value, e.key)
    else if (focused && keyName) inner = valueHtml(e.value, e.key, below.get(keyName) ?? [], isEn)
    else if (isNode(e.value))
      inner = span(
        'p',
        plainOf(e.value).length <= 12
          ? plainOf(e.value)
          : `${brackets(e.value)[0]}…${brackets(e.value)[1]}`,
      )
    else inner = scalarHtml(e.value, e.key)
    used += (keyName ?? '').length + plainOf(e.value).length + 2
    const label = e.key && keyName ? `${span('f pk', keyName)}${span('p', ':')} ${inner}` : inner
    parts.push(focused && keyName && here.has(keyName) ? `<span class="fx">${label}</span>` : label)
  })
  if (skipped && parts.at(-1) !== span('p', '…')) parts.push(span('p', '…'))
  return `${span('p', open)}${parts.join(`${span('p', ',')} `)}${span('p', close)}`
}

function blockHtml(v: WireAstCollection, focus: string[][], isEn: boolean, top = false): string {
  const [open, close] = brackets(v)
  const { here, below } = focusSplit(focus)
  const lines = v.entries.map((e, index) => {
    const comma = index < v.entries.length - 1 ? span('p', ',') : ''
    if (e.ell || !e.value) return `<span class="jl">${span('p', '…')}${comma}</span>`
    if (!e.key)
      return `<span class="jl">${valueHtml(e.value, null, v.t === 'arr' ? focus : [], isEn)}${comma}</span>`
    const name = e.key.slice(1, -1)
    const inner = isNode(e.value)
      ? valueHtml(e.value, e.key, below.get(name) ?? [], isEn)
      : scalarHtml(e.value, e.key, top)
    return `<span class="jl">${pairHtml(e.key, inner, here.has(name))}${comma}</span>`
  })
  const collapseTitle = isEn ? 'Collapse' : '折叠'
  return `<span class="jt" role="button" tabindex="0" title="${collapseTitle}">${span('p', open)}</span>${lines.join('')}${span('p', close)}`
}

const ROOT_FULL = 92
const ROOT_BUDGET = 56
const ROOT_FIELDS = 4

function rootEntryHtml(
  e: WireAstEntry,
  here: Set<string>,
  below: Map<string, string[][]>,
  isEn: boolean,
): string {
  if (!e.key || !e.value) return span('p', '…')
  const name = e.key.slice(1, -1)
  let inner: string
  if (here.has(name)) inner = isNode(e.value) ? inlineHtml(e.value, e.key) : scalarHtml(e.value, e.key, true)
  else if (isNode(e.value)) inner = valueHtml(e.value, e.key, below.get(name) ?? [], isEn)
  else inner = scalarHtml(e.value, e.key, true)
  return pairHtml(e.key, inner, here.has(name))
}

function rootHtml(root: WireAstCollection, focus: string[][], isEn: boolean): string {
  const { here, below } = focusSplit(focus)
  const all = root.entries.map((e) => (e.ell ? span('p', '…') : rootEntryHtml(e, here, below, isEn)))
  const inline = `${span('p', '{')} ${all.join(`${span('p', ',')} `)} ${span('p', '}')}`
  if (plainOf(root).length <= ROOT_FULL) return inline
  const expandTitle = isEn ? 'Expand all fields' : '展开全部字段'
  const expand = `<span class="je" role="button" tabindex="0" title="${expandTitle}">…</span>`
  const parts: string[] = []
  const maxFields = focus.length > 0 ? 2 : ROOT_FIELDS
  const maxBudget = focus.length > 0 ? 28 : ROOT_BUDGET
  let budget = 0
  let fields = 0
  let hidden = false
  for (const e of root.entries) {
    if (e.ell || !e.key || !e.value) {
      hidden = true
      continue
    }
    const name = e.key.slice(1, -1)
    const wanted = here.has(name) || below.has(name)
    const length = name.length + Math.min(plainOf(e.value).length, 40)
    const filler =
      !wanted &&
      name !== 'type' &&
      !ROUTING_KEYS.has(e.key) &&
      fields < maxFields &&
      budget + length <= maxBudget
    if (name !== 'type' && !wanted && !filler) {
      hidden = true
      continue
    }
    if (hidden && parts.length > 0) parts.push(expand)
    hidden = false
    if (filler) {
      fields++
      budget += length
    }
    parts.push(rootEntryHtml(e, here, below, isEn))
  }
  if (hidden) parts.push(expand)
  if (!parts.includes(expand)) return inline
  const preview = `${span('p', '{')} ${parts.join(`${span('p', ',')} `)} ${span('p', '}')}`
  return `<span class="jn jr"><span class="jq">${preview}</span><span class="jx">${blockHtml(root, focus, isEn, true)}</span></span>`
}

export function formatEndpointPath(path: string): string {
  return escapeHtml(path)
    .replaceAll('/', '/<wbr>')
    .replaceAll(/\{([a-z_]+)\}/g, '<span class="tp">{$1}</span>')
    .replaceAll(/(?<![\w/]):([a-z][\w-]*)/g, '<span class="act">:$1</span>')
}

function wireLine(line: string, first: boolean): string {
  const indent = line.length - line.trimStart().length
  const body = line.trimStart()
  const http = first ? body.match(new RegExp(`^(${VERBS}) (\\S+)$`)) : null
  let inner: string
  if (http) {
    inner = `<span class="verb ${http[1].toLowerCase()}">${http[1]}</span> <span class="wpath">${formatEndpointPath(http[2])}</span>`
  } else if (/^[{}[\]"…]/.test(body)) {
    inner = wireJsonSpans(body)
  } else {
    inner = `<span class="wire-note">${escapeHtml(body)}</span>`
  }
  return `<span class="ln" style="--i:${indent}ch">${inner}</span>`
}

function wirePayload(text: string): string {
  return text
    .split('\n')
    .map((line, i) => wireLine(line, i === 0))
    .join('')
}

function framePayload(side: string, text: string, focus: string[][], isEn: boolean): string | null {
  let head = ''
  let body = text
  if (side === 'H') {
    const [first, ...rest] = text.split('\n')
    const http = first.trim().match(new RegExp(`^(${VERBS}) (\\S+)$`))
    if (!http) return null
    head = `<span class="verb ${http[1].toLowerCase()}">${http[1]}</span> <span class="wpath">${formatEndpointPath(http[2])}</span>`
    body = rest.join('\n')
    if (!body.trim()) return head
  }
  const root = parseWireJson(body)
  if (!root) return null
  const json = rootHtml(root, focus, isEn)
  return head ? `${head}<span class="jb">${json}</span>` : json
}

const WIRE_SIDES_ZH: Record<string, [string, string, string]> = {
  C: ['c', '客户端', 'WebSocket：客户端发给服务端'],
  S: ['s', '服务端', 'WebSocket：服务端发给客户端'],
  H: ['h', 'HTTP', 'HTTP 请求'],
  R: ['r', '响应', 'HTTP 响应'],
}

const WIRE_SIDES_EN: Record<string, [string, string, string]> = {
  C: ['c', 'Client', 'WebSocket: client to server'],
  S: ['s', 'Server', 'WebSocket: server to client'],
  H: ['h', 'HTTP', 'HTTP request'],
  R: ['r', 'Reply', 'HTTP response'],
}

export function renderKapWireBlock(rawContent: string, info: string, isEn = false): string {
  const focusMatch = info.match(/(?:data-)?focus=(?:"([^"]*)"|([^\s"]+))/)
  const focusRaw = focusMatch?.[1] ?? focusMatch?.[2] ?? ''
  const focus = focusRaw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.split('.'))

  const frames: { side: string | null; text: string }[] = []
  for (const line of rawContent.split('\n')) {
    if (!line.trim()) continue
    const m = line.match(/^([CSHR])\s+(.*)$/)
    if (m) {
      frames.push({ side: m[1], text: m[2] })
    } else if (line.startsWith('… ') || line.startsWith('... ')) {
      frames.push({ side: null, text: line.replace(/^(?:…|\.\.\.)\s+/, '') })
    } else if (frames.length > 0) {
      frames.at(-1).text += `\n${line}`
    }
  }

  const sides = isEn ? WIRE_SIDES_EN : WIRE_SIDES_ZH
  const rows = frames.map(({ side, text }) => {
    if (side === null) {
      return `<div class="fr fr-gap"><span class="who"></span><span class="wire-note">${escapeHtml(text)}</span></div>`
    }
    const [cls, label, title] = sides[side]
    const folded = framePayload(side, text, focus, isEn)
    const code = folded === null ? `<code>${wirePayload(text)}</code>` : `<code class="jv">${folded}</code>`
    return `<div class="fr fr-${cls}"><span class="who" title="${title}">${label}</span>${code}</div>`
  })

  const hasFolded = rows.some((r) => r.includes('class="jn'))
  const expandLabel = isEn ? 'Expand all' : '全部展开'
  const copyLabel = isEn ? 'Copy' : '复制'
  const toolsHtml = `<div class="wire-tools">${
    hasFolded
      ? `<button type="button" class="wire-toggle" data-open-text="${isEn ? 'Collapse all' : '全部折叠'}" data-closed-text="${expandLabel}">${expandLabel}</button>`
      : ''
  }<button type="button" class="wire-copy" data-copied-text="${isEn ? 'Copied' : '已复制'}" data-copy-text="${copyLabel}">${copyLabel}</button></div>`

  const source = frames.map(({ side, text }) => `${side ?? '…'} ${text}`).join('\n')
  return `<div class="kap-wire" v-pre data-source="${escapeHtml(source)}">${rows.join('')}${toolsHtml}</div>`
}

export function installKapMarkdownPlugin(md: MarkdownIt): void {
  const defaultFence =
    md.renderer.rules.fence ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const info = token.info.trim()
    if (info === 'wire' || info.startsWith('wire ')) {
      const rawRelativePath = (env as { relativePath?: unknown } | undefined)?.relativePath
      const relativePath = typeof rawRelativePath === 'string' ? rawRelativePath : ''
      const isEn = relativePath.startsWith('en/')
      return renderKapWireBlock(token.content, info, isEn)
    }
    return defaultFence(tokens, idx, options, env, self)
  }

  const defaultCodeInline =
    md.renderer.rules.code_inline ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

  md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
    const content = tokens[idx].content.trim()
    const routeMatch = content.match(new RegExp(`^(${VERBS})\\s+(/\\S*)$`))
    if (routeMatch) {
      const [, verb, path] = routeMatch
      return `<code class="kap-ep" v-pre><span class="vb vb-${verb.toLowerCase()}">${verb}</span><span class="ep-path">${formatEndpointPath(path)}</span></code>`
    }
    return defaultCodeInline(tokens, idx, options, env, self)
  }
}

const KAP_SOURCE_FILES = [
  'server-api.md',
  'server-api-conversation.md',
  'server-api-sessions.md',
  'server-api-service.md',
  'server-api-files.md',
]

export function buildSingleFileKapMarkdown(docsRoot: string, locale: 'zh' | 'en' = 'zh'): string {
  const refDir = path.join(docsRoot, locale, 'reference')
  const sections = KAP_SOURCE_FILES.map((file) => {
    let text = fs.readFileSync(path.join(refDir, file), 'utf8')
    text = text.replace(/^<script setup>[\s\S]*?<\/script>\s*/m, '')
    text = text
      .replaceAll(/<ol class="kap-walk">/g, '')
      .replaceAll(/<\/ol>/g, '')
      .replaceAll(/<li>\s*<strong>(.*?)<\/strong>/g, '#### $1')
      .replaceAll(/<\/li>/g, '')
      .replaceAll(/```wire(?:\s+[^\n]*)?\n/g, '```text\n')
    return text.trim()
  })
  return `${sections.join('\n\n---\n\n')}\n`
}

