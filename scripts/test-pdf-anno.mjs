// PDF 绘图批注契约: 编解码往返 (`a:1:` 前缀, 与划线的 `p:` 不冲突) / 包围盒 / 命中判定 /
// 拖动与贴边 / 轨迹抽稀 / 路径与箭头 / 误触过滤.
// 设计见 src/services/pdfAnno.ts; UI 在 src/views/PaperReaderView.vue 与 src/components/PdfAnnoLayer.vue.
// 运行: npm run test:pdf-anno
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ANNO_PREFIX,
  annoBounds,
  annoFromDrag,
  annoKindOf,
  arrowHeadPoints,
  clampAnno,
  decodeDraw,
  encodeDraw,
  hitTest,
  inkAppend,
  inkPathD,
  isDrawLoc,
  isMeaningfulAnno,
  moveAnno,
  simplifyInk,
} from '../src/services/pdfAnno.ts'

/** 一条近似水平的笔迹 (页坐标) */
const stroke = () => ({
  t: 'ink',
  p: 3,
  pts: [[10, 20], [40, 22], [70, 24], [100, 24]],
  w: 2,
  c: '#e5484d',
  a: 1,
})

test('编码带 a:1: 前缀, 与划线高亮的 p: 前缀互不干扰', () => {
  const cfi = encodeDraw(stroke())
  assert.ok(cfi.startsWith(ANNO_PREFIX))
  assert.equal(isDrawLoc(cfi), true)
  assert.equal(isDrawLoc('p:3:[{"x":1,"y":2,"w":3,"h":4}]'), false)
  assert.equal(decodeDraw('p:3:[{"x":1,"y":2,"w":3,"h":4}]'), null)
})

test('笔迹往返: 点、线宽、颜色、透明度都保住', () => {
  const src = stroke()
  const back = decodeDraw(encodeDraw(src))
  assert.deepEqual(back, src)
})

test('形状与文字框往返', () => {
  const rect = { t: 'rect', p: 1, x1: 10, y1: 20, x2: 60, y2: 80, w: 2, c: '#1c7ed6', a: 1 }
  assert.deepEqual(decodeDraw(encodeDraw(rect)), rect)

  const arrow = { t: 'arrow', p: 2, x1: 5, y1: 5, x2: 55, y2: 45, w: 4, c: '#2f9e44', a: 0.8 }
  assert.deepEqual(decodeDraw(encodeDraw(arrow)), arrow)

  const note = { t: 'note', p: 7, x: 30, y: 40, w: 200, h: 60, text: '重点\n第二行', c: '#f2a63b', s: 13 }
  assert.deepEqual(decodeDraw(encodeDraw(note)), note)
})

test('坏数据一律返回 null, 不炸页面', () => {
  assert.equal(decodeDraw('a:1:{'), null)
  assert.equal(decodeDraw('a:1:[]'), null)
  assert.equal(decodeDraw('a:1:{"t":"nope","p":1}'), null)
  assert.equal(decodeDraw('a:1:{"t":"ink","p":0,"pts":[[1,1]]}'), null)
  assert.equal(decodeDraw('a:1:{"t":"ink","p":1,"pts":[]}'), null)
  assert.equal(decodeDraw(''), null)
})

test('入库分类: 笔迹 / 形状 / 文字', () => {
  assert.equal(annoKindOf(stroke()), 'ink')
  assert.equal(annoKindOf({ t: 'rect', p: 1, x1: 0, y1: 0, x2: 1, y2: 1, w: 1, c: '#000', a: 1 }), 'shape')
  assert.equal(annoKindOf({ t: 'note', p: 1, x: 0, y: 0, w: 100, h: 40, text: '', c: '#000', s: 13 }), 'text')
})

test('包围盒含线宽余量, 形状按起止点归一', () => {
  const b = annoBounds(stroke())
  assert.deepEqual(b, { x: 9, y: 19, w: 92, h: 6 })

  // 反向拖出来的矩形: 起点右下、终点左上
  const r = annoBounds({ t: 'rect', p: 1, x1: 100, y1: 80, x2: 40, y2: 20, w: 2, c: '#000', a: 1 })
  assert.deepEqual(r, { x: 39, y: 19, w: 62, h: 62 })
})

test('命中: 笔迹按线走, 形状与文字框按框内', () => {
  const s = stroke()
  assert.equal(hitTest(s, 40, 22, 3), true)
  assert.equal(hitTest(s, 40, 60, 3), false)

  const rect = { t: 'rect', p: 1, x1: 20, y1: 20, x2: 120, y2: 120, w: 2, c: '#000', a: 1 }
  assert.equal(hitTest(rect, 70, 70, 3), true)
  assert.equal(hitTest(rect, 200, 70, 3), false)

  const line = { t: 'line', p: 1, x1: 20, y1: 20, x2: 120, y2: 20, w: 2, c: '#000', a: 1 }
  assert.equal(hitTest(line, 70, 21, 2), true)
  assert.equal(hitTest(line, 70, 40, 2), false)

  const note = { t: 'note', p: 1, x: 20, y: 20, w: 100, h: 50, text: 'x', c: '#000', s: 13 }
  assert.equal(hitTest(note, 40, 40, 2), true)
  assert.equal(hitTest(note, 40, 90, 2), false)
})

test('拖动整条平移, 各种类型都不变形', () => {
  const moved = moveAnno(stroke(), 5, -5)
  assert.deepEqual(moved.pts[0], [15, 15])
  assert.equal(moved.w, 2)

  const rect = moveAnno({ t: 'rect', p: 1, x1: 1, y1: 2, x2: 3, y2: 4, w: 1, c: '#000', a: 1 }, 10, 10)
  assert.deepEqual([rect.x1, rect.y1, rect.x2, rect.y2], [11, 12, 13, 14])

  const note = moveAnno({ t: 'note', p: 1, x: 1, y: 2, w: 10, h: 10, text: 'a', c: '#000', s: 12 }, 3, 4)
  assert.deepEqual([note.x, note.y], [4, 6])
})

test('贴边: 拖出页面会被推回页内, 页面内的批注不动', () => {
  const inside = { t: 'rect', p: 1, x1: 10, y1: 10, x2: 100, y2: 100, w: 2, c: '#000', a: 1 }
  assert.equal(clampAnno(inside, 595, 842), inside)

  const out = { t: 'rect', p: 1, x1: -20, y1: -30, x2: 100, y2: 100, w: 2, c: '#000', a: 1 }
  const fixed = clampAnno(out, 595, 842)
  // 线宽余量 (1pt) 也要回到页内: 上边从 -31 推到 0, 于是整体右下移
  assert.deepEqual([fixed.x1, fixed.y1, fixed.x2, fixed.y2], [1, 1, 121, 131])
})

test('轨迹抽稀保留首尾, 平掉过密的采样点', () => {
  const pts = Array.from({ length: 200 }, (_, i) => [i * 0.1, 0])
  const thin = simplifyInk(pts, 2)
  assert.ok(thin.length < pts.length)
  assert.deepEqual(thin[0], pts[0])
  assert.deepEqual(thin[thin.length - 1], pts[pts.length - 1])
  // 两点不够抽稀, 原样返回
  assert.deepEqual(simplifyInk([[0, 0], [10, 0]], 5), [[0, 0], [10, 0]])
})

test('path 与箭头: 单点也能画出圆点, 箭头三角有三个点', () => {
  assert.equal(inkPathD([]), '')
  assert.ok(inkPathD([[10, 10]]).startsWith('M10 10'))
  const d = inkPathD([[0, 0], [10, 0], [20, 10]])
  assert.ok(d.startsWith('M0 0'))
  assert.ok(d.includes('Q'))
  assert.ok(d.endsWith('L20 10'))

  const head = arrowHeadPoints(0, 0, 100, 0, 2)
  assert.equal(head.split(' ').length, 3)
  const [tip] = head.split(' ')
  assert.deepEqual(tip.split(',').map(Number), [100, 0])
})

test('误触过滤: 太短的划线 / 太小的框不算批注', () => {
  assert.equal(isMeaningfulAnno({ t: 'ink', p: 1, pts: [[10, 10], [10.5, 10.2]], w: 2, c: '#000', a: 1 }), false)
  assert.equal(isMeaningfulAnno(stroke()), true)
  assert.equal(isMeaningfulAnno({ t: 'line', p: 1, x1: 10, y1: 10, x2: 11, y2: 11, w: 2, c: '#000', a: 1 }), false)
  assert.equal(isMeaningfulAnno({ t: 'note', p: 1, x: 10, y: 10, w: 200, h: 60, text: '', c: '#000', s: 13 }), true)
})

test('拖拽原型: 画笔从单点起笔, 形状吃起止点, 文字框给默认尺寸', () => {
  const pen = annoFromDrag('pen', 2, { x: 5, y: 6 }, { x: 7, y: 8 }, 2, '#e5484d', 1)
  assert.equal(pen.t, 'ink')
  assert.deepEqual(pen.pts, [[5, 6]])

  const marker = annoFromDrag('marker', 2, { x: 5, y: 6 }, { x: 7, y: 8 }, 10, '#f2a63b', 0.35)
  assert.equal(marker.a, 0.35)

  const arrow = annoFromDrag('arrow', 4, { x: 1, y: 2 }, { x: 30, y: 40 }, 2, '#000', 1)
  assert.deepEqual([arrow.x1, arrow.y1, arrow.x2, arrow.y2], [1, 2, 30, 40])

  const note = annoFromDrag('note', 5, { x: 50, y: 60 }, { x: 50, y: 60 }, 0, '#000', 1)
  assert.equal(note.t, 'note')
  assert.ok(note.w > 0 && note.h > 0)
})

test('画笔追加采样点: 太近的点丢掉, 拉开了就接上', () => {
  const a = annoFromDrag('pen', 1, { x: 0, y: 0 }, { x: 0, y: 0 }, 2, '#000', 1)
  const same = inkAppend(a, 0.2, 0.2, 1)
  assert.equal(same.pts.length, 1)
  const next = inkAppend(a, 5, 5, 1)
  assert.equal(next.pts.length, 2)
  assert.deepEqual(next.pts[1], [5, 5])
  // 不改原对象
  assert.equal(a.pts.length, 1)
})
