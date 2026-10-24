// ChartBlock: the ```chart widget. One fence, several statistical forms
// selected by `kind`: bar, line, stacked, range, histogram, box, scatter,
// waterfall. The model supplies raw data; this file derives every geometry
// (scales, bins, quartiles, running totals) so the model never does chart math.

import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, Key, MouseEvent, ReactNode, RefObject } from 'react'
import css from './ChartBlock.module.css'

type Rec = Record<string, unknown>

const CHART_KINDS = new Set(['bar', 'line', 'stacked', 'range', 'histogram', 'box', 'scatter', 'waterfall'])
/** Lines are capped (spaghetti rule); scatter groups are capped to the all-pairs-safe slots. */
const MAX_LINES = 5
const MAX_SCATTER_GROUPS = 3

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
function nums(value: unknown): number[] {
  return list(value).flatMap(v => num(v) ?? [])
}
/** Element at `index` (negative counts from the end); 0 when out of range. */
function at(values: readonly number[], index: number): number {
  return values.at(index) ?? 0
}

// ---------------------------------------------------------------- formatting

function formatNumber(value: number): string {
  const abs = Math.abs(value)
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2
  return value.toLocaleString(undefined, { maximumFractionDigits: digits })
}

function withUnit(value: number, unit: string | undefined): string {
  const text = formatNumber(value)
  if (unit === undefined || unit === '') return text
  return unit === '%' ? `${text}%` : `${text} ${unit}`
}

/** Round tick values covering [min, max]. */
function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) {
    const pad = min === 0 ? 1 : Math.abs(min) * 0.1
    min -= pad
    max += pad
  }
  const raw = (max - min) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? 10 * mag
  const start = Math.floor(min / step) * step
  const ticks: number[] = []
  for (let t = start; t <= max + step * 0.5; t += step) ticks.push(Number(t.toFixed(10)))
  if (at(ticks, -1) < max) ticks.push(Number((at(ticks, -1) + step).toFixed(10)))
  return ticks
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return at(sorted, lo) + (at(sorted, hi) - at(sorted, lo)) * (pos - lo)
}

// ---------------------------------------------------------------- tooltip

interface Tip { x: number; y: number; text: string }

/** One shared hover tooltip for the chart; marks call `show(event, text)`. */
function useTip() {
  const [tip, setTip] = useState<Tip | null>(null)
  const show = (event: MouseEvent, text: string) => {
    const box = (event.currentTarget as Element).closest(`.${css.chart}`)?.getBoundingClientRect()
    if (box === undefined) return
    setTip({ x: event.clientX - box.left, y: event.clientY - box.top, text })
  }
  const hide = () => { setTip(null) }
  const node = tip === null
    ? null
    : <div className={css.tip} style={{ left: tip.x, top: tip.y }} role="tooltip">{tip.text}</div>
  return { show, hide, node }
}

type ShowTip = (event: MouseEvent, text: string) => void

function useWidth(): [RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(560)
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const update = () => { setWidth(Math.max(240, el.clientWidth)) }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [])
  return [ref, width]
}

function seriesColor(index: number): CSSProperties {
  return { '--series': `var(--chart-series-${(index % 8) + 1})` } as CSSProperties
}

function Legend({ names }: { names: string[] }) {
  if (names.length < 2) return null
  return (
    <div className={css.legend}>
      {names.map((name, i) => (
        <span key={i} className={css.legendItem} style={seriesColor(i)}>
          <span className={css.swatch} aria-hidden />
          {name}
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- horizontal (HTML) forms

/** Linear position in percent for a horizontal domain. */
function scaler(lo: number, hi: number) {
  return (v: number) => ((v - lo) / (hi - lo)) * 100
}

function Axis({ ticks, pos, unit }: { ticks: number[]; pos: (v: number) => number; unit: string | undefined }) {
  return (
    <div className={css.row}>
      <span />
      <div className={css.axis}>
        {ticks.map(t => (
          <span key={t} className={css.tick} style={{ left: `${pos(t)}%` }}>{withUnit(t, unit)}</span>
        ))}
      </div>
      <span />
    </div>
  )
}

function Grid({ ticks, pos }: { ticks: number[]; pos: (v: number) => number }) {
  return <>{ticks.map(t => <span key={t} className={css.grid} style={{ left: `${pos(t)}%` }} />)}</>
}

function RefLine({ value, pos }: { value: number | undefined; pos: (v: number) => number }) {
  return value === undefined ? null : <span className={css.refLine} style={{ left: `${pos(value)}%` }} />
}

interface Ref { value: number; label: string | undefined }

function readRef(raw: unknown): Ref | undefined {
  if (!isRecord(raw)) return undefined
  const value = num(raw.value)
  return value === undefined ? undefined : { value, label: str(raw.label) }
}

function RefCaption({ refLine, unit }: { refLine: Ref | undefined; unit: string | undefined }) {
  if (refLine === undefined) return null
  return (
    <div className={css.refCaption}>
      <span className={css.refKey} aria-hidden />
      {refLine.label ?? ''} {withUnit(refLine.value, unit)}
    </div>
  )
}

function BarChart({ data, partial, tip }: { data: Rec; partial: boolean; tip: ShowTip }) {
  const unit = str(data.unit)
  const refLine = readRef(data.ref)
  const baseline = num(data.baseline) ?? 0
  let items = list(data.items).flatMap((item) => {
    if (!isRecord(item)) return []
    const label = str(item.label)
    const value = num(item.value)
    return label === undefined || value === undefined ? [] : [{ label, value, est: item.est === true }]
  })
  if (items.length === 0) return null
  // Nominal categories sort by value; ordinal / time order is kept with "sort": "none".
  if (str(data.sort) !== 'none' && !partial) items = [...items].sort((a, b) => b.value - a.value)
  const values = items.map(i => i.value)
  const bound = refLine?.value ?? baseline
  const ticks = niceTicks(Math.min(baseline, bound, ...values), Math.max(baseline, bound, ...values))
  const pos = scaler(at(ticks, 0), at(ticks, -1))
  const diverging = baseline !== 0 || values.some(v => v < 0)
  return (
    <>
      <div className={css.hbars}>
        {items.map((item, i) => {
          const a = pos(Math.min(baseline, item.value))
          const b = pos(Math.max(baseline, item.value))
          const below = item.value < baseline
          return (
            <div key={i} className={css.row}>
              <span className={css.rowLabel}>{item.label}</span>
              <div className={css.track}>
                <Grid ticks={ticks} pos={pos} />
                <span
                  className={`${css.hbar} ${below ? css.hbarNeg : ''} ${diverging && !below ? css.hbarPos : ''} ${item.est ? css.est : ''}`}
                  style={{ left: `${a}%`, width: `${Math.max(b - a, 0.5)}%` }}
                  onMouseMove={(e) => { tip(e, `${item.label}: ${withUnit(item.value, unit)}${item.est ? ' (est.)' : ''}`) }}
                />
                {diverging && <span className={css.baseLine} style={{ left: `${pos(baseline)}%` }} />}
                <RefLine value={refLine?.value} pos={pos} />
              </div>
              <span className={css.rowValue}>{withUnit(item.value, unit)}{item.est ? '*' : ''}</span>
            </div>
          )
        })}
        <Axis ticks={ticks} pos={pos} unit={unit} />
      </div>
      <RefCaption refLine={refLine} unit={unit} />
    </>
  )
}

function RangeChart({ data, tip }: { data: Rec; tip: ShowTip }) {
  const unit = str(data.unit)
  const refLine = readRef(data.ref)
  const items = list(data.items).flatMap((item) => {
    if (!isRecord(item)) return []
    const label = str(item.label)
    const low = num(item.low)
    const high = num(item.high)
    if (label === undefined || low === undefined || high === undefined) return []
    return [{ label, low: Math.min(low, high), high: Math.max(low, high), value: num(item.value), est: item.est === true }]
  })
  if (items.length === 0) return null
  const all = items.flatMap(i => [i.low, i.high]).concat(refLine === undefined ? [] : [refLine.value])
  const ticks = niceTicks(Math.min(...all), Math.max(...all))
  const pos = scaler(at(ticks, 0), at(ticks, -1))
  return (
    <>
      <div className={css.hbars}>
        {items.map((item, i) => (
          <div key={i} className={css.row}>
            <span className={css.rowLabel}>{item.label}</span>
            <div
              className={css.track}
              onMouseMove={(e) => {
                const mid = item.value === undefined ? '' : `, ${withUnit(item.value, unit)}`
                tip(e, `${item.label}: ${withUnit(item.low, unit)} – ${withUnit(item.high, unit)}${mid}`)
              }}
            >
              <Grid ticks={ticks} pos={pos} />
              <RefLine value={refLine?.value} pos={pos} />
              <span
                className={`${css.range} ${item.est ? css.est : ''}`}
                style={{ left: `${pos(item.low)}%`, width: `${Math.max(pos(item.high) - pos(item.low), 0.5)}%` }}
              />
              {item.value !== undefined && <span className={css.dot} style={{ left: `${pos(item.value)}%` }} />}
            </div>
            <span className={css.rowValue}>
              {withUnit(item.low, unit)}–{withUnit(item.high, unit)}{item.est ? '*' : ''}
            </span>
          </div>
        ))}
        <Axis ticks={ticks} pos={pos} unit={unit} />
      </div>
      <RefCaption refLine={refLine} unit={unit} />
    </>
  )
}

function StackedChart({ data, tip }: { data: Rec; tip: ShowTip }) {
  const groups = list(data.groups).flatMap((group) => {
    if (!isRecord(group)) return []
    const label = str(group.label)
    const parts = list(group.parts).flatMap((part) => {
      if (!isRecord(part)) return []
      const name = str(part.name)
      const value = num(part.value)
      return name === undefined || value === undefined || value < 0 ? [] : [{ name, value }]
    })
    return label === undefined || parts.length === 0 ? [] : [{ label, parts }]
  })
  if (groups.length === 0) return null
  // Color follows the part name across groups, never its position in a group.
  const names: string[] = []
  for (const group of groups) for (const part of group.parts) if (!names.includes(part.name)) names.push(part.name)
  return (
    <>
      <Legend names={names} />
      <div className={css.hbars}>
        {groups.map((group, i) => {
          const total = group.parts.reduce((sum, p) => sum + p.value, 0) || 1
          return (
            <div key={i} className={css.row}>
              <span className={css.rowLabel}>{group.label}</span>
              <div className={css.stack}>
                {group.parts.map((part, j) => {
                  const share = (part.value / total) * 100
                  return (
                    <span
                      key={j}
                      className={css.segment}
                      style={{ ...seriesColor(names.indexOf(part.name)), width: `${share}%` }}
                      onMouseMove={(e) => { tip(e, `${group.label} · ${part.name}: ${formatNumber(share)}%`) }}
                    />
                  )
                })}
              </div>
              <span className={css.rowValue} />
            </div>
          )
        })}
      </div>
    </>
  )
}

function BoxChart({ data, tip }: { data: Rec; tip: ShowTip }) {
  const unit = str(data.unit)
  const groups = list(data.groups).flatMap((group) => {
    if (!isRecord(group)) return []
    const label = str(group.label)
    const values = nums(group.values).sort((a, b) => a - b)
    return label === undefined || values.length < 2 ? [] : [{ label, values }]
  })
  if (groups.length === 0) return null
  const all = groups.flatMap(g => g.values)
  const ticks = niceTicks(Math.min(...all), Math.max(...all))
  const pos = scaler(at(ticks, 0), at(ticks, -1))
  return (
    <div className={css.hbars}>
      {groups.map((group, i) => {
        const v = group.values
        const [q1, med, q3] = [quantile(v, 0.25), quantile(v, 0.5), quantile(v, 0.75)]
        const fence = 1.5 * (q3 - q1)
        const inside = v.filter(x => x >= q1 - fence && x <= q3 + fence)
        const [lo, hi] = [at(inside, 0), at(inside, -1)]
        const outliers = v.filter(x => x < lo || x > hi)
        const text = `${group.label} (n=${v.length}): Q1 ${withUnit(q1, unit)}, median ${withUnit(med, unit)}, Q3 ${withUnit(q3, unit)}`
        return (
          <div key={i} className={css.row}>
            <span className={css.rowLabel}>{group.label}</span>
            <div className={css.track} onMouseMove={(e) => { tip(e, text) }}>
              <Grid ticks={ticks} pos={pos} />
              <span className={css.whisker} style={{ left: `${pos(lo)}%`, width: `${pos(hi) - pos(lo)}%` }} />
              <span className={css.box} style={{ left: `${pos(q1)}%`, width: `${Math.max(pos(q3) - pos(q1), 0.5)}%` }} />
              <span className={css.median} style={{ left: `${pos(med)}%` }} />
              {outliers.map((x, k) => <span key={k} className={css.outlier} style={{ left: `${pos(x)}%` }} />)}
            </div>
            <span className={css.rowValue}>n={v.length}</span>
          </div>
        )
      })}
      <Axis ticks={ticks} pos={pos} unit={unit} />
    </div>
  )
}

// ---------------------------------------------------------------- SVG forms

const PAD = { top: 12, right: 16, bottom: 28, left: 52 }
const PLOT_HEIGHT = 220

interface Frame { width: number; x: (i: number) => number; y: (v: number) => number; ticks: number[] }

function yFrame(width: number, values: number[], count: number, includeZero: boolean, band: boolean): Frame {
  const ticks = niceTicks(Math.min(...values, ...(includeZero ? [0] : [])), Math.max(...values, ...(includeZero ? [0] : [])))
  const lo = at(ticks, 0)
  const hi = at(ticks, -1)
  const inner = width - PAD.left - PAD.right
  const x = band
    ? (i: number) => PAD.left + (inner / count) * (i + 0.5)
    : (i: number) => PAD.left + (count <= 1 ? inner / 2 : (inner / (count - 1)) * i)
  const y = (v: number) => PAD.top + PLOT_HEIGHT - ((v - lo) / (hi - lo)) * PLOT_HEIGHT
  return { width, x, y, ticks }
}

function YAxis({ frame, unit }: { frame: Frame; unit: string | undefined }) {
  return (
    <g>
      {frame.ticks.map(t => (
        <g key={t}>
          <line className={css.svgGrid} x1={PAD.left} x2={frame.width - PAD.right} y1={frame.y(t)} y2={frame.y(t)} />
          <text className={css.svgTick} x={PAD.left - 6} y={frame.y(t)} textAnchor="end" dominantBaseline="middle">
            {withUnit(t, unit)}
          </text>
        </g>
      ))}
    </g>
  )
}

/** Show at most ~8 x labels so they never collide. */
function XLabels({ frame, labels }: { frame: Frame; labels: string[] }) {
  const every = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor((frame.width - PAD.left) / 70))))
  return (
    <g>
      {labels.map((label, i) => (i % every === 0 || i === labels.length - 1) && (
        <text key={i} className={css.svgTick} x={frame.x(i)} y={PAD.top + PLOT_HEIGHT + 18} textAnchor="middle">{label}</text>
      ))}
    </g>
  )
}

function SvgRef({ frame, refLine }: { frame: Frame; refLine: Ref | undefined }) {
  if (refLine === undefined) return null
  return <line className={css.svgRef} x1={PAD.left} x2={frame.width - PAD.right} y1={frame.y(refLine.value)} y2={frame.y(refLine.value)} />
}

function LineChart({ data, width, tip }: { data: Rec; width: number; tip: ShowTip }) {
  const unit = str(data.unit)
  const refLine = readRef(data.ref)
  const x = list(data.x).map(v => (typeof v === 'number' ? String(v) : str(v) ?? ''))
  const series = list(data.series).slice(0, MAX_LINES).flatMap((s) => {
    if (!isRecord(s)) return []
    const name = str(s.name) ?? ''
    const values = list(s.values).map(v => num(v) ?? null)
    const estFrom = num(s.estFrom) ?? (typeof s.estFrom === 'string' ? x.indexOf(s.estFrom) : -1)
    return values.some(v => v !== null) ? [{ name, values, estFrom: estFrom < 0 ? Infinity : estFrom }] : []
  })
  if (series.length === 0 || x.length === 0) return null
  const all = series.flatMap(s => s.values.flatMap(v => v ?? [])).concat(refLine === undefined ? [] : [refLine.value])
  const frame = yFrame(width, all, x.length, false, false)
  const path = (points: Array<[number, number]>) => points.map(([i, v], k) => `${k === 0 ? 'M' : 'L'}${frame.x(i)},${frame.y(v)}`).join('')
  return (
    <>
      <Legend names={series.map(s => s.name)} />
      <svg className={css.svg} width={width} height={PLOT_HEIGHT + PAD.top + PAD.bottom} role="img" aria-label={str(data.title)}>
        <YAxis frame={frame} unit={unit} />
        <SvgRef frame={frame} refLine={refLine} />
        <XLabels frame={frame} labels={x} />
        {series.map((s, si) => {
          const points = s.values.flatMap((v, i): Array<[number, number]> => (v === null || i >= x.length ? [] : [[i, v]]))
          // Actual points solid. The segment into the first estimated point and
          // everything after it are dashed, starting from the last actual point.
          const firstEst = points.findIndex(([i]) => i >= s.estFrom)
          const actual = firstEst < 0 ? points : points.slice(0, firstEst)
          const est = firstEst < 0 ? [] : points.slice(Math.max(0, firstEst - 1))
          const last = points[points.length - 1]
          return (
            <g key={si} style={seriesColor(si)}>
              {actual.length > 1 && <path className={css.line} d={path(actual)} />}
              {est.length > 1 && <path className={`${css.line} ${css.lineEst}`} d={path(est)} />}
              {points.map(([i, v]) => (
                <circle
                  key={i}
                  className={css.hit}
                  cx={frame.x(i)}
                  cy={frame.y(v)}
                  r={10}
                  onMouseMove={(e) => { tip(e, `${s.name ? `${s.name} · ` : ''}${x[i]}: ${withUnit(v, unit)}${i >= s.estFrom ? ' (est.)' : ''}`) }}
                />
              ))}
              {last !== undefined && <circle className={css.endDot} cx={frame.x(last[0])} cy={frame.y(last[1])} r={4} />}
            </g>
          )
        })}
      </svg>
      <RefCaption refLine={refLine} unit={unit} />
    </>
  )
}

function Columns({ frame, items, tip, base }: {
  frame: Frame
  items: Array<{ label: string; from: number; to: number; tone: string | undefined; text: string }>
  tip: ShowTip
  base: number
}) {
  const band = (frame.width - PAD.left - PAD.right) / Math.max(items.length, 1)
  const barWidth = Math.min(24, band * 0.7)
  return (
    <g>
      <line className={css.svgBase} x1={PAD.left} x2={frame.width - PAD.right} y1={frame.y(base)} y2={frame.y(base)} />
      {items.map((item, i) => {
        const top = frame.y(Math.max(item.from, item.to))
        const height = Math.max(Math.abs(frame.y(item.from) - frame.y(item.to)), 1)
        return (
          <rect
            key={i}
            className={`${css.column} ${item.tone ?? ''}`}
            x={frame.x(i) - barWidth / 2}
            y={top}
            width={barWidth}
            height={height}
            rx={2}
            onMouseMove={(e) => { tip(e, item.text) }}
          />
        )
      })}
    </g>
  )
}

function HistogramChart({ data, width, tip }: { data: Rec; width: number; tip: ShowTip }) {
  const unit = str(data.unit)
  const values = nums(data.values)
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  // Sturges' rule unless the model fixes the bin count.
  const binCount = Math.max(1, Math.min(40, Math.round(num(data.bins) ?? Math.ceil(Math.log2(values.length) + 1))))
  const step = (max - min) / binCount || 1
  const counts = Array.from({ length: binCount }, () => 0)
  for (const v of values) {
    const bin = Math.min(binCount - 1, Math.floor((v - min) / step))
    counts[bin] = at(counts, bin) + 1
  }
  const frame = yFrame(width, counts, binCount, true, true)
  return (
    <svg className={css.svg} width={width} height={PLOT_HEIGHT + PAD.top + PAD.bottom} role="img" aria-label={str(data.title)}>
      <YAxis frame={frame} unit={undefined} />
      <Columns
        frame={frame}
        base={0}
        tip={tip}
        items={counts.map((count, i) => ({
          label: '',
          from: 0,
          to: count,
          tone: '',
          text: `${withUnit(min + step * i, unit)} – ${withUnit(min + step * (i + 1), unit)}: ${count}`,
        }))}
      />
      <text className={css.svgTick} x={PAD.left} y={PAD.top + PLOT_HEIGHT + 18} textAnchor="start">{withUnit(min, unit)}</text>
      <text className={css.svgTick} x={width - PAD.right} y={PAD.top + PLOT_HEIGHT + 18} textAnchor="end">{withUnit(max, unit)}</text>
    </svg>
  )
}

function WaterfallChart({ data, width, tip }: { data: Rec; width: number; tip: ShowTip }) {
  const unit = str(data.unit)
  const start = isRecord(data.start) ? { label: str(data.start.label) ?? '', value: num(data.start.value) } : undefined
  if (start?.value === undefined) return null
  const steps = list(data.steps).flatMap((s) => {
    if (!isRecord(s)) return []
    const label = str(s.label)
    const value = num(s.value)
    return label === undefined || value === undefined ? [] : [{ label, value }]
  })
  const endLabel = isRecord(data.end) ? str(data.end.label) : undefined
  let running = start.value
  const items = [{ label: start.label, from: 0, to: start.value, tone: css.columnTotal, text: `${start.label}: ${withUnit(start.value, unit)}` }]
  for (const s of steps) {
    items.push({
      label: s.label,
      from: running,
      to: running + s.value,
      tone: s.value < 0 ? css.columnNeg : css.columnPos,
      text: `${s.label}: ${s.value > 0 ? '+' : ''}${withUnit(s.value, unit)}`,
    })
    running += s.value
  }
  if (endLabel !== undefined) items.push({ label: endLabel, from: 0, to: running, tone: css.columnTotal, text: `${endLabel}: ${withUnit(running, unit)}` })
  const frame = yFrame(width, items.flatMap(i => [i.from, i.to]), items.length, true, true)
  return (
    <svg className={css.svg} width={width} height={PLOT_HEIGHT + PAD.top + PAD.bottom} role="img" aria-label={str(data.title)}>
      <YAxis frame={frame} unit={unit} />
      <Columns frame={frame} base={0} tip={tip} items={items} />
      <XLabels frame={frame} labels={items.map(i => i.label)} />
    </svg>
  )
}

function ScatterChart({ data, width, tip }: { data: Rec; width: number; tip: ShowTip }) {
  const points = list(data.points).flatMap((p) => {
    if (!isRecord(p)) return []
    const x = num(p.x)
    const y = num(p.y)
    return x === undefined || y === undefined ? [] : [{ x, y, label: str(p.label), group: str(p.group) ?? '' }]
  })
  if (points.length === 0) return null
  const groups = [...new Set(points.map(p => p.group))].slice(0, MAX_SCATTER_GROUPS)
  const shown = points.filter(p => groups.includes(p.group))
  const xTicks = niceTicks(Math.min(...shown.map(p => p.x)), Math.max(...shown.map(p => p.x)))
  const frame = yFrame(width, shown.map(p => p.y), 2, false, false)
  const inner = width - PAD.left - PAD.right
  const sx = (v: number) => PAD.left + ((v - at(xTicks, 0)) / (at(xTicks, -1) - at(xTicks, 0))) * inner
  const xLabel = str(data.xLabel)
  const yLabel = str(data.yLabel)
  return (
    <>
      <Legend names={groups.filter(g => g !== '')} />
      {yLabel !== undefined && <div className={css.axisTitle}>{yLabel}</div>}
      <svg className={css.svg} width={width} height={PLOT_HEIGHT + PAD.top + PAD.bottom} role="img" aria-label={str(data.title)}>
        <YAxis frame={frame} unit={str(data.yUnit)} />
        {xTicks.map(t => (
          <text key={t} className={css.svgTick} x={sx(t)} y={PAD.top + PLOT_HEIGHT + 18} textAnchor="middle">{withUnit(t, str(data.xUnit))}</text>
        ))}
        {shown.map((p, i) => (
          <circle
            key={i}
            className={css.scatterDot}
            style={seriesColor(groups.indexOf(p.group))}
            cx={sx(p.x)}
            cy={frame.y(p.y)}
            r={4}
            onMouseMove={(e) => { tip(e, `${p.label ?? ''}${p.label === undefined ? '' : ': '}${xLabel ?? 'x'} ${formatNumber(p.x)}, ${yLabel ?? 'y'} ${formatNumber(p.y)}`) }}
          />
        ))}
      </svg>
      {xLabel !== undefined && <div className={`${css.axisTitle} ${css.axisTitleX}`}>{xLabel}</div>}
    </>
  )
}

// ---------------------------------------------------------------- entry

function ChartBody({ data, partial }: { data: Rec; partial: boolean }) {
  const [ref, width] = useWidth()
  const { show, hide, node } = useTip()
  const kind = str(data.kind)
  let body: ReactNode = null
  if (kind === 'bar') body = <BarChart data={data} partial={partial} tip={show} />
  else if (kind === 'range') body = <RangeChart data={data} tip={show} />
  else if (kind === 'stacked') body = <StackedChart data={data} tip={show} />
  else if (kind === 'box') body = <BoxChart data={data} tip={show} />
  else if (kind === 'line') body = <LineChart data={data} width={width} tip={show} />
  else if (kind === 'histogram') body = <HistogramChart data={data} width={width} tip={show} />
  else if (kind === 'waterfall') body = <WaterfallChart data={data} width={width} tip={show} />
  else if (kind === 'scatter') body = <ScatterChart data={data} width={width} tip={show} />
  const title = str(data.title)
  const note = str(data.note)
  const source = str(data.source)
  return (
    <div className={css.chart} ref={ref} onMouseLeave={hide}>
      {title !== undefined && <div className={css.title}>{title}</div>}
      {body}
      {note !== undefined && <div className={css.note}>{note}</div>}
      {source !== undefined && <div className={css.source}>{source}</div>}
      {node}
    </div>
  )
}

/** The field each kind needs before anything can be drawn. */
const REQUIRED: Record<string, string> = {
  bar: 'items', range: 'items', stacked: 'groups', box: 'groups',
  line: 'series', histogram: 'values', scatter: 'points', waterfall: 'start',
}

/** True when `raw` names a known chart kind and carries its data field. */
export function isChartData(raw: unknown): raw is Rec {
  if (!isRecord(raw)) return false
  const kind = str(raw.kind) ?? ''
  if (!CHART_KINDS.has(kind)) return false
  const field = raw[REQUIRED[kind] ?? '']
  return Array.isArray(field) ? field.length > 0 : isRecord(field)
}

export function renderChart(data: Rec, key: Key, partial: boolean): ReactNode {
  return <ChartBody key={key} data={data} partial={partial} />
}
