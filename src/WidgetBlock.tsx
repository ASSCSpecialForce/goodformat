// WidgetBlock: renders ```stats / ```flow / ```cards fences whose body is JSON
// as small chat widgets. Any parse or shape failure returns null so the caller
// falls back to an ordinary CodeBlock.

import type { Key, ReactNode } from 'react'
import { isChartData, renderChart } from './ChartBlock.tsx'
import css from './WidgetBlock.module.css'

export const WIDGET_LANGS = new Set(['stats', 'flow', 'cards', 'chart'])

interface StatItem { label: string; value: string; note: string | undefined }
interface CardItem { icon: string | undefined; title: string; body: string | undefined }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Accept either a bare array or `{ items: [...] }` (plus optional `source`). */
function readItems(raw: unknown): { items: unknown[]; source: string | undefined } | undefined {
  if (Array.isArray(raw)) return { items: raw, source: undefined }
  if (isRecord(raw) && Array.isArray(raw.items)) return { items: raw.items, source: optionalString(raw.source) }
  return undefined
}

/**
 * Close a JSON prefix that is still streaming so it parses: finish an open
 * string, drop a dangling comma, and append the missing `}` / `]`. When that
 * still fails (a half-written key, number, or literal), cut back to the last
 * comma or container opening and close from there.
 * @returns the parsed value, or undefined when no usable prefix exists yet.
 */
export function parsePartialJson(text: string): unknown {
  const stack: string[] = []
  let inString = false
  let escaped = false
  let safe: { end: number; closers: string } | undefined
  const closersOf = (open: readonly string[]) => open.map(c => c === '{' ? '}' : ']').reverse().join('')
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{' || c === '[') {
      stack.push(c)
      safe = { end: i + 1, closers: closersOf(stack) }
    } else if (c === '}' || c === ']') stack.pop()
    else if (c === ',') safe = { end: i, closers: closersOf(stack) }
  }

  // An escape cut mid-sequence cannot be closed; drop the lone backslash.
  let repaired = inString ? `${escaped ? text.slice(0, -1) : text}"` : text
  repaired = repaired.trimEnd().replace(/,$/, '')
  for (const candidate of [repaired + closersOf(stack), safe && text.slice(0, safe.end) + safe.closers]) {
    if (candidate === undefined) continue
    try {
      return JSON.parse(candidate)
    } catch {
      // try the next, shorter candidate
    }
  }
  return undefined
}

/** In partial mode an incomplete item is skipped instead of rejecting the widget. */
function collect<T>(items: unknown[], partial: boolean, read: (item: unknown) => T | undefined): T[] | undefined {
  const out: T[] = []
  for (const item of items) {
    const value = read(item)
    if (value !== undefined) out.push(value)
    else if (!partial) return undefined
  }
  return out
}

function readStat(item: unknown): StatItem | undefined {
  if (!isRecord(item)) return undefined
  const label = optionalString(item.label)
  const value = typeof item.value === 'number' ? String(item.value) : optionalString(item.value)
  if (label === undefined || value === undefined) return undefined
  return { label, value, note: optionalString(item.note) }
}

function readFlowStep(item: unknown): string | undefined {
  return typeof item === 'string' ? item : isRecord(item) ? optionalString(item.text) : undefined
}

function readCard(item: unknown): CardItem | undefined {
  if (!isRecord(item)) return undefined
  const title = optionalString(item.title)
  if (title === undefined) return undefined
  return { icon: optionalString(item.icon), title, body: optionalString(item.body) }
}

/** Text-free placeholder shown while a widget fence is still streaming. */
export function WidgetSkeleton() {
  return (
    <div className={css.frame} aria-busy="true">
      <div className={css.skeletonLine} />
      <div className={css.skeletonLine} />
      <div className={css.skeletonLine} />
    </div>
  )
}

/**
 * Render one widget fence, or null when the body is not a valid widget.
 * @param lang - one of WIDGET_LANGS.
 * @param source - the raw fence body (JSON).
 * @param partial - the body may still be streaming: close the JSON prefix and
 *   render the items that are already complete.
 */
export function renderWidget(lang: string, source: string, key: Key, partial = false): ReactNode | null {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    if (!partial) return null
    raw = parsePartialJson(source)
  }
  if (lang === 'chart') return isChartData(raw) ? renderChart(raw, key, partial) : null
  const parsed = readItems(raw)
  if (parsed === undefined) return null
  const footer = parsed.source === undefined ? null : <div className={css.source}>{parsed.source}</div>

  if (lang === 'stats') {
    const stats = collect(parsed.items, partial, readStat)
    if (stats === undefined || stats.length === 0) return null
    return (
      <div key={key} className={css.frame}>
        <div className={css.statGrid}>
          {stats.map((stat, i) => (
            <div key={i} className={css.stat}>
              <div className={css.statLabel}>{stat.label}</div>
              <div className={css.statValue}>{stat.value}</div>
              {stat.note !== undefined && <div className={css.statNote}>{stat.note}</div>}
            </div>
          ))}
        </div>
        {footer}
      </div>
    )
  }

  if (lang === 'flow') {
    const steps = collect(parsed.items, partial, readFlowStep)
    if (steps === undefined || steps.length === 0) return null
    return (
      <div key={key} className={css.frame}>
        <ol className={css.flow}>
          {steps.map((step, i) => (
            <li key={i} className={css.flowItem}>
              {i > 0 && <div className={css.flowArrow} aria-hidden>↓</div>}
              <div className={i === 0 || i === steps.length - 1 ? css.flowEnd : css.flowStep}>{step}</div>
            </li>
          ))}
        </ol>
        {footer}
      </div>
    )
  }

  const cards = collect(parsed.items, partial, readCard)
  if (cards === undefined || cards.length === 0) return null
  return (
    <div key={key} className={css.frame}>
      <ul className={css.cards}>
        {cards.map((card, i) => (
          <li key={i} className={css.card}>
            <span className={css.cardIcon} aria-hidden>{card.icon ?? '•'}</span>
            <div>
              <div className={css.cardTitle}>{card.title}</div>
              {card.body !== undefined && <div className={css.cardBody}>{card.body}</div>}
            </div>
          </li>
        ))}
      </ul>
      {footer}
    </div>
  )
}
