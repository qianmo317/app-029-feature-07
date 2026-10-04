/**
 * 排版引擎（规格书第 8 节关键实现点）：
 * - 字距 = 相邻两字形「轮廓最近距离」（视觉间距），不是文本框宽度相减；
 * - 两端对齐按视觉间距平均分配（同一目标间距 → 视觉间距极差≈0）；
 * - 字形几何按「本地单位 1000 em」缓存，实际尺寸只做线性缩放（改字号不重解析字体）；
 * - 调字距只重算受影响的相邻对：视觉间距求解结果按 (字对, 归一化间距) 缓存（增量）。
 */

import { getGlyphGeom, type FontFamily } from './fontLoader'
import { emptySamples, minSetDistance } from './geometry'
import type { GlyphGeom } from './glyphAnalysis'
import type { Align, CharItem, GlyphInfo, LayoutDef, LayoutSettings, LineTuning, Project, SignPanel } from './types'

export interface PlacedChar {
  index: number
  char: string
  geom: GlyphGeom
  missing: boolean
  blank: boolean
  /** 墨迹左上角（面板坐标 mm，y 向下） */
  x: number
  y: number
  /** 墨迹尺寸 mm */
  inkW: number
  inkH: number
  /** 与下一个字的视觉间距（实测，mm） */
  gapAfter: number | null
  /** 字距为负 / 轮廓相交 */
  overlapAfter: boolean
  line: number
  item: CharItem
}

export interface LineLayout {
  line: number
  /** 该行文字（空串 = 空行） */
  text: string
  chars: PlacedChar[]
  inkLeft: number
  inkRight: number
  inkTop: number
  inkBottom: number
  width: number
  /** 本行生效的对齐（已合并逐行/全局） */
  align: Align
  /** 是否单独设过对齐 */
  alignTouched: boolean
  /** 本行到下一行墨迹顶的实际间隙 mm（最后一行为 null） */
  gapBelowMm: number | null
  /** 是否单独设过该间隙 */
  gapTouched: boolean
  /** 本行整体上下偏移 mm */
  offsetYMm: number
  /** 是否单独设过上下偏移 */
  offsetTouched: boolean
  /** 是否有任意一项被单独设过（界面一眼看出） */
  tuned: boolean
}

export interface MarginInfo {
  left: number
  right: number
  top: number
  bottom: number
  /** |左右留边差| */
  deltaX: number
  symmetric: boolean
}

export interface LayoutResult {
  inner: { x: number; y: number; w: number; h: number }
  lines: LineLayout[]
  chars: PlacedChar[]
  /** 墨迹整体范围（面板坐标 mm） */
  inkLeft: number
  inkRight: number
  inkTop: number
  inkBottom: number
  occupiedW: number
  occupiedH: number
  margins: MarginInfo
  overflowX: boolean
  overflowY: boolean
  overflowXMm: number
  overflowYMm: number
  /** 同排相邻字视觉间距极差 mm */
  gapSpread: number
  glyphs: GlyphInfo[]
  /** 外轮廓周长合计 mm（= LED 布点长度） */
  ledLengthMm: number
  warnings: string[]
  sizeMm: number
  /** 超出安装区时的建议字号（自动字号，保证不超出） */
  suggestedSizeMm: number | null
  /** 字体缺失/未加载的字符数 */
  missingCount: number
  /** 两端对齐使用的目标视觉间距 */
  justifyGapMm: number | null
}

export interface LayoutOptions {
  /** 自动字号 */
  autoSize?: boolean
}

const pairCache = new Map<string, number>()

export function round1(v: number): number {
  return Math.round(v * 10) / 10
}
export function round2(v: number): number {
  return Math.round(v * 100) / 100
}

/** 视觉间距求解（核心）：返回 B 墨迹左边界相对 A 墨迹左边界的偏移（mm）与实测间距 */
export function solveVisualOffset(
  a: GlyphGeom,
  b: GlyphGeom,
  sizeMm: number,
  gapMm: number
): { offset: number; gap: number; overlap: boolean } {
  const k = sizeMm / 1000
  const usable = !a.blank && !b.blank && !a.missing && !b.missing && a.samples.ax.length > 0 && b.samples.ax.length > 0
  if (!usable) {
    return { offset: (a.inkW + b.inkW) * k + gapMm, gap: gapMm, overlap: gapMm < 0 }
  }
  const target = Math.max(0, gapMm)
  const gn = target / k // 归一化到本地单位
  const ck = `${a.fontId}|${a.weight}|${a.char}|${b.char}|${gn.toFixed(3)}`
  const ax = -a.bbox.x0
  const bx = -b.bbox.x0
  const evalD = (delta: number): number => (delta <= 1e-9 ? 0 : minSetDistance(a.samples, ax, b.samples, bx + delta))

  let solved = pairCache.get(ck)
  if (solved === undefined) {
    let lo = 1e-6
    let hi = a.inkW + b.inkW + 4 * gn + 50
    // 初值取「包围盒模型」Δ = inkW_A + 目标间距，通常 2~4 步牛顿迭代即收敛
    let d = Math.min(hi * 0.9, a.inkW + gn)
    let cur = d
    for (let i = 0; i < 16; i++) {
      const D = evalD(d)
      cur = d
      if (D > gn) hi = d
      else lo = d
      if (Math.abs(D - gn) <= 0.02 || hi - lo <= 0.02) break
      let next = d + (gn - D)
      if (!(next > lo && next < hi)) next = (lo + hi) / 2
      d = next
    }
    solved = cur
    pairCache.set(ck, solved)
  }
  const offset = solved * k
  // 实测视觉间距（用于界面展示与验收断言，不做「静默使用目标值」）
  const measured = gapMm < 0 ? gapMm : evalD(solved) * k
  return { offset, gap: measured, overlap: gapMm < 0 }
}

/** 第 i 个字的实际字距：未手动调整过则跟随「默认字距比例 × 字号」 */
export function effectiveTrack(item: CharItem, settings: LayoutSettings, sizeMm: number): number {
  if (item.trackTouched) return item.trackMm
  return round1(settings.trackRatio * sizeMm)
}

/** 行设置为空（没单独设过任何一项）：重认行时直接丢弃，不占存储 */
export function isEmptyTuning(t: LineTuning): boolean {
  return t.align === null && t.gapBelowMm === null && t.offsetYMm === null
}

/** 规范化一条行设置（旧数据缺字段时补 null = 跟随全局），字段非法也按跟随处理 */
export function normalizeTuning(raw: unknown): LineTuning | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const text = typeof o.text === 'string' ? o.text : ''
  const alignOk = o.align === 'left' || o.align === 'center' || o.align === 'right' || o.align === 'justify'
  const gapNum = typeof o.gapBelowMm === 'number' && Number.isFinite(o.gapBelowMm) ? round1(o.gapBelowMm) : null
  const offNum = typeof o.offsetYMm === 'number' && Number.isFinite(o.offsetYMm) ? round1(o.offsetYMm) : null
  const t: LineTuning = {
    text,
    align: alignOk ? (o.align as Align) : null,
    gapBelowMm: gapNum,
    offsetYMm: offNum
  }
  return isEmptyTuning(t) ? null : t
}

/**
 * 把可能来自旧版本项目（缺字段/字段类型错）的 lineTunings 归一化。
 * 原则：缺什么都不能打不开；缺的逐行设置一律按「跟随全局」处理。
 */
export function normalizeTunings(raw: unknown): LineTuning[] {
  if (!Array.isArray(raw)) return []
  const out: LineTuning[] = []
  for (const item of raw) {
    const t = normalizeTuning(item)
    if (t) out.push(t)
  }
  return out
}

/** 「同内容第几次出现」索引：行设置按文字内容认行，重复文字也能各自定位 */
type TuningIndex = Map<string, LineTuning[]>

function indexTunings(tunings: LineTuning[]): TuningIndex {
  const m: TuningIndex = new Map()
  for (const t of tunings) {
    const arr = m.get(t.text) ?? []
    arr.push(t)
    m.set(t.text, arr)
  }
  return m
}

/** 按当前行文字 + 同内容出现序号取行设置（occurrence 由调用方按行序计数） */
function tuningByText(index: TuningIndex, text: string, occurrence = 0): LineTuning | null {
  return index.get(text)?.[occurrence] ?? null
}

/** 最长公共子序列长度（DP；门头文案通常几行到几十行，O(n·m) 足够） */
function lcsLen(a: string[], b: string[]): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  return dp[0][0]
}

/** 行相似度（按字符级 LCS / 较长行长度）：小改字时判定「还是同一行」的门槛 */
function lineSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  const ca = [...a]
  const cb = [...b]
  return lcsLen(ca, cb) / Math.max(ca.length, cb.length)
}

/**
 * 文字改过后重新认行，把旧的逐行设置搬到新行上（判定依据：行的文字内容，不是行序号）：
 * 1. 先按 LCS 把「文字完全没变」的行一一对回（插行/删行/重复行都不串位）；
 * 2. LCS 剩下的「被改动的旧行」与「新出现的行」在各配对段内按顺序就近配对，
 *    字符相似度 ≥ 0.5（只改了一两个字）则认为还是同一行，设置留下并更新文字；
 * 3. 其余新行没有设置（跟随全局）；删掉的行设置随之消失。
 */
export function reconcileLineTunings(newTexts: string[], prev: LineTuning[]): LineTuning[] {
  const oldTexts = prev.map((t) => t.text)
  const n = newTexts.length
  const m = oldTexts.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = newTexts[i] === oldTexts[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  // exact: 新行序号 -> 旧行序号
  const exact = new Map<number, number>()
  const usedOld = new Set<number>()
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (newTexts[i] === oldTexts[j]) {
      exact.set(i, j)
      usedOld.add(j)
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++
    } else {
      j++
    }
  }

  const out: (LineTuning | null)[] = new Array<LineTuning | null>(n).fill(null)
  for (const [ni, oi] of exact) {
    out[ni] = { ...prev[oi], text: newTexts[ni] }
  }
  // 未配对段：旧改动行与新行做全局贪心最佳匹配（相似度 ≥ 0.5 才承接），
  // 避免「顺序靠前但不像」的新行把设置抢走
  const unmatchedOld = oldTexts.map((_, k) => k).filter((k) => !usedOld.has(k))
  const unmatchedNew = newTexts.map((_, k) => k).filter((k) => !exact.has(k))
  const candidates: Array<{ oi: number; ni: number; sim: number }> = []
  for (const oi of unmatchedOld) {
    for (const ni of unmatchedNew) {
      const sim = lineSimilarity(oldTexts[oi], newTexts[ni])
      if (sim >= 0.5) candidates.push({ oi, ni, sim })
    }
  }
  candidates.sort((a, b) => b.sim - a.sim)
  const assignedOld = new Set<number>()
  const assignedNew = new Set<number>()
  for (const c of candidates) {
    if (assignedOld.has(c.oi) || assignedNew.has(c.ni)) continue
    assignedOld.add(c.oi)
    assignedNew.add(c.ni)
    out[c.ni] = { ...prev[c.oi], text: newTexts[c.ni] }
  }
  return out.filter((t): t is LineTuning => t !== null && !isEmptyTuning(t))
}

/** 把多行文本拆成行数组：\n 个数即分隔数，空行保留为空串（去掉行尾 \r） */
export function splitLines(text: string): string[] {
  return text.replace(/\r/g, '').split('\n')
}

interface BuildResult {
  lines: LineLayout[]
  placed: PlacedChar[]
  occupiedW: number
  occupiedH: number
  missingCount: number
  /** 每行的目标视觉间距（仅两端对齐时非空） */
  lineGaps: Map<number, number>
  /** 同一行内相邻字视觉间距极差的最大值 */
  gapSpread: number
}

function buildAtSize(
  def: LayoutDef,
  inner: { x: number; y: number; w: number; h: number },
  itemsByLine: Map<number, CharItem[]>,
  lineNos: number[],
  sizeMm: number
): BuildResult {
  const st = def.settings
  const k = sizeMm / 1000
  const lines: LineLayout[] = []
  const placed: PlacedChar[] = []
  const lineGaps = new Map<number, number>()
  let missingCount = 0
  let gapSpread = 0
  const tuningIndex = indexTunings(def.lineTunings ?? [])
  const seenText = new Map<string, number>()

  for (const ln of lineNos) {
    const items = itemsByLine.get(ln) ?? []
    const text = items.map((it) => it.char).join('')
    const occ = seenText.get(text) ?? 0
    seenText.set(text, occ + 1)
    const tune = tuningByText(tuningIndex, text, occ)
    const align: Align = tune?.align ?? st.align
    const justify = align === 'justify'
    const geoms = items.map((it) => {
      const g = getGlyphGeom(st.fontId, st.weight, it.char)
      const ok = !!g && !g.missing
      if (!ok) missingCount++
      return { geom: ok ? (g as GlyphGeom) : missingGeom(it.char, st.fontId, st.weight), ok, blank: ok && (g as GlyphGeom).blank }
    })
    const pairs = Math.max(0, items.length - 1)
    // 两端对齐（仅本行）：先按剩余宽度平均，再迭代 2 次让整行贴合有效安装区
    let gTarget = 0
    if (justify && pairs > 0) {
      const inkSum = geoms.reduce((s, g) => s + (g.ok ? g.geom.inkW * k : sizeMm), 0)
      gTarget = Math.max(0, (inner.w - inkSum) / pairs)
    }

    let chars: PlacedChar[] = []
    for (let iter = 0; iter < (justify && pairs > 0 ? 3 : 1); iter++) {
      chars = []
      let cursor = 0
      for (let i = 0; i < items.length; i++) {
        const it = items[i]
        const g = geoms[i]
        const inkW = g.ok ? g.geom.inkW * k : sizeMm
        const inkH = g.ok ? g.geom.inkH * k : sizeMm
        const node: PlacedChar = {
          index: chars.length,
          char: it.char,
          geom: g.geom,
          missing: !g.ok,
          blank: g.blank,
          x: cursor,
          y: g.ok ? g.geom.bbox.y0 * k : 0,
          inkW,
          inkH,
          gapAfter: null,
          overlapAfter: false,
          line: ln,
          item: it
        }
        chars.push(node)
        if (i < items.length - 1) {
          const ng = geoms[i + 1]
          if (g.ok && ng.ok) {
            const gap = justify ? gTarget : effectiveTrack(it, st, sizeMm)
            const res = solveVisualOffset(g.geom, ng.geom, sizeMm, gap)
            cursor += res.offset
            node.gapAfter = round2(res.gap)
            node.overlapAfter = res.overlap
          } else {
            const gap = justify ? gTarget : effectiveTrack(it, st, sizeMm)
            cursor += inkW + gap
          }
        }
      }
      if (justify && pairs > 0) {
        const right = chars.length ? Math.max(...chars.map((c) => c.x + c.inkW)) : 0
        const delta = inner.w - right
        if (Math.abs(delta) < 0.05) break
        gTarget = Math.max(0, gTarget + delta / pairs)
      } else {
        break
      }
    }
    if (justify && pairs > 0) lineGaps.set(ln, Math.round(gTarget * 100) / 100)
    const gapsInLine = chars.filter((c) => c.gapAfter !== null).map((c) => c.gapAfter as number)
    if (gapsInLine.length > 1) {
      gapSpread = Math.max(gapSpread, Math.max(...gapsInLine) - Math.min(...gapsInLine))
    }
    const inkLeft = chars.length ? Math.min(...chars.map((c) => c.x)) : 0
    const inkRight = chars.length ? Math.max(...chars.map((c) => c.x + c.inkW)) : 0
    const inkTop = chars.length ? Math.min(...chars.map((c) => c.y)) : 0
    const inkBottom = chars.length ? Math.max(...chars.map((c) => c.y + c.inkH)) : 0
    lines.push({
      line: ln,
      text,
      chars,
      inkLeft,
      inkRight,
      inkTop,
      inkBottom,
      width: inkRight - inkLeft,
      align,
      alignTouched: tune?.align !== undefined && tune?.align !== null,
      gapBelowMm: null,
      gapTouched: tune?.gapBelowMm !== undefined && tune?.gapBelowMm !== null,
      offsetYMm: tune?.offsetYMm ?? 0,
      offsetTouched: tune?.offsetYMm !== undefined && tune?.offsetYMm !== null,
      tuned:
        (tune?.align !== undefined && tune?.align !== null) ||
        (tune?.gapBelowMm !== undefined && tune?.gapBelowMm !== null) ||
        (tune?.offsetYMm !== undefined && tune?.offsetYMm !== null)
    })
    placed.push(...chars)
  }

  // 纵向堆叠：逐行以「墨迹间隙」摆放——上一行墨迹底边到本行墨迹顶边留 gapBelow。
  // gapBelow 记在上一行名下；未单独设过的行跟随「lineGapRatio × 字号」。
  // 行整体偏移在堆叠之后单独施加：只挪本行，不推开/挤压其它行。
  const defaultGap = round1(st.lineGapRatio * sizeMm)
  const stackSeen = new Map<string, number>()
  let cursorY = 0
  for (let idx = 0; idx < lines.length; idx++) {
    const l = lines[idx]
    const dy = cursorY - l.inkTop
    for (const c of l.chars) c.y += dy
    l.inkTop += dy
    l.inkBottom += dy
    const occ = stackSeen.get(l.text) ?? 0
    stackSeen.set(l.text, occ + 1)
    const tune = tuningByText(tuningIndex, l.text, occ)
    const gap = idx < lines.length - 1 ? (tune?.gapBelowMm ?? defaultGap) : null
    l.gapBelowMm = gap
    l.gapTouched = tune?.gapBelowMm !== undefined && tune?.gapBelowMm !== null
    cursorY = gap === null ? l.inkBottom : l.inkBottom + gap
    if (l.offsetYMm) {
      for (const c of l.chars) c.y += l.offsetYMm
      l.inkTop += l.offsetYMm
      l.inkBottom += l.offsetYMm
    }
  }

  // 水平对齐（逐行生效：左/居中/右/撑满整行可用宽度，已在水平排字阶段按本行设置处理两端对齐）
  for (const l of lines) {
    let shiftX = inner.x - l.inkLeft
    const w = l.inkRight - l.inkLeft
    if (l.align === 'center') shiftX = inner.x + (inner.w - w) / 2 - l.inkLeft
    else if (l.align === 'right') shiftX = inner.x + inner.w - l.inkRight
    for (const c of l.chars) c.x += shiftX
    l.inkLeft += shiftX
    l.inkRight += shiftX
  }

  // 垂直居中（含逐行偏移后的实际墨迹范围）
  const top = lines.length ? Math.min(...lines.map((l) => l.inkTop)) : 0
  const bottom = lines.length ? Math.max(...lines.map((l) => l.inkBottom)) : 0
  const occupiedH = Math.max(0, bottom - top)
  const shiftY = inner.y + (inner.h - occupiedH) / 2 - top
  for (const c of placed) c.y += shiftY + c.item.offsetYMm
  for (const l of lines) {
    l.inkTop += shiftY
    l.inkBottom += shiftY
  }

  const left = lines.length ? Math.min(...lines.map((l) => l.inkLeft)) : 0
  const right = lines.length ? Math.max(...lines.map((l) => l.inkRight)) : 0

  return {
    lines,
    placed,
    occupiedW: Math.max(0, right - left),
    occupiedH,
    missingCount,
    lineGaps,
    gapSpread: round2(gapSpread)
  }
}

/** 求「不超出安装区」的最大字号（自动字号 / 建议字号共用） */
function fitSize(
  def: LayoutDef,
  inner: { x: number; y: number; w: number; h: number },
  itemsByLine: Map<number, CharItem[]>,
  lineNos: number[]
): number {
  const availW = inner.w * (1 - def.settings.marginRatio * 2)
  const availH = inner.h * (1 - def.settings.marginRatio * 2)
  let s = Math.max(5, def.settings.baseSizeMm)
  for (let i = 0; i < 16; i++) {
    const r = buildAtSize(def, inner, itemsByLine, lineNos, s)
    // 空排版（还没输入文字）不参与反算，避免字号发散
    if (r.occupiedW < 0.5 && r.occupiedH < 0.5) break
    const ratio = Math.max(Math.max(r.occupiedW, 1e-6) / availW, Math.max(r.occupiedH, 1e-6) / availH)
    if (Math.abs(ratio - 1) < 0.002) break
    const next = s / ratio
    if (!Number.isFinite(next) || next <= 0) break
    s = Math.min(s * 5, Math.max(5, next))
  }
  return Math.round(s * 10) / 10
}

export function computeLayout(def: LayoutDef, opts: LayoutOptions = {}): LayoutResult {
  const panel: SignPanel = def.panel
  const st = def.settings
  const inner = {
    x: panel.frameMm,
    y: panel.frameMm,
    w: Math.max(1, panel.wMm - panel.frameMm * 2),
    h: Math.max(1, panel.hMm - panel.frameMm * 2)
  }
  const itemsByLine = new Map<number, CharItem[]>()
  let maxLine = -1
  for (const it of def.items) {
    const arr = itemsByLine.get(it.line) ?? []
    arr.push(it)
    itemsByLine.set(it.line, arr)
    if (it.line > maxLine) maxLine = it.line
  }
  // 密集行槽：中间的空行也占位（高度为 0 的墨迹行，但照样可单独设对齐/间隙/偏移）
  const lineNos: number[] = []
  for (let ln = 0; ln <= maxLine; ln++) lineNos.push(ln)

  let sizeMm = st.baseSizeMm
  if (opts.autoSize) sizeMm = fitSize(def, inner, itemsByLine, lineNos)

  const built = buildAtSize(def, inner, itemsByLine, lineNos, sizeMm)
  const { lines, placed } = built
  const inkLeft = placed.length ? Math.min(...placed.map((c) => c.x)) : inner.x
  const inkRight = placed.length ? Math.max(...placed.map((c) => c.x + c.inkW)) : inner.x
  const inkTop = placed.length ? Math.min(...placed.map((c) => c.y)) : inner.y
  const inkBottom = placed.length ? Math.max(...placed.map((c) => c.y + c.inkH)) : inner.y
  const occupiedW = Math.max(0, inkRight - inkLeft)
  const occupiedH = Math.max(0, inkBottom - inkTop)
  const marginLeft = round1(inkLeft - inner.x)
  const marginRight = round1(inner.x + inner.w - inkRight)
  const marginTop = round1(inkTop - inner.y)
  const marginBottom = round1(inner.y + inner.h - inkBottom)
  const deltaX = round1(Math.abs(marginLeft - marginRight))
  const overflowXMm = round1(Math.max(0, occupiedW - inner.w))
  const overflowYMm = round1(Math.max(0, occupiedH - inner.h))

  const glyphs = placed.map((p) => buildGlyphInfo(p, sizeMm, st.strokeLimitMm))
  const ledLengthMm = round1(placed.reduce((s, c) => s + c.geom.outerPerimeter * (sizeMm / 1000), 0))

  const warnings: string[] = []
  if (built.missingCount > 0) warnings.push(`有 ${built.missingCount} 个字符缺失（字体未加载或该字不在字库中）`)
  if (overflowXMm > 0) warnings.push(`超出安装区宽度 ${overflowXMm}mm`)
  if (overflowYMm > 0) warnings.push(`超出安装区高度 ${overflowYMm}mm`)
  for (const g of glyphs) warnings.push(...g.warnings)
  if (placed.length > 0 && deltaX > 1) warnings.push(`左右留边不对称（差 ${deltaX}mm）`)
  const anyJustify = built.lines.some((l) => l.align === 'justify')
  if (!anyJustify && st.trackRatio < 0.04) warnings.push('默认字距比例过小，字与字容易粘连')
  if (!anyJustify && st.trackRatio > 0.35) warnings.push('默认字距比例过大，整排会显得松散')

  let suggestedSizeMm: number | null = null
  if ((overflowXMm > 0 || overflowYMm > 0) && !opts.autoSize) {
    suggestedSizeMm = fitSize(def, inner, itemsByLine, lineNos)
  }

  const justifyGapMm = built.lineGaps.size
    ? round2(Math.min(...[...built.lineGaps.values()]))
    : null

  return {
    inner,
    lines,
    chars: placed,
    inkLeft: round1(inkLeft),
    inkRight: round1(inkRight),
    inkTop: round1(inkTop),
    inkBottom: round1(inkBottom),
    occupiedW: round1(occupiedW),
    occupiedH: round1(occupiedH),
    margins: { left: marginLeft, right: marginRight, top: marginTop, bottom: marginBottom, deltaX, symmetric: deltaX <= 1 },
    overflowX: overflowXMm > 0,
    overflowY: overflowYMm > 0,
    overflowXMm,
    overflowYMm,
    gapSpread: built.gapSpread,
    glyphs,
    ledLengthMm,
    warnings,
    sizeMm: round1(sizeMm),
    suggestedSizeMm,
    missingCount: built.missingCount,
    justifyGapMm
  }
}

function buildGlyphInfo(p: PlacedChar, sizeMm: number, strokeLimitMm: number): GlyphInfo {
  const k = sizeMm / 1000
  const warnings: string[] = []
  if (p.missing) {
    warnings.push(`「${p.char}」不在当前字体中：请更换字体或更换文字（不会静默退化）`)
  }
  const minStrokeMm = round1(p.geom.minStroke * k)
  if (!p.missing && !p.blank && minStrokeMm > 0 && minStrokeMm < strokeLimitMm) {
    warnings.push(
      `「${p.char}」最细笔画 ${minStrokeMm}mm < 工艺下限 ${strokeLimitMm}mm：太细做不出/易断；建议加粗（换更粗字重）、换字体或减小字高比例`
    )
  }
  if (p.overlapAfter) warnings.push(`「${p.char}」与下一个字字距为负，轮廓可能相交/粘连`)
  return {
    char: p.char,
    fontId: p.geom.fontId,
    weight: p.geom.weight,
    sizeMm: round1(sizeMm),
    bboxMm: { x: round1(p.x), y: round1(p.y), w: round1(p.inkW), h: round1(p.inkH) },
    contours: p.geom.rings.map((r) => ({
      areaMm2: round1(r.area * k * k),
      perimeterMm: round1(r.perimeter * k),
      isHole: r.isHole,
      blockIndex: r.block
    })),
    strokeBlocks: p.geom.strokeBlocks,
    minStrokeMm,
    minStrokePoint: p.geom.minStrokePoint
      ? {
          x: round1(p.x + (p.geom.minStrokePoint.x - p.geom.bbox.x0) * k),
          y: round1(p.y + (p.geom.minStrokePoint.y - p.geom.bbox.y0) * k)
        }
      : null,
    missing: p.missing,
    warnings
  }
}

function missingGeom(char: string, fontId: string, weight: number): GlyphGeom {
  return {
    char,
    fontId,
    weight,
    missing: true,
    blank: false,
    rings: [],
    strokeBlocks: 0,
    strokeBlocksByNesting: 0,
    minStroke: 0,
    minStrokePoint: null,
    bbox: { x0: 0, y0: 0, x1: 0, y1: 0 },
    inkW: 0,
    inkH: 0,
    samples: emptySamples(),
    outerPerimeter: 0,
    blockBBoxes: [],
    pathData: '',
    advance: 0
  }
}

export function alignLabel(a: Align): string {
  switch (a) {
    case 'left':
      return '左对齐'
    case 'center':
      return '居中'
    case 'right':
      return '右对齐'
    default:
      return '两端对齐'
  }
}

export function mountingLabel(m: SignPanel['mounting']): string {
  switch (m) {
    case 'wall':
      return '贴墙安装'
    case 'board':
      return '挂板安装'
    default:
      return '落地立牌'
  }
}

export function fontFamilyLabel(f: FontFamily | null): string {
  return f ? `${f.label}（${f.family}）` : '未知字体'
}

/** 新建项目默认参数 */
export function defaultProject(id: string, panel?: Partial<SignPanel>): Project {
  return {
    id,
    name: '新门头',
    layout: {
      panel: { wMm: 3000, hMm: 800, mounting: 'board', frameMm: 60, ...panel },
      items: [],
      settings: {
        align: 'center',
        baseSizeMm: 300,
        fontId: 'hei',
        weight: 400,
        strokeLimitMm: 8,
        trackRatio: 0.1,
        marginRatio: 0.04,
        lineGapRatio: 0.18
      }
    },
    led: {
      moduleSpacingMm: 150,
      modulePowerW: 0.72,
      moduleLumen: 60,
      safetyFactor: 1.2,
      psuEfficiency: 0.85
    },
    panelMaterialId: 'acrylic_led',
    sheetId: 'acr-1220x2440x3',
    ledModuleId: 'led-12v-072-60',
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

/** 把文本转成逐字项（保留已有微调值，多行用 \n 分隔） */
export function textToItems(text: string, prev: CharItem[], settings: LayoutSettings, sizeMm: number): CharItem[] {
  const lines = splitLines(text)
  const out: CharItem[] = []
  let seq = 0
  lines.forEach((lineText, li) => {
    for (const ch of lineText) {
      const old = prev.find((p) => p.seq === seq && p.char === ch)
      out.push({
        char: ch,
        trackMm: old && old.trackTouched ? old.trackMm : round1(settings.trackRatio * sizeMm),
        offsetYMm: old ? old.offsetYMm : 0,
        mode: old ? old.mode : 'solid',
        line: li,
        trackTouched: old ? old.trackTouched : false,
        seq
      })
      seq++
    }
  })
  return out
}

/**
 * 文字改过后统一更新排版定义：
 * 逐字项按字重新认行（textToItems），逐行设置按行文字内容重新认（reconcileLineTunings）。
 * 判定依据是「文字内容」：插行/删行只影响对应内容，后面的行不串位。
 */
export function syncLayoutText(def: LayoutDef, text: string, sizeMm: number): void {
  const lineTexts = splitLines(text)
  def.items = textToItems(text, def.items, def.settings, sizeMm)
  def.lineTunings = reconcileLineTunings(lineTexts, normalizeTunings(def.lineTunings))
}

/** 取当前文本对应的逐行设置（按内容+出现次数定位；不存在则返回 null） */
export function findLineTuning(def: LayoutDef, text: string, occurrence: number): LineTuning | null {
  const list = normalizeTunings(def.lineTunings).filter((t) => t.text === text)
  return list[occurrence] ?? null
}

/** 写入某一行的逐行设置（不存在则新增；三项全回到跟随则删除该条） */
export function setLineTuning(def: LayoutDef, text: string, occurrence: number, patch: Partial<Omit<LineTuning, 'text'>>): void {
  const all = normalizeTunings(def.lineTunings)
  let seen = 0
  let found = false
  for (let k = 0; k < all.length; k++) {
    if (all[k].text !== text) continue
    if (seen === occurrence) {
      all[k] = { ...all[k], ...patch, text }
      found = true
      break
    }
    seen++
  }
  if (!found) all.push({ text, align: null, gapBelowMm: null, offsetYMm: null, ...patch })
  def.lineTunings = all.filter((t) => !isEmptyTuning(t))
}

/** 清掉某一行的全部逐行设置（恢复为完全跟随全局） */
export function clearLineTuning(def: LayoutDef, text: string, occurrence: number): void {
  const all = normalizeTunings(def.lineTunings)
  let seen = 0
  def.lineTunings = all.filter((t) => {
    if (t.text !== text) return true
    const keep = seen !== occurrence
    seen++
    return keep
  })
}

/** 清掉所有行的全部逐行设置（全部恢复跟随全局） */
export function clearAllLineTunings(def: LayoutDef): void {
  def.lineTunings = []
}