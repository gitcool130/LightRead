/**
 * 把 WebView 里的大文件分块写到原生层 (src-tauri/src/library_files.rs 的 `library_file_write_chunk`).
 *
 * 安卓上 Tauri IPC 走 postMessage, 字节数组会被序列化成 JSON 数字数组: 40 MB 的 PDF 要在主线程
 * 拼出几百 MB 的字符串, 导入卡在 0% 后闪退 (issue #14). 改为每块 base64 (体积约为数字数组的 1/3),
 * 内存只与块大小有关, 每块之间还会让出主线程, 进度界面不再冻住.
 */

/** 每块原始字节数: base64 后约 5.3 MB 字符串, 兼顾往返次数与峰值内存 */
export const WRITE_CHUNK_BYTES = 4 * 1024 * 1024

/** Blob 片段 → base64 (浏览器: FileReader 原生编码, 不在 JS 里逐字节循环) */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsDataURL(blob)
  })
}

/** 按顺序把 blob 分块交给 `write(offset, base64)`; 返回写入的总字节数 */
export async function writeBlobInChunks(
  blob: Blob,
  write: (offset: number, data: string) => Promise<unknown>,
  { chunkBytes = WRITE_CHUNK_BYTES, toBase64 = blobToBase64 } = {},
): Promise<number> {
  let offset = 0
  // 空文件也要写一次 (offset 0 会建文件)
  do {
    const end = Math.min(blob.size, offset + chunkBytes)
    await write(offset, await toBase64(blob.slice(offset, end)))
    offset = end
  } while (offset < blob.size)
  return offset
}

/** 安卓 WebView 的 IPC 不能直接传字节, 需要分块 */
export const needsChunkedIpc = () =>
  typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
