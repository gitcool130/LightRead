/**
 * 桌面端存储实现 (Tauri 2):
 *  - 书籍与封面以原始文件形式存放在应用数据目录 books/ covers/ 下
 *  - 元数据用 SQLite 索引 (tauri-plugin-sql)
 */
import type {
  AnnotationRec, BooklistRec, BooklistWantedRec, BookMeta, CatalogSourceRec, LibraryStorage, LocalFileRef, NewBookMeta,
} from './types'
import { BUILTIN_SOURCES, getLibraryRoot, newId } from './types'
import { needsChunkedIpc, writeBlobInChunks } from './chunkedWrite'

type SqlDatabase = {
  execute(sql: string, values?: unknown[]): Promise<unknown>
  select<T>(sql: string, values?: unknown[]): Promise<T>
}

interface BookRow {
  id: string
  title: string
  author: string
  format: string
  file_name: string
  description: string | null
  language: string | null
  tags: string
  added_at: number
  last_read_at: number | null
  location: string | null
  progress: number | null
  source: string | null
  has_cover: number
  reading_seconds: number | null
  pinned_at: number | null
  kind: string | null
  no_sync: number | null
}

const rowToMeta = (r: BookRow): BookMeta => ({
  id: r.id,
  title: r.title,
  author: r.author,
  format: r.format as BookMeta['format'],
  fileName: r.file_name,
  description: r.description ?? undefined,
  language: r.language ?? undefined,
  tags: JSON.parse(r.tags || '[]'),
  addedAt: r.added_at,
  lastReadAt: r.last_read_at ?? undefined,
  location: r.location ?? undefined,
  progress: r.progress ?? undefined,
  source: r.source ?? undefined,
  hasCover: !!r.has_cover,
  readingSeconds: r.reading_seconds ?? 0,
  pinnedAt: r.pinned_at ?? undefined,
  kind: r.kind === 'paper' ? 'paper' : 'book',
  ...(r.no_sync ? { noSync: true } : {}),
})

const META_COLUMNS: Record<string, string> = {
  title: 'title',
  format: 'format',
  addedAt: 'added_at',
  author: 'author',
  fileName: 'file_name',
  description: 'description',
  language: 'language',
  lastReadAt: 'last_read_at',
  location: 'location',
  progress: 'progress',
  source: 'source',
  readingSeconds: 'reading_seconds',
  pinnedAt: 'pinned_at',
  kind: 'kind',
  noSync: 'no_sync',
}

export class TauriStorage implements LibraryStorage {
  readonly kind = 'filesystem' as const
  private db!: SqlDatabase
  private fs!: typeof import('@tauri-apps/plugin-fs')
  /** 自定义书库根目录, 空为默认应用数据目录 */
  private root = ''
  private coverUrls = new Map<string, string>()

  /** 相对路径 → fs 插件的 (path, options); 自定义根目录时用绝对路径 */
  private loc(rel: string): [string, { baseDir?: number }] {
    return this.root
      ? [`${this.root}/${rel}`, {}]
      : [rel, { baseDir: this.fs.BaseDirectory.AppData }]
  }

  async init() {
    const [{ default: Database }, fs] = await Promise.all([
      import('@tauri-apps/plugin-sql'),
      import('@tauri-apps/plugin-fs'),
    ])
    this.fs = fs
    this.root = getLibraryRoot().replace(/\/+$/, '')
    this.db = await Database.load(
      this.root ? `sqlite:${this.root}/lightread.db` : 'sqlite:lightread.db')

    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS books (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        format TEXT NOT NULL,
        file_name TEXT NOT NULL,
        description TEXT,
        language TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        added_at INTEGER NOT NULL,
        last_read_at INTEGER,
        location TEXT,
        progress REAL,
        source TEXT,
        has_cover INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS annotations (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        cfi TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        note TEXT,
        color TEXT NOT NULL DEFAULT 'yellow',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_annotations_book ON annotations(book_id);
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        builtin INTEGER NOT NULL DEFAULT 0,
        added_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS booklists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS booklist_items (
        booklist_id TEXT NOT NULL,
        book_id TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (booklist_id, book_id)
      );
      CREATE INDEX IF NOT EXISTS idx_booklist_items_booklist
        ON booklist_items(booklist_id);
      CREATE INDEX IF NOT EXISTS idx_booklist_items_book
        ON booklist_items(book_id);
      CREATE TABLE IF NOT EXISTS booklist_wanted (
        id TEXT PRIMARY KEY,
        booklist_id TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        isbn TEXT,
        year INTEGER,
        note TEXT,
        original_title TEXT,
        original_author TEXT,
        added_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_booklist_wanted_booklist
        ON booklist_wanted(booklist_id);
    `)

    for (const dir of ['books', 'covers']) {
      const [path, opts] = this.loc(dir)
      if (!(await this.fs.exists(path, opts))) {
        await this.fs.mkdir(path, { ...opts, recursive: true })
      }
    }

    // 列迁移: 旧库补充新增字段
    for (const ddl of [
      "ALTER TABLE sources ADD COLUMN kind TEXT NOT NULL DEFAULT 'opds'",
      'ALTER TABLE sources ADD COLUMN username TEXT',
      'ALTER TABLE sources ADD COLUMN password TEXT',
      'ALTER TABLE sources ADD COLUMN updated_at INTEGER',
      "ALTER TABLE annotations ADD COLUMN kind TEXT NOT NULL DEFAULT 'highlight'",
      'ALTER TABLE books ADD COLUMN reading_seconds INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE books ADD COLUMN pinned_at INTEGER',
      "ALTER TABLE books ADD COLUMN kind TEXT NOT NULL DEFAULT 'book'",
      'ALTER TABLE books ADD COLUMN no_sync INTEGER NOT NULL DEFAULT 0',
    ]) {
      await this.db.execute(ddl).catch(() => { /* 列已存在 */ })
    }

    // 内置书源与代码中的清单同步 (处理内置源的增删调整)
    const builtinUrls = BUILTIN_SOURCES.map(s => s.url)
    const rows = await this.db.select<Array<{ id: string; url: string; builtin: number }>>(
      'SELECT id, url, builtin FROM sources')
    for (const row of rows) {
      if (row.builtin && !builtinUrls.includes(row.url)) {
        await this.db.execute('DELETE FROM sources WHERE id = $1', [row.id])
      }
    }
    const existingUrls = new Set(rows.map(r => r.url))
    for (const s of BUILTIN_SOURCES) {
      if (!existingUrls.has(s.url)) {
        await this.db.execute(
          'INSERT INTO sources (id, title, url, kind, builtin, added_at) VALUES ($1, $2, $3, $4, 1, $5)',
          [newId(), s.title, s.url, s.kind, Date.now()])
      }
    }
  }

  private bookPath = (id: string, fileName: string) => {
    const ext = fileName.toLowerCase().endsWith('.fb2.zip')
      ? 'fb2.zip'
      : fileName.split('.').pop() || 'bin'
    return `books/${id}.${ext}`
  }
  private coverPath = (id: string) => `covers/${id}.jpg`

  async listBooks() {
    const rows = await this.db.select<BookRow[]>(
      'SELECT * FROM books ORDER BY added_at DESC')
    return rows.map(rowToMeta)
  }

  async getBook(id: string) {
    const rows = await this.db.select<BookRow[]>(
      'SELECT * FROM books WHERE id = $1', [id])
    return rows[0] ? rowToMeta(rows[0]) : undefined
  }

  async addBook(meta: NewBookMeta, file: Blob, cover?: Blob) {
    const id = newId()
    await this.writeBookFile(this.bookPath(id, meta.fileName), file)
    await this.insertBook(id, meta, cover)
    return id
  }

  /** 写书籍文件. 安卓分块交给原生层写 (见 chunkedWrite.ts), 桌面 IPC 可直接传字节 */
  private async writeBookFile(rel: string, file: Blob) {
    if (!needsChunkedIpc()) {
      const [path, opts] = this.loc(rel)
      await this.fs.writeFile(path, new Uint8Array(await file.arrayBuffer()), opts)
      return
    }
    try {
      await writeBlobInChunks(file, (offset, data) =>
        this.libraryFile('library_file_write_chunk', { rel, offset, data }))
    } catch (e) {
      await this.libraryFile('library_file_remove', { rel }).catch(() => { /* 半截文件清理失败不掩盖原错误 */ })
      throw e
    }
  }

  /** 写封面并插入书目行 (书籍文件已就位) */
  private async insertBook(id: string, meta: NewBookMeta, cover?: Blob) {
    if (cover) {
      const [path, opts] = this.loc(this.coverPath(id))
      await this.fs.writeFile(path, new Uint8Array(await cover.arrayBuffer()), opts)
    }
    await this.db.execute(
      `INSERT INTO books (id, title, author, format, file_name, description, language,
        tags, added_at, last_read_at, location, progress, source, has_cover, kind,
        reading_seconds, pinned_at, no_sync)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [id, meta.title, meta.author, meta.format, meta.fileName,
        meta.description ?? null, meta.language ?? null, JSON.stringify(meta.tags),
        meta.addedAt, meta.lastReadAt ?? null, meta.location ?? null,
        meta.progress ?? null, meta.source ?? null, cover ? 1 : 0,
        meta.kind === 'paper' ? 'paper' : 'book',
        Math.round(meta.readingSeconds ?? 0), meta.pinnedAt || null, meta.noSync ? 1 : 0])
  }

  // ---- 同步: 书的内容由原生层读写 (src-tauri/src/library_files.rs), 不经过 WebView ----

  private async libraryFile<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<T>(cmd, { root: this.root, ...args })
  }

  async hashBookFile(id: string) {
    const meta = await this.getBook(id)
    if (!meta) throw new Error('书籍不存在')
    return this.libraryFile<string>('library_file_sha256', { rel: this.bookPath(id, meta.fileName) })
  }

  async stageBookFile(tag: string): Promise<LocalFileRef> {
    const rel = `books/sync-${tag.replace(/[^0-9a-zA-Z_-]/g, '')}.part`
    return { kind: 'local-file', root: this.root, rel, blob: () => this.readRel(rel) }
  }

  async stageBookFromPath(path: string): Promise<LocalFileRef> {
    const staged = await this.stageBookFile(`import-${newId()}`)
    await this.libraryFile('library_import_copy', { path, rel: staged.rel })
    return staged
  }

  async addBookFromStaged(meta: NewBookMeta, staged: LocalFileRef, cover?: Blob) {
    const id = newId()
    const rel = this.bookPath(id, meta.fileName)
    await this.libraryFile('library_file_rename', { from: staged.rel, to: rel })
    try {
      await this.insertBook(id, meta, cover)
    } catch (error) {
      await this.libraryFile('library_file_remove', { rel }).catch(() => {})
      await this.libraryFile('library_file_remove', { rel: this.coverPath(id) }).catch(() => {})
      throw error
    }
    return id
  }

  async discardStaged(staged: LocalFileRef) {
    await this.libraryFile('library_file_remove', { rel: staged.rel })
  }

  private async readRel(rel: string) {
    const [path, opts] = this.loc(rel)
    const bytes = await this.fs.readFile(path, opts)
    return new Blob([bytes.buffer as ArrayBuffer])
  }

  async updateBook(id: string, patch: Partial<Omit<BookMeta, 'id'>>) {
    // 文件路径的扩展名取自 fileName: 同步改了文件名 (扩展名不同) 时把文件挪到新路径
    if (typeof patch.fileName === 'string') {
      const old = await this.getBook(id)
      const from = old && this.bookPath(id, old.fileName)
      const to = this.bookPath(id, patch.fileName)
      if (from && from !== to) {
        // 原生改名, 书的内容不经过 WebView; 旧文件缺失时照旧只改元数据
        const [fromPath, fromOpts] = this.loc(from)
        if (await this.fs.exists(fromPath, fromOpts).catch(() => false)) {
          await this.libraryFile('library_file_rename', { from, to })
        }
      }
    }
    const sets: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'tags') {
        sets.push(`tags = $${values.length + 1}`)
        values.push(JSON.stringify(value))
      } else if (key === 'noSync') {
        sets.push(`no_sync = $${values.length + 1}`)
        values.push(value ? 1 : 0)
      } else if (key in META_COLUMNS) {
        sets.push(`${META_COLUMNS[key]} = $${values.length + 1}`)
        values.push(value ?? null)
      }
    }
    if (!sets.length) return
    values.push(id)
    await this.db.execute(
      `UPDATE books SET ${sets.join(', ')} WHERE id = $${values.length}`, values)
  }

  async deleteBook(id: string) {
    const meta = await this.getBook(id)
    await this.db.execute('DELETE FROM annotations WHERE book_id = $1', [id])
    await this.db.execute('DELETE FROM booklist_items WHERE book_id = $1', [id])
    await this.db.execute('DELETE FROM books WHERE id = $1', [id])
    if (meta) {
      const [bookPath, bookOpts] = this.loc(this.bookPath(id, meta.fileName))
      await this.fs.remove(bookPath, bookOpts).catch(() => { /* 文件缺失不阻塞删除 */ })
      if (meta.hasCover) {
        const [coverPath, coverOpts] = this.loc(this.coverPath(id))
        await this.fs.remove(coverPath, coverOpts).catch(() => { /* 同上 */ })
      }
    }
    const url = this.coverUrls.get(id)
    if (url) {
      URL.revokeObjectURL(url)
      this.coverUrls.delete(id)
    }
  }

  async getBookFile(id: string) {
    const meta = await this.getBook(id)
    if (!meta) throw new Error('书籍不存在')
    const [path, opts] = this.loc(this.bookPath(id, meta.fileName))
    const bytes = await this.fs.readFile(path, opts)
    return new Blob([bytes.buffer as ArrayBuffer])
  }

  async getBookFileRef(id: string): Promise<LocalFileRef | undefined> {
    const meta = await this.getBook(id)
    if (!meta) return undefined
    const rel = this.bookPath(id, meta.fileName)
    return { kind: 'local-file', root: this.root, rel, blob: () => this.getBookFile(id) }
  }

  async getCoverUrl(id: string) {
    const cached = this.coverUrls.get(id)
    if (cached) return cached
    const meta = await this.getBook(id)
    if (!meta?.hasCover) return undefined
    try {
      const [path, opts] = this.loc(this.coverPath(id))
      const bytes = await this.fs.readFile(path, opts)
      const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'image/jpeg' }))
      this.coverUrls.set(id, url)
      return url
    } catch {
      return undefined
    }
  }

  async listBooklists() {
    const rows = await this.db.select<Array<{
      id: string
      name: string
      created_at: number
      updated_at: number
    }>>('SELECT * FROM booklists ORDER BY created_at DESC')
    return rows.map((row): BooklistRec => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  async createBooklist(name: string, opts: { id?: string; createdAt?: number } = {}) {
    const id = opts.id ?? newId()
    const now = Date.now()
    await this.db.execute(
      'INSERT OR REPLACE INTO booklists (id, name, created_at, updated_at) VALUES ($1, $2, $3, $4)',
      [id, name, opts.createdAt ?? now, now])
    return id
  }

  async renameBooklist(id: string, name: string) {
    await this.db.execute(
      'UPDATE booklists SET name = $1, updated_at = $2 WHERE id = $3',
      [name, Date.now(), id])
  }

  async deleteBooklist(id: string) {
    await this.db.execute('DELETE FROM booklist_items WHERE booklist_id = $1', [id])
    await this.db.execute('DELETE FROM booklist_wanted WHERE booklist_id = $1', [id])
    await this.db.execute('DELETE FROM booklists WHERE id = $1', [id])
  }

  async listBooklistBookIds(booklistId: string) {
    const rows = await this.db.select<Array<{ book_id: string }>>(
      'SELECT book_id FROM booklist_items WHERE booklist_id = $1 ORDER BY added_at',
      [booklistId])
    return rows.map(row => row.book_id)
  }

  async listBooklistItems(booklistId: string) {
    const rows = await this.db.select<Array<{ book_id: string; added_at: number }>>(
      'SELECT book_id, added_at FROM booklist_items WHERE booklist_id = $1 ORDER BY added_at',
      [booklistId])
    return rows.map(row => ({ bookId: row.book_id, addedAt: row.added_at }))
  }

  async addBooksToBooklist(booklistId: string, bookIds: string[], opts: { addedAt?: number } = {}) {
    const uniqueIds = [...new Set(bookIds)]
    if (!uniqueIds.length) return
    const now = Date.now()
    const start = opts.addedAt ?? now
    for (const [index, bookId] of uniqueIds.entries()) {
      await this.db.execute(
        `INSERT OR IGNORE INTO booklist_items (booklist_id, book_id, added_at)
         VALUES ($1, $2, $3)`,
        [booklistId, bookId, start + index])
    }
    await this.db.execute(
      'UPDATE booklists SET updated_at = $1 WHERE id = $2', [now, booklistId])
  }

  async removeBooksFromBooklist(booklistId: string, bookIds: string[]) {
    const uniqueIds = [...new Set(bookIds)]
    if (!uniqueIds.length) return
    for (const bookId of uniqueIds) {
      await this.db.execute(
        'DELETE FROM booklist_items WHERE booklist_id = $1 AND book_id = $2',
        [booklistId, bookId])
    }
    await this.db.execute(
      'UPDATE booklists SET updated_at = $1 WHERE id = $2',
      [Date.now(), booklistId])
  }

  async listBooklistWanted() {
    const rows = await this.db.select<Array<{
      id: string; booklist_id: string; title: string; author: string; isbn: string | null; year: number | null
      note: string | null; original_title: string | null; original_author: string | null; added_at: number
    }>>('SELECT * FROM booklist_wanted ORDER BY added_at')
    return rows.map((row): BooklistWantedRec => {
      const rec: BooklistWantedRec = {
        id: row.id, booklistId: row.booklist_id, title: row.title, author: row.author ?? '', addedAt: row.added_at,
      }
      if (row.isbn) rec.isbn = row.isbn
      if (row.year != null) rec.year = row.year
      if (row.note) rec.note = row.note
      if (row.original_title) rec.originalTitle = row.original_title
      if (row.original_author) rec.originalAuthor = row.original_author
      return rec
    })
  }

  async putBooklistWanted(recs: BooklistWantedRec[]) {
    if (!recs.length) return
    for (const rec of recs) {
      await this.db.execute(
        `INSERT OR REPLACE INTO booklist_wanted
          (id, booklist_id, title, author, isbn, year, note, original_title, original_author, added_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [rec.id, rec.booklistId, rec.title, rec.author ?? '', rec.isbn ?? null, rec.year ?? null, rec.note ?? null,
          rec.originalTitle ?? null, rec.originalAuthor ?? null, rec.addedAt])
    }
    const now = Date.now()
    for (const id of new Set(recs.map(rec => rec.booklistId))) {
      await this.db.execute('UPDATE booklists SET updated_at = $1 WHERE id = $2', [now, id])
    }
  }

  async deleteBooklistWanted(ids: string[]) {
    const unique = [...new Set(ids)]
    if (!unique.length) return
    const now = Date.now()
    for (const id of unique) {
      const rows = await this.db.select<Array<{ booklist_id: string }>>(
        'SELECT booklist_id FROM booklist_wanted WHERE id = $1', [id])
      await this.db.execute('DELETE FROM booklist_wanted WHERE id = $1', [id])
      if (rows[0]) await this.db.execute('UPDATE booklists SET updated_at = $1 WHERE id = $2', [now, rows[0].booklist_id])
    }
  }

  async listAnnotations(bookId: string) {
    const rows = await this.db.select<Array<{
      id: string; book_id: string; kind: string | null; cfi: string; text: string
      note: string | null; color: string; created_at: number
    }>>('SELECT * FROM annotations WHERE book_id = $1 ORDER BY created_at', [bookId])
    return rows.map(r => ({
      id: r.id, bookId: r.book_id,
      kind: (r.kind ?? 'highlight') as AnnotationRec['kind'],
      cfi: r.cfi, text: r.text,
      note: r.note ?? undefined, color: r.color, createdAt: r.created_at,
    }))
  }

  async addAnnotation(a: Omit<AnnotationRec, 'id'> & { id?: string }) {
    const id = a.id ?? newId()
    await this.db.execute(
      `INSERT OR REPLACE INTO annotations (id, book_id, kind, cfi, text, note, color, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, a.bookId, a.kind ?? 'highlight', a.cfi, a.text, a.note ?? null, a.color, a.createdAt])
    return id
  }

  async updateAnnotation(id: string, patch: Partial<Omit<AnnotationRec, 'id' | 'bookId'>>) {
    if (patch.note !== undefined) {
      await this.db.execute('UPDATE annotations SET note = $1 WHERE id = $2', [patch.note ?? null, id])
    }
    if (patch.color !== undefined) {
      await this.db.execute('UPDATE annotations SET color = $1 WHERE id = $2', [patch.color, id])
    }
  }

  async deleteAnnotation(id: string) {
    await this.db.execute('DELETE FROM annotations WHERE id = $1', [id])
  }

  async listSources() {
    const rows = await this.db.select<Array<{
      id: string; title: string; url: string; kind: string; builtin: number
      added_at: number; updated_at: number | null; username: string | null; password: string | null
    }>>('SELECT * FROM sources ORDER BY added_at')
    return rows.map(r => ({
      id: r.id,
      title: r.title,
      url: r.url,
      kind: (r.kind || 'opds') as CatalogSourceRec['kind'],
      builtin: !!r.builtin,
      addedAt: r.added_at,
      updatedAt: r.updated_at ?? undefined,
      username: r.username ?? undefined,
      password: r.password ?? undefined,
    }))
  }

  async addSource(s: Omit<CatalogSourceRec, 'id'>) {
    const id = newId()
    await this.db.execute(
      `INSERT INTO sources (id, title, url, kind, builtin, added_at, username, password, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, s.title, s.url, s.kind, s.builtin ? 1 : 0, s.addedAt,
        s.username ?? null, s.password ?? null, s.updatedAt ?? null])
    return id
  }

  async updateSource(id: string, s: Omit<CatalogSourceRec, 'id' | 'builtin'>) {
    await this.db.execute(
      `UPDATE sources SET title = $1, url = $2, kind = $3, added_at = $4, username = $5, password = $6,
       updated_at = $7 WHERE id = $8`,
      [s.title, s.url, s.kind, s.addedAt, s.username || null, s.password || null, s.updatedAt ?? null, id])
  }

  async deleteSource(id: string) {
    await this.db.execute('DELETE FROM sources WHERE id = $1', [id])
  }
}


/** 目标文件夹是否已有轻阅书库 */
export async function hasLibraryAt(root: string): Promise<boolean> {
  const fs = await import('@tauri-apps/plugin-fs')
  return fs.exists(`${root.replace(/\/+$/, '')}/lightread.db`)
}

/**
 * 把当前书库复制到新文件夹 (db + 书籍 + 封面).
 * 完成后由调用方写入 libraryRoot 设置并整页重载.
 */
export async function migrateLibraryTo(
  newRoot: string,
  onProgress?: (msg: string) => void,
): Promise<void> {
  const fs = await import('@tauri-apps/plugin-fs')
  const root = newRoot.replace(/\/+$/, '')
  const currentRoot = getLibraryRoot().replace(/\/+$/, '')
  const srcLoc = (rel: string): [string, { baseDir?: number }] =>
    currentRoot ? [`${currentRoot}/${rel}`, {}] : [rel, { baseDir: fs.BaseDirectory.AppData }]
  // SQLite 主库在 AppConfig (macOS 上与 AppData 同目录, 其他平台不同)
  const srcDbLoc = (rel: string): [string, { baseDir?: number }] =>
    currentRoot ? [`${currentRoot}/${rel}`, {}] : [rel, { baseDir: fs.BaseDirectory.AppConfig }]

  for (const dir of ['books', 'covers']) {
    if (!(await fs.exists(`${root}/${dir}`))) {
      await fs.mkdir(`${root}/${dir}`, { recursive: true })
    }
  }

  onProgress?.('复制索引数据库…')
  for (const dbFile of ['lightread.db', 'lightread.db-wal', 'lightread.db-shm']) {
    const [src, opts] = srcDbLoc(dbFile)
    if (await fs.exists(src, opts)) {
      const bytes = await fs.readFile(src, opts)
      await fs.writeFile(`${root}/${dbFile}`, bytes)
    }
  }

  for (const dir of ['books', 'covers']) {
    const [srcDir, opts] = srcLoc(dir)
    if (!(await fs.exists(srcDir, opts))) continue
    const entries = await fs.readDir(srcDir, opts)
    let done = 0
    for (const entry of entries) {
      if (!entry.isFile) continue
      onProgress?.(`复制 ${dir} (${++done}/${entries.length})…`)
      const [srcFile, srcOpts] = srcLoc(`${dir}/${entry.name}`)
      const bytes = await fs.readFile(srcFile, srcOpts)
      await fs.writeFile(`${root}/${dir}/${entry.name}`, bytes)
    }
  }
  onProgress?.('迁移完成')
}
