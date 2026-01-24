import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '../../data/aviation-empire.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let db = null;

async function initDatabase() {
  const SQL = await initSqlJs();
  
  // Check if database exists
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
    console.log('✅ Database loaded from file');
  } else {
    // Create new database
    db = new SQL.Database();
    
    // Execute schema
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
    db.exec(schema);
    
    // Save to file
    const data = db.export();
    fs.writeFileSync(DB_PATH, data);
    
    console.log('✅ Database created and schema initialized');
  }
  
  return db;
}

function saveDatabase() {
  if (db) {
    const data = db.export();
    fs.writeFileSync(DB_PATH, data);
  }
}

function getDatabase() {
  return db;
}

// Auto-save every 5 seconds
setInterval(saveDatabase, 5000);

export { initDatabase, saveDatabase, getDatabase };