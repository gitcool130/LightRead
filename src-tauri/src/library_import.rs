//! Native discovery and staging for desktop file/folder imports.
//! Only paths allowed by the file picker/drop scope may be read. Traversal never follows symlinks.
use crate::http_upload::{resolve_library_file, FileRef};
use serde::Serialize;
use std::{
  collections::HashSet,
  fs,
  path::{Path, PathBuf},
  time::UNIX_EPOCH,
};
use tauri::Manager;
use tauri_plugin_fs::FsExt;

const MAX_FILES: usize = 5000;
const MAX_DEPTH: usize = 8;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportEntry {
  path: String,
  name: String,
  size: u64,
  abs_path: String,
  last_modified: Option<u64>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportScan {
  name: String,
  entries: Vec<ImportEntry>,
  truncated: bool,
  has_directories: bool,
  depth_limited: bool,
  errors: Vec<String>,
}

fn ignored_dir(name: &str) -> bool {
  name.starts_with('.')
    || matches!(
      name.to_lowercase().as_str(),
      "__macosx" | "$recycle.bin" | "system volume information" | "@eadir"
    )
}

struct Scanner {
  result: ImportScan,
  seen: HashSet<PathBuf>,
  max_files: usize,
  max_depth: usize,
}
impl Scanner {
  fn visit(&mut self, path: &Path, relative: &Path, depth: usize) {
    if self.result.truncated {
      return;
    }
    if let Err(e) = self.visit_inner(path, relative, depth) {
      self.result.errors.push(format!("{}: {e}", path.display()));
    }
  }

  fn visit_inner(&mut self, path: &Path, relative: &Path, depth: usize) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if meta.is_symlink() {
      return Ok(());
    }
    let canonical = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !self.seen.insert(canonical) {
      return Ok(());
    }
    if meta.is_dir() {
      if depth > self.max_depth {
        self.result.depth_limited = true;
        return Ok(());
      }
      for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        if self.result.truncated {
          break;
        }
        let entry = match entry {
          Ok(entry) => entry,
          Err(e) => {
            self.result.errors.push(format!("{}: {e}", path.display()));
            continue;
          }
        };
        let name = entry.file_name();
        let child = entry.path();
        if entry.file_type().map_err(|e| e.to_string())?.is_dir()
          && ignored_dir(&name.to_string_lossy())
        {
          continue;
        }
        self.visit(&child, &relative.join(name), depth + 1);
      }
    } else if meta.is_file() {
      if self.result.entries.len() >= self.max_files {
        self.result.truncated = true;
        return Ok(());
      }
      self.result.entries.push(ImportEntry {
        path: relative.to_string_lossy().replace('\\', "/"),
        name: path
          .file_name()
          .unwrap_or_default()
          .to_string_lossy()
          .into_owned(),
        abs_path: path.to_string_lossy().into_owned(),
        size: meta.len(),
        last_modified: meta
          .modified()
          .ok()
          .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
          .map(|t| t.as_millis() as u64),
      });
    }
    Ok(())
  }
}

fn scan_paths(paths: Vec<PathBuf>, max_files: usize, max_depth: usize) -> ImportScan {
  let mut scanner = Scanner {
    result: ImportScan::default(),
    seen: HashSet::new(),
    max_files,
    max_depth,
  };
  if paths.len() == 1 {
    scanner.result.name = paths[0]
      .file_name()
      .unwrap_or_default()
      .to_string_lossy()
      .into_owned();
  }
  let single = paths.len() == 1;
  for path in paths {
    if !path.is_absolute() {
      scanner
        .result
        .errors
        .push(format!("{}: absolute path required", path.display()));
      continue;
    }
    let directory = fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir());
    scanner.result.has_directories |= directory;
    let relative = if single && directory {
      PathBuf::new()
    } else {
      PathBuf::from(path.file_name().unwrap_or_default())
    };
    scanner.visit(&path, &relative, 1);
  }
  scanner.result.entries.sort_by(|a, b| a.path.cmp(&b.path));
  scanner.result
}

#[tauri::command]
pub async fn library_import_scan(
  app: tauri::AppHandle,
  paths: Vec<String>,
) -> Result<ImportScan, String> {
  let scope = app.fs_scope();
  let mut allowed = Vec::new();
  let mut errors = Vec::new();
  for path in paths {
    if scope.is_allowed(&path) {
      allowed.push(PathBuf::from(path));
    } else {
      errors.push(format!("{path}: access denied"));
    }
  }
  tauri::async_runtime::spawn_blocking(move || {
    let mut scan = scan_paths(allowed, MAX_FILES, MAX_DEPTH);
    scan.errors.extend(errors);
    scan
  })
  .await
  .map_err(|e| e.to_string())
}

/// create_new prevents accidental overwrite; failures remove only this operation's partial copy.
fn copy_to_stage(source: &Path, dest: &Path) -> Result<u64, String> {
  let meta = fs::symlink_metadata(source).map_err(|e| e.to_string())?;
  if !meta.is_file() {
    return Err("source is not a regular file".into());
  }
  let mut input = fs::File::open(source).map_err(|e| e.to_string())?;
  let mut output = fs::OpenOptions::new()
    .write(true)
    .create_new(true)
    .open(dest)
    .map_err(|e| e.to_string())?;
  let result = std::io::copy(&mut input, &mut output).and_then(|size| {
    output.sync_all()?;
    Ok(size)
  });
  drop(output);
  if result.is_err() {
    let _ = fs::remove_file(dest);
  }
  result.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn library_import_copy(
  app: tauri::AppHandle,
  path: String,
  root: String,
  rel: String,
) -> Result<u64, String> {
  if !app.fs_scope().is_allowed(&path) {
    return Err(format!("{path}: access denied"));
  }
  if !rel.starts_with("books/") || !rel.ends_with(".part") {
    return Err("invalid staging path".into());
  }
  let dest = resolve_library_file(app.path().app_data_dir().ok(), &FileRef { root, rel })?;
  tauri::async_runtime::spawn_blocking(move || copy_to_stage(Path::new(&path), &dest))
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
  use super::*;
  struct Temp(PathBuf);
  impl Temp {
    fn new() -> Self {
      let path = std::env::temp_dir().join(format!("lr-import-{}", uuid::Uuid::new_v4()));
      fs::create_dir_all(&path).unwrap();
      Self(path)
    }
    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
      let path = self.0.join(name);
      fs::create_dir_all(path.parent().unwrap()).unwrap();
      fs::write(&path, bytes).unwrap();
      path
    }
  }
  impl Drop for Temp {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.0);
    }
  }

  #[test]
  fn scans_single_batch_nested_and_overlapping_roots() {
    let t = Temp::new();
    let a = t.file("中文 空格.txt", b"hello");
    t.file("nested/book.fb2.zip", b"zip");
    t.file(".hidden/skip.epub", b"skip");
    t.file("__MACOSX/skip.epub", b"skip");
    let one = scan_paths(vec![a.clone()], MAX_FILES, MAX_DEPTH);
    assert_eq!(one.entries.len(), 1);
    assert!(!one.has_directories);
    assert_eq!(one.entries[0].size, 5);
    let batch = scan_paths(vec![a.clone(), t.0.clone(), a], MAX_FILES, MAX_DEPTH);
    assert_eq!(batch.entries.len(), 2);
    assert!(batch.has_directories);
    assert!(batch.errors.is_empty());
    let folder = scan_paths(vec![t.0.clone()], MAX_FILES, MAX_DEPTH);
    assert!(folder
      .entries
      .iter()
      .any(|e| e.path == "nested/book.fb2.zip"));
  }

  #[test]
  fn reports_errors_and_limits_without_losing_valid_files() {
    let t = Temp::new();
    let a = t.file("a.txt", b"a");
    let b = t.file("b.txt", b"b");
    let partial = scan_paths(vec![t.0.join("missing"), a.clone()], MAX_FILES, MAX_DEPTH);
    assert_eq!(partial.errors.len(), 1);
    assert_eq!(partial.entries.len(), 1);
    let exact = scan_paths(vec![a.clone()], 1, MAX_DEPTH);
    assert!(!exact.truncated);
    let limited = scan_paths(vec![a, b], 1, MAX_DEPTH);
    assert!(limited.truncated);
    assert_eq!(limited.entries.len(), 1);
    t.file("deep/sub/book.txt", b"book");
    assert!(scan_paths(vec![t.0.clone()], MAX_FILES, 1).depth_limited);
  }

  #[test]
  fn stages_exact_bytes_without_overwrite_or_source_changes() {
    let t = Temp::new();
    let bytes = vec![42; 3 * 1024 * 1024 + 17];
    let source = t.file("large.txt", &bytes);
    let dest = t.0.join("book.part");
    assert_eq!(copy_to_stage(&source, &dest).unwrap(), bytes.len() as u64);
    assert_eq!(fs::read(&dest).unwrap(), bytes);
    assert!(copy_to_stage(&source, &dest).is_err());
    assert_eq!(fs::read(&source).unwrap(), bytes);
    assert!(copy_to_stage(&t.0, &t.0.join("bad.part")).is_err());
    assert!(!t.0.join("bad.part").exists());
  }

  #[cfg(unix)]
  #[test]
  fn skips_symbolic_links_and_cycles() {
    let t = Temp::new();
    let source = t.file("book.txt", b"book");
    std::os::unix::fs::symlink(&t.0, t.0.join("cycle")).unwrap();
    std::os::unix::fs::symlink(&source, t.0.join("alias.txt")).unwrap();
    let scan = scan_paths(vec![t.0.clone()], MAX_FILES, MAX_DEPTH);
    assert_eq!(scan.entries.len(), 1);
    assert!(!scan.truncated);
    assert!(copy_to_stage(&t.0.join("alias.txt"), &t.0.join("bad.part")).is_err());
  }
}
