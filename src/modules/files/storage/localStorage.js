const fs = require('fs/promises');
const path = require('path');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../../../uploads');

async function ensureDir() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

async function save(buffer, key) {
  await ensureDir();
  const filePath = path.join(UPLOAD_DIR, key);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);
}

async function read(key) {
  const filePath = path.join(UPLOAD_DIR, key);
  return fs.readFile(filePath);
}

async function del(key) {
  const filePath = path.join(UPLOAD_DIR, key);
  await fs.unlink(filePath).catch(() => {}); // silencieux si déjà absent
}

module.exports = { save, read, delete: del };
