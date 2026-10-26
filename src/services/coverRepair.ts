import type { BookMeta, LibraryStorage } from '../storage/types'

/**
 * 封面字节是否像一张浏览器能显示的图片: 非空且文件头是常见位图格式.
 * 只看文件头 (不解码), 书库刷新时逐本调用也不贵; 截断但文件头完好的图片仍算可用 (能显示一部分).
 */
export function isUsableCoverBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  const at = (i: number, ...sig: number[]) => sig.every((b, k) => bytes[i + k] === b)
  return at(0, 0xff, 0xd8, 0xff) // JPEG
    || at(0, 0x89, 0x50, 0x4e, 0x47) // PNG
    || at(0, 0x47, 0x49, 0x46, 0x38) // GIF
    || at(0, 0x42, 0x4d) // BMP
    || (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) // WebP
    || at(4, 0x66, 0x74, 0x79, 0x70) // AVIF / HEIF (ftyp)
}

type CoverStorage = Pick<LibraryStorage, 'getCoverUrl' | 'setCover' | 'clearCover'>

export interface CoverResolverDeps {
  storage: CoverStorage
  /** 从书籍文件重新取封面 (PDF 第一页等); 没有可用封面返回 undefined, 出错 (可能是暂时的) 抛出 */
  regenerate(book: BookMeta): Promise<Blob | undefined>
}

/**
 * 取书的封面地址, 本地封面损坏 (空文件 / 缺失 / 不是图片) 时自动修复:
 * 从书籍文件重新生成并写回; 书里确实取不到封面就清掉「有封面」标记, 以后直接显示文字封面.
 * 每本书每次运行最多修复一次; 重新生成出错时保留标记, 下次启动再试. 不动书籍文件与其他元数据.
 * 返回 undefined 时界面显示文字封面.
 */
export function createCoverResolver(deps: CoverResolverDeps) {
  const tried = new Set<string>()
  const pending = new Map<string, Promise<string | undefined>>()

  async function repair(book: BookMeta): Promise<string | undefined> {
    let cover: Blob | undefined
    try {
      cover = await deps.regenerate(book)
    } catch (e) {
      console.warn('[cover] regenerate failed', book.id, e)
      return undefined
    }
    if (cover?.size) {
      await deps.storage.setCover!(book.id, cover)
      const fresh = await deps.storage.getCoverUrl(book.id).catch(() => undefined)
      if (fresh) return fresh
    }
    await deps.storage.clearCover?.(book.id)
    book.hasCover = false
    return undefined
  }

  return async function resolveCover(book: BookMeta): Promise<string | undefined> {
    if (!book.hasCover) return undefined
    const url = await deps.storage.getCoverUrl(book.id).catch(() => undefined)
    if (url) return url
    const running = pending.get(book.id)
    if (running) return running
    if (tried.has(book.id) || !deps.storage.setCover) return undefined
    tried.add(book.id)
    const job = repair(book).finally(() => pending.delete(book.id))
    pending.set(book.id, job)
    return job
  }
}
