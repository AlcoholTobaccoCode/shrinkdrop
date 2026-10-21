use crate::compression::MAX_IMAGE_BYTES;
use crate::file_ops::{FileState, OriginalSnapshot, SaveFailure, TempRecord};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions, Permissions};
use std::io::{Read, Write};
use std::path::PathBuf;

//#region 原图绑定与覆盖确认
pub fn fingerprint(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

pub struct OriginalTarget {
    pub path: PathBuf,
}

#[derive(Default, Serialize)]
pub struct BatchOverwriteResult {
    pub overwritten: usize,
    pub failed: Vec<SaveFailure>,
    pub canceled: bool,
}

pub fn overwrite_results(
    state: &FileState,
    ids: &[String],
    confirm: impl FnOnce(&[OriginalTarget]) -> bool,
) -> Result<BatchOverwriteResult, String> {
    // 单张与批量共用门锁，避免重复点击或直接 IPC 调用叠加确认和覆盖操作。
    let _operation = state
        .overwrite_gate
        .lock()
        .map_err(|_| "覆盖失败，请重试".to_string())?;
    let mut result = BatchOverwriteResult::default();
    let mut seen = HashSet::new();
    let mut records = Vec::new();
    {
        let temps = state
            .temps
            .lock()
            .map_err(|_| "文件状态不可用".to_string())?;
        for id in ids.iter().filter(|id| seen.insert((*id).clone())) {
            let record = temps.get(id).cloned();
            if let Some(record) = record.filter(|record| record.original.is_some()) {
                records.push((id.clone(), record));
            } else {
                result.failed.push(SaveFailure {
                    id: id.clone(),
                    name: "图片".into(),
                    message: "此结果无法关联原图，请重新导入并压缩".into(),
                });
            }
        }
    }
    if records.is_empty() {
        return Ok(result);
    }
    let targets = records
        .iter()
        .map(|(_, record)| OriginalTarget {
            path: record.original.as_ref().unwrap().path.clone(),
        })
        .collect::<Vec<_>>();
    if !confirm(&targets) {
        result.canceled = true;
        return Ok(result);
    }
    for (id, record) in records {
        let name = record
            .original
            .as_ref()
            .unwrap()
            .path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        match replace_original(state, &record, |input, output| {
            std::io::copy(input, output).map(|_| ())
        }) {
            Ok(()) => result.overwritten += 1,
            Err(message) => result.failed.push(SaveFailure { id, name, message }),
        }
    }
    Ok(result)
}
//#endregion

//#region 同目录暂存与安全替换
fn read_bounded(file: &File) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取原图，请检查文件权限".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("原图已被修改，请重新导入并压缩后再覆盖".into());
    }
    Ok(bytes)
}

fn check_original(snapshot: &OriginalSnapshot) -> Result<Permissions, String> {
    let metadata = fs::symlink_metadata(&snapshot.path)
        .map_err(|_| "原图已不存在或位置改变，请重新导入".to_string())?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || fs::canonicalize(&snapshot.path).ok().as_ref() != Some(&snapshot.path)
    {
        return Err("原图已不存在或位置改变，请重新导入".into());
    }
    let input =
        File::open(&snapshot.path).map_err(|_| "无法读取原图，请检查文件权限".to_string())?;
    if fingerprint(&read_bounded(&input)?) != snapshot.digest {
        return Err("原图已被修改，请重新导入并压缩后再覆盖".into());
    }
    if metadata.permissions().readonly() {
        return Err("原图为只读文件，请修改权限后重试".into());
    }
    Ok(metadata.permissions())
}

struct ScratchFile(PathBuf);
impl Drop for ScratchFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn replace_original(
    state: &FileState,
    record: &TempRecord,
    copy: impl FnOnce(&mut File, &mut File) -> std::io::Result<()>,
) -> Result<(), String> {
    let snapshot = record
        .original
        .as_ref()
        .ok_or_else(|| "此结果无法关联原图，请重新导入并压缩".to_string())?;
    let permissions = check_original(snapshot)?;
    let mut input =
        File::open(&record.path).map_err(|_| "压缩结果无法读取，请重新处理".to_string())?;
    let result_bytes =
        read_bounded(&input).map_err(|_| "压缩结果无法读取，请重新处理".to_string())?;
    if result_bytes.len() as u64 != record.metadata.size
        || fingerprint(&result_bytes) != snapshot.result_digest
    {
        return Err("压缩结果无法读取，请重新处理".into());
    }
    // 校验使用独立句柄，复制从文件开头开始；原始文件始终不以写入方式打开。
    use std::io::{Seek, SeekFrom};
    input
        .seek(SeekFrom::Start(0))
        .map_err(|_| "压缩结果无法读取，请重新处理".to_string())?;
    let directory = snapshot
        .path
        .parent()
        .ok_or_else(|| "原图已不存在或位置改变，请重新导入".to_string())?;
    let scratch_path = directory.join(format!(
        ".tinypng-overwrite-{}-{}.tmp",
        std::process::id(),
        state.new_id("replace")
    ));
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&scratch_path)
        .map_err(|_| "覆盖失败，原图未修改，请检查目录权限或可用空间".to_string())?;
    let scratch = ScratchFile(scratch_path);
    let write_result = copy(&mut input, &mut output)
        .and_then(|_| output.flush())
        .and_then(|_| output.sync_all())
        .map_err(|_| "覆盖失败，原图未修改，请检查目录权限或可用空间".to_string());
    // Windows 无法删除仍在写入的文件；先关闭句柄，再传播错误并清理暂存文件。
    drop(output);
    write_result?;
    let written = File::open(&scratch.0)
        .map_err(|_| "覆盖失败，原图未修改，请检查目录权限或可用空间".to_string())?;
    if fingerprint(&read_bounded(&written)?) != snapshot.result_digest {
        return Err("压缩结果无法读取，请重新处理".into());
    }
    drop(written);
    fs::set_permissions(&scratch.0, permissions)
        .map_err(|_| "覆盖失败，原图未修改，请检查目录权限或可用空间".to_string())?;
    // 暂存期间原图可能被其他程序编辑；替换前再次校验，失败只清理暂存文件。
    check_original(snapshot)?;
    fs::rename(&scratch.0, &snapshot.path)
        .map_err(|_| "覆盖失败，原图未修改，请关闭占用图片的程序后重试".to_string())?;
    Ok(())
}
//#endregion

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_ops::{self, FileState};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Fixture {
        directory: PathBuf,
        state: FileState,
        id: String,
        source: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            static SERIAL: AtomicUsize = AtomicUsize::new(0);
            let directory = std::env::temp_dir().join(format!(
                "tinypng-overwrite-test-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                SERIAL.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&directory).unwrap();
            let source = directory.join("original.png");
            fs::write(&source, b"original-image").unwrap();
            let state = FileState::default();
            let descriptor = file_ops::collect_files(&state, &source, false)
                .unwrap()
                .remove(0);
            let record = file_ops::source_record(&state, &descriptor.id).unwrap();
            let result = file_ops::write_result(
                &state,
                &directory.join("results"),
                "session-1-1",
                &record,
                b"compressed-image",
                "image/png",
                fingerprint(b"original-image"),
            )
            .unwrap()
            .register(&state)
            .unwrap();
            Self {
                directory,
                state,
                id: result.id,
                source,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    #[test]
    fn every_overwrite_requires_confirmation_and_cancel_preserves_original() {
        let fixture = Fixture::new();
        let dialogs = AtomicUsize::new(0);
        for _ in 0..2 {
            let result = overwrite_results(&fixture.state, &[fixture.id.clone()], |targets| {
                dialogs.fetch_add(1, Ordering::Relaxed);
                assert_eq!(targets.len(), 1);
                assert_eq!(targets[0].path, fs::canonicalize(&fixture.source).unwrap());
                false
            })
            .unwrap();
            assert!(result.canceled);
            assert_eq!(result.overwritten, 0);
            assert_eq!(fs::read(&fixture.source).unwrap(), b"original-image");
        }
        assert_eq!(dialogs.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn confirmed_overwrite_replaces_only_its_bound_original_and_keeps_result() {
        let fixture = Fixture::new();
        let other = fixture.directory.join("other.png");
        fs::write(&other, b"keep-other-image").unwrap();
        let result = overwrite_results(&fixture.state, &[fixture.id.clone()], |_| true).unwrap();
        assert_eq!(result.overwritten, 1);
        assert!(result.failed.is_empty());
        assert_eq!(fs::read(&fixture.source).unwrap(), b"compressed-image");
        assert_eq!(fs::read(other).unwrap(), b"keep-other-image");
        let record = fixture.state.temps.lock().unwrap()[&fixture.id].clone();
        assert_eq!(fs::read(record.path).unwrap(), b"compressed-image");
        assert_eq!(fs::read_dir(&fixture.directory).unwrap().count(), 3);
    }

    #[test]
    fn edited_missing_and_symlinked_originals_are_never_replaced() {
        let fixture = Fixture::new();
        fs::write(&fixture.source, b"edited-image").unwrap();
        let result = overwrite_results(&fixture.state, &[fixture.id.clone()], |_| true).unwrap();
        assert_eq!(result.overwritten, 0);
        assert!(result.failed[0].message.contains("原图已被修改"));
        assert_eq!(fs::read(&fixture.source).unwrap(), b"edited-image");
        fs::remove_file(&fixture.source).unwrap();
        let result = overwrite_results(&fixture.state, &[fixture.id.clone()], |_| true).unwrap();
        assert_eq!(result.overwritten, 0);
        assert!(!fixture.source.exists());
        #[cfg(unix)]
        {
            let other = fixture.directory.join("other.png");
            fs::write(&other, b"original-image").unwrap();
            std::os::unix::fs::symlink(&other, &fixture.source).unwrap();
            let result =
                overwrite_results(&fixture.state, &[fixture.id.clone()], |_| true).unwrap();
            assert_eq!(result.overwritten, 0);
            assert_eq!(fs::read(other).unwrap(), b"original-image");
            assert!(fs::symlink_metadata(&fixture.source)
                .unwrap()
                .file_type()
                .is_symlink());
        }
    }

    #[test]
    fn one_batch_confirmation_reports_partial_failures_and_deduplicates_ids() {
        let first = Fixture::new();
        let second = Fixture::new();
        let record = second.state.temps.lock().unwrap()[&second.id].clone();
        first
            .state
            .temps
            .lock()
            .unwrap()
            .insert("second-result".into(), record);
        fs::write(&second.source, b"edited-image").unwrap();
        let dialogs = AtomicUsize::new(0);
        let result = overwrite_results(
            &first.state,
            &[first.id.clone(), first.id.clone(), "second-result".into()],
            |targets| {
                dialogs.fetch_add(1, Ordering::Relaxed);
                assert_eq!(targets.len(), 2);
                true
            },
        )
        .unwrap();
        assert_eq!(dialogs.load(Ordering::Relaxed), 1);
        assert_eq!(result.overwritten, 1);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].id, "second-result");
        assert_eq!(fs::read(&second.source).unwrap(), b"edited-image");
    }

    #[test]
    fn interrupted_write_keeps_original_and_cleans_the_scratch_file() {
        use std::io::Write;
        let fixture = Fixture::new();
        let record = fixture.state.temps.lock().unwrap()[&fixture.id].clone();
        let result = replace_original(&fixture.state, &record, |_, output| {
            output.write_all(b"partial")?;
            Err(std::io::Error::other("disk full"))
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&fixture.source).unwrap(), b"original-image");
        assert_eq!(fs::read_dir(&fixture.directory).unwrap().count(), 2);
    }

    #[test]
    fn edits_during_preparation_and_tampered_results_cannot_replace_originals() {
        use std::io::Write;
        let fixture = Fixture::new();
        let record = fixture.state.temps.lock().unwrap()[&fixture.id].clone();
        let result = replace_original(&fixture.state, &record, |_, output| {
            output.write_all(b"compressed-image")?;
            fs::write(&fixture.source, b"new-edit")?;
            Ok(())
        });
        assert!(result.unwrap_err().contains("原图已被修改"));
        assert_eq!(fs::read(&fixture.source).unwrap(), b"new-edit");
        fs::write(&fixture.source, b"original-image").unwrap();
        fs::write(&record.path, b"tampered-output").unwrap();
        let result = overwrite_results(&fixture.state, &[fixture.id.clone()], |_| true).unwrap();
        assert_eq!(result.overwritten, 0);
        assert_eq!(fs::read(&fixture.source).unwrap(), b"original-image");
    }
}
