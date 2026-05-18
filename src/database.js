const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { CACHE_DIR } = require("./cache");
const { registerCleanup } = require("./shutdown");

const DATABASE_FILE = "vector.db";
const openDatabases = new Set();

function closeOpenDatabases() {
  for (const db of Array.from(openDatabases)) {
    try {
      db.close();
    } catch {
      openDatabases.delete(db);
    }
  }
}

registerCleanup(closeOpenDatabases);

function getDatabasePath(root) {
  return path.join(root, CACHE_DIR, DATABASE_FILE);
}

function databaseExists(root) {
  return fs.existsSync(getDatabasePath(root));
}

function openDatabase(root) {
  const databasePath = getDatabasePath(root);

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const db = new Database(databasePath);
  const originalClose = db.close.bind(db);
  let closed = false;

  db.close = () => {
    if (closed) {
      return undefined;
    }

    closed = true;
    openDatabases.delete(db);
    return originalClose();
  };

  openDatabases.add(db);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      file_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      startLine INTEGER NOT NULL,
      endLine INTEGER NOT NULL,
      code TEXT NOT NULL,
      embedding BLOB NOT NULL,
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id);
  `);

  return db;
}

function upsertFile(statements, file) {
  const existing = statements.selectFile.get(file.path);

  if (existing) {
    statements.updateFile.run(file.hash, existing.id);
    return existing.id;
  }

  const result = statements.insertFile.run(file.path, file.hash);
  return Number(result.lastInsertRowid);
}

function writeEmbeddingResults(root, filesByRelativePath, embeddingSummary, removedPaths = []) {
  const db = openDatabase(root);

  try {
    const statements = {
      selectFile: db.prepare("SELECT id FROM files WHERE path = ?"),
      insertFile: db.prepare("INSERT INTO files (path, hash) VALUES (?, ?)"),
      updateFile: db.prepare("UPDATE files SET hash = ? WHERE id = ?"),
      deleteFile: db.prepare("DELETE FROM files WHERE path = ?"),
      deleteChunks: db.prepare("DELETE FROM chunks WHERE file_id = ?"),
      insertChunk: db.prepare(`
        INSERT INTO chunks (
          file_id,
          name,
          type,
          startLine,
          endLine,
          code,
          embedding
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
    };
    const persist = db.transaction((fileResults, deletedPaths) => {
      for (const removedPath of deletedPaths) {
        statements.deleteFile.run(removedPath);
      }

      for (const fileResult of fileResults) {
        if (!fileResult.ok) {
          continue;
        }

        const file = filesByRelativePath[fileResult.relativePath];

        if (!file) {
          continue;
        }

        const fileId = upsertFile(statements, {
          path: fileResult.relativePath,
          hash: file.hash,
        });

        statements.deleteChunks.run(fileId);

        for (const chunk of fileResult.chunks) {
          statements.insertChunk.run(
            fileId,
            chunk.name,
            chunk.type,
            chunk.startLine,
            chunk.endLine,
            chunk.code,
            Buffer.from(chunk.embedding.buffer),
          );
        }
      }
    });

    persist(embeddingSummary.files, removedPaths);

    return {
      databasePath: getDatabasePath(root),
      filesRemoved: removedPaths.length,
      filesWritten: embeddingSummary.files.filter((fileResult) => fileResult.ok).length,
      chunksWritten: embeddingSummary.files.reduce(
        (total, fileResult) => total + (fileResult.ok ? fileResult.chunks.length : 0),
        0,
      ),
    };
  } finally {
    db.close();
  }
}

module.exports = {
  DATABASE_FILE,
  closeOpenDatabases,
  databaseExists,
  getDatabasePath,
  openDatabase,
  writeEmbeddingResults,
};
