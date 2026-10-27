use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

use crate::util::is_hash;

/// Content-addressed, zstd-compressed files under `<dataDir>/blobs/<h[0..2]>/<h[2..4]>/<h>.zst`.
#[derive(Clone, Debug)]
pub struct BlobStore {
    root: PathBuf,
}

impl BlobStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn path(&self, hash: &str) -> PathBuf {
        self.root.join(&hash[..2]).join(&hash[2..4]).join(format!("{hash}.zst"))
    }

    /// Writes the blob unless its file exists and returns the stored (compressed) size.
    pub fn put(&self, hash: &str, data: &[u8]) -> Result<u64> {
        if !is_hash(hash) {
            bail!("invalid blob hash {hash:?}");
        }
        let path = self.path(hash);
        if let Ok(meta) = std::fs::metadata(&path) {
            return Ok(meta.len());
        }
        let dir = path.parent().expect("blob path has a parent");
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        let compressed = zstd::bulk::compress(data, 3)?;
        let tmp = dir.join(format!(".{hash}.{}.tmp", hex::encode(crate::util::random_bytes::<6>())));
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(&compressed)?;
        file.sync_data()?;
        drop(file);
        std::fs::rename(&tmp, &path).inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })?;
        Ok(compressed.len() as u64)
    }

    pub fn get(&self, hash: &str) -> Result<Vec<u8>> {
        if !is_hash(hash) {
            bail!("invalid blob hash {hash:?}");
        }
        let path = self.path(hash);
        let file = std::fs::File::open(&path).with_context(|| format!("opening blob {}", path.display()))?;
        Ok(zstd::stream::decode_all(file)?)
    }

    /// The blob's data if it decompresses to at most `max` bytes, decompressing no more than `max + 1` bytes.
    pub fn get_bounded(&self, hash: &str, max: u64) -> Result<Option<Vec<u8>>> {
        use std::io::Read;
        if !is_hash(hash) {
            bail!("invalid blob hash {hash:?}");
        }
        let path = self.path(hash);
        let file = std::fs::File::open(&path).with_context(|| format!("opening blob {}", path.display()))?;
        let mut data = Vec::new();
        zstd::stream::read::Decoder::new(file)?.take(max + 1).read_to_end(&mut data)?;
        Ok((data.len() as u64 <= max).then_some(data))
    }

    pub fn get_string(&self, hash: &str) -> Result<String> {
        Ok(String::from_utf8(self.get(hash)?)?)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}
