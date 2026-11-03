/**
 * 汉字拼音 / 释义本地词典。
 *
 * 数据来自开源《新华字典》整理版（scripts/build-hanzi-dict.py 生成），
 * 共约 1.5 万字，打包成 3.7 MB 的 JSON，首次查字时才按需加载，
 * 不联网也能查，古籍里的生僻字基本都在。
 */

export type HanziEntry = {
  /** 汉字 */
  char: string
  /** 拼音（多音字带逗号） */
  pinyin: string
  /** 释义（已去掉「字+拼音」前缀，按义项换行） */
  def: string
  /** 是否在词典里查到了 */
  found: boolean
}

/** 词典里每条是 [拼音, 释义]（JSON import 推断成 string[]，按索引取） */
type Dict = Record<string, string[]>

let dict: Dict | null = null
let pending: Promise<Dict> | null = null

/** 是不是汉字（含扩展 A/B 区与兼容区，古籍用字多落在这些区） */
export function isHanziChar(ch: string): boolean {
  const cp = ch.codePointAt(0)
  if (cp == null) return false
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x20000 && cp <= 0x2fa1f)
  )
}

/** 懒加载词典；重复调用只加载一次 */
export function loadHanziDict(): Promise<Dict> {
  if (dict) return Promise.resolve(dict)
  if (!pending) {
    pending = import('../assets/hanzi-dict.json').then(mod => {
      dict = ((mod as { default?: Dict }).default ?? mod) as Dict
      return dict
    })  }
  return pending
}

/** 词典是否已就绪（同步判断，用于按钮提示） */
export const hanziDictReady = () => dict !== null

/**
 * 查一段文字里的每个汉字。
 * 同一个字只保留一条，最多返回 limit 个字，避免选了整段时卡片拉太长。
 * table 仅测试时注入，正常调用走懒加载。
 */
export async function lookupHanzi(text: string, limit = 8, table?: Dict): Promise<HanziEntry[]> {
  const dictTable = table ?? (await loadHanziDict())
  const seen = new Set<string>()
  const out: HanziEntry[] = []
  for (const ch of text) {
    if (!isHanziChar(ch) || seen.has(ch)) continue
    seen.add(ch)
    const row = dictTable[ch]
    out.push({
      char: ch,
      pinyin: row?.[0] || '',
      def: row?.[1] || '',
      found: !!row,
    })
    if (out.length >= limit) break
  }
  return out
}
