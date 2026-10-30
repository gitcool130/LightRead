/**
 * PDF 绘图批注: 画笔 / 荧光笔 / 矩形 / 椭圆 / 直线 / 箭头 / 文字框。
 *
 * 坐标系: 一律「页内坐标」——scale = 1、左上原点、单位就是 PDF 点, 与划线高亮
 * (PaperReaderView 的 HlRect) 同一套; 于是缩放、翻页、双页与连续滚动都不用换算。
 *
 * 落库: 整条批注压进 AnnotationRec.cfi, 前缀 `a:1:`; 划线高亮仍是 `p:<page>:[...]`,
 * 两套前缀互不影响, 旧版本读到 `a:1:` 的记录会当作未知标注忽略掉。
 *
 * 这里只放纯函数 (编解码 / 包围盒 / 命中 / 路径), 渲染与交互在组件与视图里。
 * 参考实现: PDF-Annotator-Qt (PyMuPDF + QGraphicsScene) 的 SHAPE_ITEMS 与绘制流程。
 */

export type AnnoTool = 'select' | 'pen' | 'marker' | 'rect' | 'ellipse' | 'line' | 'arc' | 'arrow' | 'note'

/** 真正「画东西」的工具 (select 只是选择态) */
export const DRAW_TOOLS: AnnoTool[] = ['pen', 'marker', 'rect', 'ellipse', 'line', 'arc', 'arrow', 'note']

export interface Pt {
  x: number
  y: number
}

/** 手绘轨迹 (画笔 / 荧光笔) */
export interface InkAnno {
  t: 'ink'
  /** 页码, 1 起 */
  p: number
  pts: [number, number][]
  /** 线宽 (页坐标) */
  w: number
  /** #rrggbb */
  c: string
  /** 透明度 0-1 */
  a: number
}

/** 直线 / 箭头 / 圆弧 */
export interface SegAnno {
  t: 'line' | 'arrow' | 'arc'
  p: number
  x1: number
  y1: number
  x2: number
  y2: number
  w: number
  c: string
  a: number
  /** 仅 arc: true 顺时针 (默认), false 逆时针 (按住 Shift 画) */
  cw?: boolean
  /** 仅 arc: 半径系数 = 弦长的倍数, 默认 0.75 (弧约 84°); 0.5 = 半圆, 1.0 = 极平弧 */
  rf?: number
}

/** 矩形 / 椭圆 */
export interface BoxAnno {
  t: 'rect' | 'ellipse'
  p: number
  x1: number
  y1: number
  x2: number
  y2: number
  w: number
  c: string
  a: number
}

/** 文字批注框 */
export interface NoteAnno {
  t: 'note'
  p: number
  x: number
  y: number
  w: number
  h: number
  text: string
  c: string
  /** 字号 (页坐标) */
  s: number
}

export type DrawAnno = InkAnno | SegAnno | BoxAnno | NoteAnno

export interface AnnoBounds {
  x: number
  y: number
  w: number
  h: number
}

export const ANNO_PREFIX = 'a:1:'

/**
 * 画笔调色板: 红 / 亮橙 / 橙 / 黄 / 亮绿 / 绿 / 蓝 / 紫 / 墨黑。
 * 顺序即下拉菜单里的排布 (暖色在前、冷色在后、墨黑收尾), 亮色单独给了「亮橙」「亮绿」,
 * 深色底稿上也能看清。
 */
export const ANNO_COLORS = ['#f5222d', '#ff8a00', '#f2a63b', '#ffd60a', '#22c55e', '#2f9e44', '#1c7ed6', '#7048e8', '#1d2129']

/** 调色板颜色的名字 (i18n key 后缀: reader.annoColorName.<Name>), 只用于标题与下拉菜单 */
export const ANNO_COLOR_NAMES: Record<string, string> = {
  '#f5222d': 'Red',
  '#ff8a00': 'BrightOrange',
  '#f2a63b': 'Orange',
  '#ffd60a': 'Yellow',
  '#22c55e': 'BrightGreen',
  '#2f9e44': 'Green',
  '#1c7ed6': 'Blue',
  '#7048e8': 'Purple',
  '#1d2129': 'Ink',
}

/** 默认画笔颜色 (调色板里的正红) */
export const ANNO_DEFAULT_COLOR = '#f5222d'

/** 颜色的显示名; 老批注可能带调色板外的自定义色, 这时直接显示色值 */
export function annoColorName(hex: string): string {
  const name = ANNO_COLOR_NAMES[hex]
  return name ? `reader.annoColorName.${name}` : hex
}

/** 各工具默认线宽 (屏幕 px, 写入时按当前缩放折成页坐标) */
export const ANNO_DEFAULT_WIDTH: Record<AnnoTool, number> = {
  select: 0,
  pen: 2,
  marker: 10,
  rect: 2,
  ellipse: 2,
  line: 2,
  arc: 2,
  arrow: 2,
  note: 0,
}

/** 可选线宽 (屏幕 px) */
export const ANNO_WIDTHS = [1, 2, 4, 7]

/** 文字批注默认框 (页坐标) */
export const NOTE_BOX = { w: 220, h: 64, s: 13 }

const r1 = (v: number) => Math.round(v * 10) / 10

export const isDrawLoc = (cfi: string) => typeof cfi === 'string' && cfi.startsWith(ANNO_PREFIX)

export const annoKindOf = (a: DrawAnno): 'ink' | 'shape' | 'text' =>
  a.t === 'ink' ? 'ink' : a.t === 'note' ? 'text' : 'shape'

const DRAW_TYPES: DrawAnno['t'][] = ['ink', 'line', 'arrow', 'arc', 'rect', 'ellipse', 'note']

const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** 批注 → 序列化字符串 (存进 AnnotationRec.cfi) */
export function encodeDraw(a: DrawAnno): string {
  let body: Record<string, unknown>
  if (a.t === 'ink') {
    body = {
      t: 'ink', p: a.p, w: r1(a.w), c: a.c, a: r1(a.a),
      pts: a.pts.map(([x, y]) => [r1(x), r1(y)]),
    }
  } else if (a.t === 'note') {
    body = {
      t: 'note', p: a.p, x: r1(a.x), y: r1(a.y), w: r1(a.w), h: r1(a.h), s: r1(a.s), c: a.c,
      text: a.text.slice(0, 2000),
    }
  } else {
    body = {
      t: a.t, p: a.p, x1: r1(a.x1), y1: r1(a.y1), x2: r1(a.x2), y2: r1(a.y2),
      w: r1(a.w), c: a.c, a: r1(a.a),
    }
    // 圆弧的方向只在逆时针时才写 (顺时针是默认值, 老数据没这个字段也按顺时针)
    if (a.t === 'arc' && a.cw === false) body.cw = 0
    // 圆弧半径系数只在非默认值时写
    if (a.t === 'arc' && typeof a.rf === 'number' && Math.abs(a.rf - ARC_RADIUS_DEFAULT) > 0.001) body.rf = r1(a.rf)
  }
  return ANNO_PREFIX + JSON.stringify(body)
}

/** 序列化字符串 → 批注; 不是绘图批注或字段坏掉时返回 null */
export function decodeDraw(cfi: string): DrawAnno | null {
  if (!isDrawLoc(cfi)) return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(cfi.slice(ANNO_PREFIX.length)) as Record<string, unknown>
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const t = raw.t as DrawAnno['t']
  if (!DRAW_TYPES.includes(t)) return null
  const p = num(raw.p)
  if (!Number.isFinite(p) || p < 1) return null
  const color = typeof raw.c === 'string' && raw.c ? raw.c : '#e5484d'
  if (t === 'ink') {
    const pts = Array.isArray(raw.pts)
      ? (raw.pts as unknown[])
          .map(pair => (Array.isArray(pair) && pair.length >= 2 ? [num(pair[0]), num(pair[1])] as [number, number] : null))
          .filter((v): v is [number, number] => v !== null)
      : []
    if (!pts.length) return null
    return { t, p, pts, w: Math.max(0.5, num(raw.w, 2)), c: color, a: clamp01(num(raw.a, 1)) }
  }
  if (t === 'note') {
    return {
      t, p,
      x: num(raw.x), y: num(raw.y),
      w: Math.max(40, num(raw.w, NOTE_BOX.w)), h: Math.max(24, num(raw.h, NOTE_BOX.h)),
      text: typeof raw.text === 'string' ? raw.text : '',
      c: color, s: Math.max(6, num(raw.s, NOTE_BOX.s)),
    }
  }
  const seg = {
    t: t as SegAnno['t'] | BoxAnno['t'], p,
    x1: num(raw.x1), y1: num(raw.y1), x2: num(raw.x2), y2: num(raw.y2),
    w: Math.max(0.5, num(raw.w, 2)), c: color, a: clamp01(num(raw.a, 1)),
  }
  // arc 默认顺时针; 只有明确写了 cw: 0 才是逆时针
  if (t === 'arc') {
    const arc: SegAnno = { ...seg, t: 'arc', cw: num(raw.cw, 1) !== 0 }
    const rf = num(raw.rf, ARC_RADIUS_DEFAULT)
    if (Math.abs(rf - ARC_RADIUS_DEFAULT) > 0.001) arc.rf = rf
    return arc
  }
  return seg
}

const clamp01 = (v: number) => Math.min(1, Math.max(0.05, v))

export const clampPt = (x: number, y: number, pageW: number, pageH: number): Pt => ({
  x: Math.min(Math.max(x, 0), Math.max(0, pageW)),
  y: Math.min(Math.max(y, 0), Math.max(0, pageH)),
})

/** 包围盒 (含线宽余量), 用于入库前的合法性判断与选择框 */
export function annoBounds(a: DrawAnno): AnnoBounds {
  if (a.t === 'note') return { x: a.x, y: a.y, w: a.w, h: a.h }
  if (a.t === 'ink') {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const [x, y] of a.pts) {
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
    }
    if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 }
    const pad = a.w / 2
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 }
  }
  const pad = a.w / 2
  if (a.t === 'arc') {
    // 弧可能鼓出弦的包围盒, 按采样点算
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const [x, y] of arcPoints(a)) {
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
    }
    if (!Number.isFinite(x0)) return { x: a.x1, y: a.y1, w: 0, h: 0 }
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 }
  }
  const x = Math.min(a.x1, a.x2)
  const y = Math.min(a.y1, a.y2)
  const w = Math.abs(a.x2 - a.x1)
  const h = Math.abs(a.y2 - a.y1)
  return { x: x - pad, y: y - pad, w: w + pad * 2, h: h + pad * 2 }
}

/** 拖动整条批注 */
export function moveAnno(a: DrawAnno, dx: number, dy: number): DrawAnno {
  if (a.t === 'ink') {
    return { ...a, pts: a.pts.map(([x, y]) => [x + dx, y + dy] as [number, number]) }
  }
  if (a.t === 'note') return { ...a, x: a.x + dx, y: a.y + dy }
  return { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy }
}

/** 整条批注按页边框内缩, 用于拖动/绘制后防丢 */
export function clampAnno(a: DrawAnno, pageW: number, pageH: number): DrawAnno {
  const b = annoBounds(a)
  if (!b.w && !b.h) return a
  let dx = 0
  let dy = 0
  // 比页面还大时只把左上角推回页内, 不再做二次平移
  if (b.w > pageW) {
    if (b.x > 0) dx = -b.x
  } else if (b.x < 0) dx = -b.x
  else if (b.x + b.w > pageW) dx = pageW - (b.x + b.w)
  if (b.h > pageH) {
    if (b.y > 0) dy = -b.y
  } else if (b.y < 0) dy = -b.y
  else if (b.y + b.h > pageH) dy = pageH - (b.y + b.h)
  if (!dx && !dy) return a
  return moveAnno(a, dx, dy)
}

const dist2 = (x: number, y: number, px: number, py: number) => (x - px) ** 2 + (y - py) ** 2

/** 点到线段距离的平方 */
function segDist2(x: number, y: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  if (!len2) return dist2(x, y, x1, y1)
  let t = ((x - x1) * dx + (y - y1) * dy) / len2
  t = Math.min(1, Math.max(0, t))
  return dist2(x, y, x1 + t * dx, y1 + t * dy)
}

/**
 * 命中判定 (页坐标). tol 由调用方按当前缩放换算: 屏幕上 ~6px 折回页坐标。
 * 形状与文字框按包围盒命中——选择态下页面不参与文字选择, 点框内即选中更符合直觉。
 */
export function hitTest(a: DrawAnno, x: number, y: number, tol = 4): boolean {
  if (a.t === 'ink') {
    const t = Math.max(tol, a.w / 2 + 1)
    if (a.pts.length === 1) return Math.hypot(x - a.pts[0][0], y - a.pts[0][1]) <= t
    for (let i = 1; i < a.pts.length; i++) {
      const [ax, ay] = a.pts[i - 1]
      const [bx, by] = a.pts[i]
      if (segDist2(x, y, ax, ay, bx, by) <= t * t) return true
    }
    return false
  }
  if (a.t === 'line' || a.t === 'arrow') {
    const t = Math.max(tol, a.w / 2 + 1)
    return segDist2(x, y, a.x1, a.y1, a.x2, a.y2) <= t * t
  }
  if (a.t === 'arc') {
    const t = Math.max(tol, a.w / 2 + 1)
    const pts = arcPoints(a)
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1]
      const [bx, by] = pts[i]
      if (segDist2(x, y, ax, ay, bx, by) <= t * t) return true
    }
    return false
  }
  const b = annoBounds(a)
  return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol
}

/** 手绘轨迹 → SVG path, 用中点二次贝塞尔抹掉折线感 */
export function inkPathD(pts: [number, number][]): string {
  if (!pts.length) return ''
  const head = `M${r1(pts[0][0])} ${r1(pts[0][1])}`
  if (pts.length === 1) {
    // 单点: 极短线段配合圆头笔帽画出圆点
    return `${head}l0.01 0`
  }
  let d = head
  for (let i = 1; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[i + 1]
    d += `Q${r1(x1)} ${r1(y1)} ${r1((x1 + x2) / 2)} ${r1((y1 + y2) / 2)}`
  }
  const [lx, ly] = pts[pts.length - 1]
  return `${d}L${r1(lx)} ${r1(ly)}`
}

/** 箭头三角头 (以终点为尖) */
export function arrowHeadPoints(x1: number, y1: number, x2: number, y2: number, w: number): string {
  const len = Math.max(6, w * 3.6)
  const ang = Math.atan2(y2 - y1, x2 - x1)
  const spread = Math.PI / 7
  const ax = x2 - len * Math.cos(ang - spread)
  const ay = y2 - len * Math.sin(ang - spread)
  const bx = x2 - len * Math.cos(ang + spread)
  const by = y2 - len * Math.sin(ang + spread)
  return `${r1(x2)},${r1(y2)} ${r1(ax)},${r1(ay)} ${r1(bx)},${r1(by)}`
}

/** 圆弧半径系数: 弦长的倍数, 决定弧的弯曲程度 */
export const ARC_RADIUS_DEFAULT = 0.75
export const ARC_RADIUS_OPTIONS = [0.5, 0.75, 1.0, 1.5]

/** 取 arc 的半径系数, 缺省 0.75 */
export function arcRadiusFactor(a: SegAnno): number {
  const rf = a.rf
  return typeof rf === 'number' && Number.isFinite(rf) && rf >= 0.5 && rf <= 3
    ? rf
    : ARC_RADIUS_DEFAULT
}

/**
 * 圆弧的圆心与半径: 拖拽两点是弦, 半径取弦长 × rf 倍 (默认 0.75, 弧约 84°)。
 * 顺时针 (sweep=1) 时圆心落在弦的顺时针一侧, 逆时针反之; 圆心决定弧凸向哪边。
 */
export function arcCircle(a: SegAnno): { cx: number; cy: number; r: number } | null {
  const dx = a.x2 - a.x1
  const dy = a.y2 - a.y1
  const len = Math.hypot(dx, dy)
  if (len < 0.01) return null
  const rf = arcRadiusFactor(a)
  const r = Math.max(len / 2, len * rf)
  const mx = (a.x1 + a.x2) / 2
  const my = (a.y1 + a.y2) / 2
  const h = Math.sqrt(Math.max(0, r * r - (len / 2) ** 2))
  // (-dy, dx) 是弦方向在 y 向下坐标系里顺时针 90° 的单位向量
  const side = a.cw === false ? -1 : 1
  const nx = (-dy / len) * side
  const ny = (dx / len) * side
  return { cx: mx + nx * h, cy: my + ny * h, r }
}

/** 圆弧上的采样点 (命中判定与包围盒用), 顺时针按角度递增走 */
export function arcPoints(a: SegAnno, steps = 24): [number, number][] {
  const c = arcCircle(a)
  if (!c) return [[a.x1, a.y1], [a.x2, a.y2]]
  const a1 = Math.atan2(a.y1 - c.cy, a.x1 - c.cx)
  const a2 = Math.atan2(a.y2 - c.cy, a.x2 - c.cx)
  const cw = a.cw !== false
  // y 向下: 角度递增 = 屏幕上顺时针
  let sweep = a2 - a1
  if (cw) {
    while (sweep <= 0) sweep += Math.PI * 2
    while (sweep > Math.PI * 2) sweep -= Math.PI * 2
  } else {
    while (sweep >= 0) sweep -= Math.PI * 2
    while (sweep < -Math.PI * 2) sweep += Math.PI * 2
  }
  const out: [number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const t = a1 + (sweep * i) / steps
    out.push([c.cx + c.r * Math.cos(t), c.cy + c.r * Math.sin(t)])
  }
  return out
}

/** 圆弧 → SVG path; sweep-flag 1 = 屏幕上顺时针 */
export function arcPathD(a: SegAnno): string {
  const c = arcCircle(a)
  if (!c) return `M${r1(a.x1)} ${r1(a.y1)}L${r1(a.x2)} ${r1(a.y2)}`
  const sweep = a.cw === false ? 0 : 1
  return `M${r1(a.x1)} ${r1(a.y1)}A${r1(c.r)} ${r1(c.r)} 0 0 ${sweep} ${r1(a.x2)} ${r1(a.y2)}`
}

/** 采样点抽稀: 屏幕距离小于 minDist(页坐标) 的点丢掉, 免得一条笔迹存上百个点 */
export function simplifyInk(pts: [number, number][], minDist: number): [number, number][] {
  if (pts.length < 3 || minDist <= 0) return pts
  const out: [number, number][] = [pts[0]]
  const min2 = minDist * minDist
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = out[out.length - 1]
    if (dist2(pts[i][0], pts[i][1], px, py) >= min2) out.push(pts[i])
  }
  out.push(pts[pts.length - 1])
  return out
}

/** 画完松手时的有效性判断: 太短的一划/太小的框当误触丢掉 */
export function isMeaningfulAnno(a: DrawAnno, minSize = 3): boolean {
  const b = annoBounds(a)
  if (a.t === 'note') return true
  if (a.t === 'ink') return a.pts.length >= 2 && (b.w > minSize || b.h > minSize)
  return b.w > minSize || b.h > minSize
}

/** 由拖拽起止点生成批注原型; arcRf 是圆弧半径系数 (默认 0.75) */
export function annoFromDrag(tool: AnnoTool, page: number, from: Pt, to: Pt, w: number, c: string, alpha: number, arcRf = ARC_RADIUS_DEFAULT): DrawAnno {
  if (tool === 'pen' || tool === 'marker') {
    return { t: 'ink', p: page, pts: [[from.x, from.y]], w, c, a: alpha }
  }
  if (tool === 'line' || tool === 'arrow' || tool === 'arc') {
    const seg: SegAnno = { t: tool, p: page, x1: from.x, y1: from.y, x2: to.x, y2: to.y, w, c, a: alpha }
    return tool === 'arc' ? { ...seg, t: 'arc', cw: true, rf: arcRf } : seg
  }
  if (tool === 'rect' || tool === 'ellipse') {
    return { t: tool, p: page, x1: from.x, y1: from.y, x2: to.x, y2: to.y, w, c, a: alpha }
  }
  return {
    t: 'note', p: page,
    x: from.x, y: from.y,
    w: NOTE_BOX.w, h: NOTE_BOX.h, text: '', c, s: NOTE_BOX.s,
  }
}

/** 画笔笔迹追加一个采样点 (原地构造新对象, 供 draft 预览) */
export function inkAppend(a: InkAnno, x: number, y: number, minDist = 1): InkAnno {
  const [lx, ly] = a.pts[a.pts.length - 1]
  if (dist2(x, y, lx, ly) < minDist * minDist) return a
  return { ...a, pts: [...a.pts, [x, y]] }
}
