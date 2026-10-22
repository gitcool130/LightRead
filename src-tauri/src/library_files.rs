//! 同步用的书库文件命令: 算指纹、下载、改名、删除, 书的内容都不经过 WebView.
//!
//! 安卓上 plugin-fs / plugin-http 把文件内容经 IPC 搬进 JS (postMessage 通道上是 JSON 数字数组),
//! 几十 MB 的书就会把 WebView 内存撑爆 (同步时卡死、闪退). 这里改为:
//!  - `library_file_sha256`: 流式读盘算 SHA-256, 内存占用与文件大小无关;
//!  - `library_file_download`: 流式下载到书库里的暂存文件 (`books/<名字>`), 边下边算 SHA-256,
//!    前端比对后再 `library_file_rename` 成正式文件, 不通过则 `library_file_remove`.
//!  - `library_file_write_chunk`: 导入时 WebView 里的书 (只有 File 对象, 没有路径) 分块以 base64 传入
//!    追加写盘. 一次性 `writeFile` 会把整本书变成 JSON 数字数组, 40 MB 的 PDF 就能让平板卡死闪退 (issue #14).
//! 路径规则与上传命令相同 (见 http_upload.rs 的 `resolve_library_file`): 只能是书库的
//! `books/<文件名>` / `covers/<文件名>`. 错误字符串以 `timeout:` / `network:` / `file:` / `request:` 前缀区分.

use std::{
  collections::BTreeMap,
  io::{Read, Seek, SeekFrom, Write},
  path::Path,
  time::Duration,
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::http_upload::{build_client, map_err, resolve_library_file, FileRef, UploadSpec};

/// 下载整体上限 (与前端 DOWNLOAD_TIMEOUT_MS 一致)
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// 连续这么久收不到数据视为卡住
const STALL_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Serialize, PartialEq)]
pub struct DownloadResult {
  pub status: u16,
  /// 下载成功 (2xx) 时为文件的 SHA-256 十六进制, 否则为空
  pub sha256: String,
  pub size: u64,
}

fn hex(digest: &[u8]) -> String {
  digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// 流式计算文件的 SHA-256 (与 Tauri 无关, 便于单测)
pub fn sha256_file(path: &Path) -> Result<String, String> {
  let mut file = std::fs::File::open(path).map_err(|e| format!("file: {e}"))?;
  let mut hasher = Sha256::new();
  let mut buf = vec![0u8; 1024 * 1024];
  loop {
    let n = file.read(&mut buf).map_err(|e| format!("file: {e}"))?;
    if n == 0 {
      break;
    }
    hasher.update(&buf[..n]);
  }
  Ok(hex(&hasher.finalize()))
}

/// GET `spec.url` 写到 `dest`. 非 2xx 不建文件, 返回状态码; 中途出错删除半截文件 (与 Tauri 无关, 便于单测)
pub async fn download_to(spec: &UploadSpec, dest: &Path, stall: Duration) -> Result<DownloadResult, String> {
  let client = build_client(spec, DOWNLOAD_TIMEOUT)?;
  let mut req = client.get(&spec.url);
  for (name, value) in &spec.headers {
    req = req.header(name.as_str(), value.as_str());
  }
  let mut res = req.send().await.map_err(map_err)?;
  let status = res.status().as_u16();
  if !res.status().is_success() {
    return Ok(DownloadResult { status, sha256: String::new(), size: 0 });
  }
  let result = async {
    let mut file = std::fs::File::create(dest).map_err(|e| format!("file: {e}"))?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    loop {
      let chunk = tokio::time::timeout(stall, res.chunk())
        .await
        .map_err(|_| "timeout: 下载卡住".to_string())?
        .map_err(map_err)?;
      let Some(chunk) = chunk else { break };
      file.write_all(&chunk).map_err(|e| format!("file: {e}"))?;
      hasher.update(&chunk);
      size += chunk.len() as u64;
    }
    file.flush().map_err(|e| format!("file: {e}"))?;
    Ok::<_, String>(DownloadResult { status, sha256: hex(&hasher.finalize()), size })
  }
  .await;
  if result.is_err() {
    let _ = std::fs::remove_file(dest);
  }
  result
}

/// 在 `offset` 处写入一块: 0 表示新建 (清空旧内容), 否则必须正好接在已写内容之后,
/// 防止重试或乱序把文件拼错 (与 Tauri 无关, 便于单测). 返回写完后的文件长度.
pub fn write_chunk(path: &Path, offset: u64, bytes: &[u8]) -> Result<u64, String> {
  let mut file = if offset == 0 {
    std::fs::File::create(path)
  } else {
    std::fs::OpenOptions::new().write(true).open(path)
  }
  .map_err(|e| format!("file: {e}"))?;
  let len = file.seek(SeekFrom::End(0)).map_err(|e| format!("file: {e}"))?;
  if len != offset {
    return Err(format!("file: 写入位置不连续 (已有 {len} 字节, 请求写在 {offset})"));
  }
  file.write_all(bytes).map_err(|e| format!("file: {e}"))?;
  Ok(offset + bytes.len() as u64)
}

fn library_path(app: &tauri::AppHandle, root: String, rel: String) -> Result<std::path::PathBuf, String> {
  resolve_library_file(app.path().app_data_dir().ok(), &FileRef { root, rel })
}

#[tauri::command]
pub async fn library_file_sha256(app: tauri::AppHandle, root: String, rel: String) -> Result<String, String> {
  let path = library_path(&app, root, rel)?;
  tauri::async_runtime::spawn_blocking(move || sha256_file(&path))
    .await
    .map_err(|e| format!("file: {e}"))?
}

#[tauri::command]
pub async fn library_file_download(
  app: tauri::AppHandle,
  url: String,
  headers: BTreeMap<String, String>,
  proxy: Option<String>,
  root: String,
  rel: String,
) -> Result<DownloadResult, String> {
  let dest = library_path(&app, root, rel)?;
  let spec = UploadSpec {
    url,
    method: "GET".into(),
    headers: headers.into_iter().collect(),
    proxy,
    no_redirect: false,
  };
  download_to(&spec, &dest, STALL_TIMEOUT).await
}

#[tauri::command]
pub fn library_file_rename(app: tauri::AppHandle, root: String, from: String, to: String) -> Result<(), String> {
  let from = library_path(&app, root.clone(), from)?;
  let to = library_path(&app, root, to)?;
  std::fs::rename(&from, &to).map_err(|e| format!("file: {e}"))
}

#[tauri::command]
pub fn library_file_remove(app: tauri::AppHandle, root: String, rel: String) -> Result<(), String> {
  let path = library_path(&app, root, rel)?;
  match std::fs::remove_file(&path) {
    Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("file: {e}")),
    _ => Ok(()),
  }
}

#[tauri::command]
pub async fn library_file_write_chunk(
  app: tauri::AppHandle,
  root: String,
  rel: String,
  offset: u64,
  data: String,
) -> Result<u64, String> {
  use base64::Engine as _;
  let path = library_path(&app, root, rel)?;
  tauri::async_runtime::spawn_blocking(move || {
    let bytes = base64::engine::general_purpose::STANDARD
      .decode(data.as_bytes())
      .map_err(|e| format!("request: base64 无效: {e}"))?;
    write_chunk(&path, offset, &bytes)
  })
  .await
  .map_err(|e| format!("file: {e}"))?
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::net::TcpListener;

  /// 收一个请求, 回 `status` + `body`; `stall_after` 字节后停住不发
  fn serve_once(status: &'static str, body: Vec<u8>, stall_after: Option<usize>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
      let (mut stream, _) = listener.accept().unwrap();
      let mut buf = [0u8; 4096];
      let _ = stream.read(&mut buf);
      let head = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
      stream.write_all(head.as_bytes()).unwrap();
      let end = stall_after.unwrap_or(body.len());
      stream.write_all(&body[..end]).unwrap();
      stream.flush().unwrap();
      if stall_after.is_some() {
        std::thread::sleep(Duration::from_secs(3));
      }
    });
    format!("http://{addr}/f")
  }

  fn spec(url: String) -> UploadSpec {
    UploadSpec { url, method: "GET".into(), headers: vec![], proxy: None, no_redirect: false }
  }

  fn temp(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("lr-libfile-{}-{name}", std::process::id()))
  }

  #[test]
  fn hashes_files_in_chunks() {
    let path = temp("hash");
    // 跨过 1 MB 缓冲区边界
    let data: Vec<u8> = (0..(3 * 1024 * 1024 + 17)).map(|i| (i % 251) as u8).collect();
    std::fs::write(&path, &data).unwrap();
    assert_eq!(sha256_file(&path).unwrap(), hex(&Sha256::digest(&data)));
    std::fs::remove_file(&path).unwrap();
    assert!(sha256_file(&path).unwrap_err().starts_with("file:"));
  }

  #[tokio::test]
  async fn downloads_to_file_and_hashes() {
    let body: Vec<u8> = (0..200_000).map(|i| (i % 7) as u8).collect();
    let dest = temp("dl");
    let res = download_to(&spec(serve_once("200 OK", body.clone(), None)), &dest, STALL_TIMEOUT).await.unwrap();
    assert_eq!(res, DownloadResult { status: 200, sha256: hex(&Sha256::digest(&body)), size: body.len() as u64 });
    assert_eq!(std::fs::read(&dest).unwrap(), body);
    std::fs::remove_file(&dest).unwrap();
  }

  #[tokio::test]
  async fn missing_file_reports_status_without_creating() {
    let dest = temp("404");
    let res = download_to(&spec(serve_once("404 Not Found", b"no".to_vec(), None)), &dest, STALL_TIMEOUT).await.unwrap();
    assert_eq!(res.status, 404);
    assert!(res.sha256.is_empty());
    assert!(!dest.exists());
  }

  #[tokio::test]
  async fn stalled_download_removes_partial_file() {
    let dest = temp("stall");
    let url = serve_once("200 OK", vec![1u8; 10_000], Some(100));
    let err = download_to(&spec(url), &dest, Duration::from_millis(300)).await.unwrap_err();
    assert!(err.starts_with("timeout:"), "{err}");
    assert!(!dest.exists());
  }

  #[test]
  fn writes_chunks_in_order_and_rejects_gaps() {
    let path = temp("chunks");
    std::fs::write(&path, b"stale content").unwrap();
    assert_eq!(write_chunk(&path, 0, b"abc").unwrap(), 3);
    assert_eq!(write_chunk(&path, 3, b"defg").unwrap(), 7);
    // 重试已写过的块 / 跳过一块都拒绝, 文件保持原样
    assert!(write_chunk(&path, 3, b"defg").unwrap_err().starts_with("file:"));
    assert!(write_chunk(&path, 9, b"x").unwrap_err().starts_with("file:"));
    assert_eq!(std::fs::read(&path).unwrap(), b"abcdefg");
    // 非 0 偏移不会凭空建文件
    let missing = temp("chunks-missing");
    let _ = std::fs::remove_file(&missing);
    assert!(write_chunk(&missing, 5, b"x").is_err());
    assert!(!missing.exists());
    let _ = std::fs::remove_file(&path);
  }
}
