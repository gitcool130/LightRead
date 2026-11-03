// 查字服务单测: 本地词典的字数、生僻字收录、逐字拆分与去重。
// 运行: npm run test:hanzi
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { isHanziChar, lookupHanzi } from '../src/services/hanzi.ts'

const dictPath = new URL('../src/assets/hanzi-dict.json', import.meta.url)
const dict = JSON.parse(readFileSync(dictPath, 'utf8'))

test('词典规模与体积在预期内', () => {
  const count = Object.keys(dict).length
  assert.ok(count > 14000, `词典应覆盖一万四千字以上, 实际 ${count}`)
  const bytes = readFileSync(dictPath).length
  assert.ok(bytes < 5 * 1024 * 1024, `词典应小于 5MB, 实际 ${(bytes / 1024 / 1024).toFixed(2)}MB`)
})

test('古籍常用字有拼音和释义', () => {
  // 注：蓍 在源数据里只有拼音没有释义，这里不列
  for (const ch of ['爻', '乾', '筮', '彖', '艮', '巽']) {
    const row = dict[ch]
    assert.ok(row, `${ch} 应该收录`)
    assert.ok(row[0] && row[0].length < 40, `${ch} 应有拼音, 实际 ${row[0]}`)
    assert.ok(row[1] && row[1].length > 6, `${ch} 应有释义`)
  }
})

test('释义去掉了开头的「字+拼音」前缀', () => {
  const def = dict['爻'][1]
  assert.ok(!def.startsWith('爻yáo'), `释义不该以 爻yáo 开头: ${def.slice(0, 20)}`)
})

test('isHanziChar: 汉字为真, 字母数字标点为假', () => {
  for (const ch of ['爻', '乾', 'a', '1', '，', ' ', 'é']) {
    assert.equal(isHanziChar(ch), ch !== 'a' && ch !== '1' && ch !== '，' && ch !== ' ' && ch !== 'é')
  }
})

test('lookupHanzi: 逐字拆分、去重、跳过非汉字', async () => {
  const entries = await lookupHanzi('六爻 六爻，abc 乾', 8, dict)
  assert.deepEqual(entries.map(e => e.char), ['六', '爻', '乾'])
  assert.ok(entries.every(e => e.found))
})

test('lookupHanzi: 词典没有的字标为未收录', async () => {
  const entries = await lookupHanzi('𠀀', 8, dict)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].found, false)
  assert.equal(entries[0].pinyin, '')
})

test('lookupHanzi: limit 生效', async () => {
  const entries = await lookupHanzi('天地玄黄宇宙洪荒', 3, dict)
  assert.equal(entries.length, 3)
})
