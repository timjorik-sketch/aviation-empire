import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from './postgres.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

// Transform SQLite SQL to PostgreSQL SQL
function transformSql(sql) {
  return sql
    .replace(/\bINTEGER PRIMARY KEY AUTOINCREMENT\b/g, 'SERIAL PRIMARY KEY')
    .replace(/\bDATETIME\b/g, 'TIMESTAMPTZ')
    .replace(/\bTIMESTAMP\b(?!Z)/g, 'TIMESTAMPTZ')
    // Mark INSERT OR IGNORE / INSERT OR REPLACE for post-processing
    .replace(/INSERT OR IGNORE INTO/gi, '__INSERT_IGNORE__ INTO')
    .replace(/INSERT OR REPLACE INTO/gi, '__INSERT_REPLACE__ INTO');
}

// Split SQL text into individual statements, handling strings and multi-line values
function splitStatements(sql) {
  const stmts = [];
  let cur = '';
  let inSingle = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (!inSingle && ch === "'") {
      inSingle = true;
    } else if (inSingle && ch === "'") {
      if (sql[i + 1] === "'") { cur += ch; i++; } // escaped ''
      else inSingle = false;
    } else if (!inSingle && ch === '-' && sql[i + 1] === '-') {
      // line comment — skip to end of line
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    } else if (!inSingle && ch === ';') {
      const s = cur.trim();
      if (s) stmts.push(s);
      cur = '';
      continue;
    }
    cur += ch;
  }
  const s = cur.trim();
  if (s) stmts.push(s);
  return stmts;
}

// Run a list of SQL statements, swallowing expected "already exists" errors
async function runStatements(stmts, context = '') {
  for (const raw of stmts) {
    const stmt = raw.trim();
    if (!stmt || stmt.startsWith('--') || /^PRAGMA\b/i.test(stmt)) continue;

    let pgStmt = stmt;

    // INSERT OR IGNORE → INSERT ... ON CONFLICT
    if (pgStmt.includes('__INSERT_IGNORE__')) {
      pgStmt = pgStmt.replace('__INSERT_IGNORE__', 'INSERT');
      // For airports with full details (category/coords): upsert so detailed rows overwrite basic ones
      if (/INTO airports\s*\(/i.test(pgStmt) && /\blatitude\b/i.test(pgStmt)) {
        pgStmt += ` ON CONFLICT (iata_code) DO UPDATE SET
          name=EXCLUDED.name,
          category=EXCLUDED.category,
          continent=EXCLUDED.continent,
          runway_length_m=EXCLUDED.runway_length_m,
          latitude=EXCLUDED.latitude,
          longitude=EXCLUDED.longitude`;
      } else {
        pgStmt += ' ON CONFLICT DO NOTHING';
      }
    }
    // INSERT OR REPLACE for service_item_types → upsert
    if (pgStmt.includes('__INSERT_REPLACE__')) {
      if (/INTO service_item_types/i.test(pgStmt)) {
        pgStmt = pgStmt.replace('__INSERT_REPLACE__', 'INSERT');
        pgStmt += ` ON CONFLICT (id) DO UPDATE SET
          item_name=EXCLUDED.item_name, category=EXCLUDED.category,
          price_per_pax=EXCLUDED.price_per_pax, price_economy=EXCLUDED.price_economy,
          price_business=EXCLUDED.price_business, price_first=EXCLUDED.price_first,
          sort_order=EXCLUDED.sort_order, image_eco=EXCLUDED.image_eco,
          image_bus=EXCLUDED.image_bus, image_fir=EXCLUDED.image_fir`;
      } else {
        pgStmt = pgStmt.replace('__INSERT_REPLACE__', 'INSERT');
        pgStmt += ' ON CONFLICT DO NOTHING';
      }
    }

    try {
      await pool.query(pgStmt);
    } catch (e) {
      const msg = e.message || '';
      // Ignore "already exists" type errors — expected for idempotent init
      if (msg.includes('already exists') || msg.includes('duplicate key') || msg.includes('cannot affect row a second time')) continue;
      // Log other errors but don't crash
      console.warn(`[db init${context ? ' ' + context : ''}] ${msg.substring(0, 120)}`);
    }
  }
}

async function safeQuery(sql, params, label) {
  try {
    return await pool.query(sql, params);
  } catch (e) {
    console.warn(`[db seed${label ? ' ' + label : ''}] ${e.message.substring(0, 150)}`);
    return { rows: [] };
  }
}

async function initDatabase() {
  // Test connection
  await pool.query('SELECT 1');
  console.log('PostgreSQL connected');

  // Read and transform schema
  const rawSchema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  const pgSchema = transformSql(rawSchema);
  const schemaStmts = splitStatements(pgSchema);
  await runStatements(schemaStmts, 'schema');

  // ── Additional tables not yet in schema.sql ────────────────────────────────
  const extraTables = [
    `CREATE TABLE IF NOT EXISTS service_item_types (
      id SERIAL PRIMARY KEY,
      item_name TEXT NOT NULL,
      category TEXT NOT NULL,
      price_per_pax REAL NOT NULL DEFAULT 0,
      price_economy REAL NOT NULL DEFAULT 0,
      price_business REAL NOT NULL DEFAULT 0,
      price_first REAL NOT NULL DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      image_eco TEXT,
      image_bus TEXT,
      image_fir TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS airline_service_profiles (
      id SERIAL PRIMARY KEY,
      airline_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS service_profile_items (
      id SERIAL PRIMARY KEY,
      profile_id INTEGER NOT NULL,
      item_type_id INTEGER NOT NULL,
      cabin_class TEXT NOT NULL CHECK(cabin_class IN ('economy','business','first')),
      FOREIGN KEY (profile_id) REFERENCES airline_service_profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (item_type_id) REFERENCES service_item_types(id),
      UNIQUE(profile_id, item_type_id, cabin_class)
    )`,
    `CREATE TABLE IF NOT EXISTS airline_cabin_profiles (
      id SERIAL PRIMARY KEY,
      airline_id INTEGER NOT NULL,
      aircraft_type_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE,
      FOREIGN KEY (aircraft_type_id) REFERENCES aircraft_types(id)
    )`,
    `CREATE TABLE IF NOT EXISTS airline_cabin_classes (
      id SERIAL PRIMARY KEY,
      profile_id INTEGER NOT NULL,
      class_type TEXT NOT NULL CHECK(class_type IN ('economy','business','first')),
      seat_type TEXT NOT NULL,
      seat_ratio REAL NOT NULL DEFAULT 1.0,
      percentage REAL NOT NULL DEFAULT 0,
      actual_capacity INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (profile_id) REFERENCES airline_cabin_profiles(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS airline_destinations (
      id SERIAL PRIMARY KEY,
      airline_id INTEGER NOT NULL,
      airport_code TEXT NOT NULL,
      destination_type TEXT DEFAULT 'destination' CHECK(destination_type IN ('home_base','hub','base','destination')),
      opened_at TIMESTAMPTZ DEFAULT NOW(),
      FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE,
      FOREIGN KEY (airport_code) REFERENCES airports(iata_code),
      UNIQUE(airline_id, airport_code)
    )`,
    `CREATE TABLE IF NOT EXISTS personnel (
      id SERIAL PRIMARY KEY,
      airline_id INTEGER NOT NULL REFERENCES airlines(id) ON DELETE CASCADE,
      staff_type TEXT NOT NULL,
      airport_code TEXT,
      aircraft_id INTEGER REFERENCES aircraft(id) ON DELETE CASCADE,
      count INTEGER NOT NULL DEFAULT 0,
      weekly_wage_per_person INTEGER NOT NULL DEFAULT 0,
      type_rating TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS used_aircraft_market (
      id SERIAL PRIMARY KEY,
      aircraft_type_id INTEGER NOT NULL REFERENCES aircraft_types(id),
      registration TEXT NOT NULL UNIQUE,
      manufactured_year INTEGER NOT NULL,
      total_flight_hours REAL NOT NULL DEFAULT 0,
      current_value REAL NOT NULL,
      listed_at TIMESTAMPTZ DEFAULT NOW(),
      location TEXT,
      seller_aircraft_id INTEGER,
      seller_airline_id INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS airport_slots (
      id SERIAL PRIMARY KEY,
      airline_id INTEGER NOT NULL,
      airport_code TEXT NOT NULL,
      category INTEGER NOT NULL,
      slots_count INTEGER DEFAULT 0,
      cost_per_slot INTEGER NOT NULL,
      FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE,
      UNIQUE(airline_id, airport_code)
    )`,
    `CREATE TABLE IF NOT EXISTS slot_usage (
      id SERIAL PRIMARY KEY,
      airline_id INTEGER NOT NULL,
      airport_code TEXT NOT NULL,
      week_start DATE NOT NULL,
      departures_used INTEGER DEFAULT 0,
      FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE,
      UNIQUE(airline_id, airport_code, week_start)
    )`,
    `CREATE TABLE IF NOT EXISTS transfer_flights (
      id SERIAL PRIMARY KEY,
      aircraft_id INTEGER NOT NULL,
      airline_id INTEGER NOT NULL,
      departure_airport TEXT NOT NULL,
      arrival_airport TEXT NOT NULL,
      departure_time TIMESTAMPTZ NOT NULL,
      arrival_time TIMESTAMPTZ NOT NULL,
      cost REAL NOT NULL DEFAULT 500000,
      status TEXT DEFAULT 'scheduled',
      FOREIGN KEY (aircraft_id) REFERENCES aircraft(id) ON DELETE CASCADE,
      FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS airport_expansions (
      id SERIAL PRIMARY KEY,
      airline_id INTEGER NOT NULL,
      airport_code TEXT NOT NULL,
      expansion_level INTEGER DEFAULT 0,
      FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE,
      UNIQUE(airline_id, airport_code)
    )`,
    `CREATE TABLE IF NOT EXISTS expansion_usage (
      id SERIAL PRIMARY KEY,
      airline_id INTEGER NOT NULL,
      airport_code TEXT NOT NULL,
      week_start DATE NOT NULL,
      departures_used INTEGER DEFAULT 0,
      FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE,
      UNIQUE(airline_id, airport_code, week_start)
    )`,
    `CREATE TABLE IF NOT EXISTS market_analyses (
      id SERIAL PRIMARY KEY,
      airline_id INTEGER NOT NULL,
      route_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ NOT NULL,
      cost INTEGER NOT NULL,
      economy_price INTEGER,
      business_price INTEGER,
      first_price INTEGER,
      economy_rating TEXT,
      business_rating TEXT,
      first_rating TEXT,
      economy_market_price INTEGER,
      business_market_price INTEGER,
      first_market_price INTEGER,
      FOREIGN KEY (airline_id) REFERENCES airlines(id),
      FOREIGN KEY (route_id) REFERENCES routes(id)
    )`,
    `CREATE TABLE IF NOT EXISTS analysis_limits (
      airline_id INTEGER PRIMARY KEY,
      week_start DATE NOT NULL,
      analyses_this_week INTEGER DEFAULT 0,
      FOREIGN KEY (airline_id) REFERENCES airlines(id)
    )`,
    `CREATE TABLE IF NOT EXISTS invite_codes (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      used_at TIMESTAMPTZ,
      revoked BOOLEAN DEFAULT FALSE,
      note TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS password_resets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id)`,
    `CREATE TABLE IF NOT EXISTS email_verifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id)`,
  ];
  await runStatements(extraTables, 'extra tables');

  // ── ADD MISSING COLUMNS (idempotent — DO NOTHING if already exist) ──────────
  const alterCols = [
    // aircraft table
    `ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS is_active INTEGER DEFAULT 0`,
    `ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS delivery_at TIMESTAMPTZ`,
    `ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS airline_cabin_profile_id INTEGER REFERENCES airline_cabin_profiles(id)`,
    `ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS current_location TEXT REFERENCES airports(iata_code)`,
    `ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS crew_assigned INTEGER DEFAULT 0`,
    `ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS total_flight_hours REAL DEFAULT 0`,
    `ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS is_listed_for_sale INTEGER DEFAULT 0`,
    // aircraft_types table
    `ALTER TABLE aircraft_types ADD COLUMN IF NOT EXISTS list_price REAL`,
    `ALTER TABLE aircraft_types ADD COLUMN IF NOT EXISTS depreciation_age REAL DEFAULT 0.035`,
    `ALTER TABLE aircraft_types ADD COLUMN IF NOT EXISTS depreciation_fh REAL DEFAULT 0.000006`,
    `ALTER TABLE aircraft_types ADD COLUMN IF NOT EXISTS fuel_consumption_per_km REAL DEFAULT 0.028`,
    `ALTER TABLE aircraft_types ADD COLUMN IF NOT EXISTS display_order INTEGER DEFAULT 0`,
    // airlines table
    `ALTER TABLE airlines ADD COLUMN IF NOT EXISTS active_airline_id INTEGER REFERENCES airlines(id)`,
    `ALTER TABLE airlines ADD COLUMN IF NOT EXISTS last_payroll_at TIMESTAMPTZ`,
    `ALTER TABLE airlines ADD COLUMN IF NOT EXISTS logo_filename TEXT`,
    // users table
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS active_airline_id INTEGER REFERENCES airlines(id)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ`,
    // flights table
    `ALTER TABLE flights ADD COLUMN IF NOT EXISTS service_profile_id INTEGER`,
    `ALTER TABLE flights ADD COLUMN IF NOT EXISTS booked_economy INTEGER DEFAULT 0`,
    `ALTER TABLE flights ADD COLUMN IF NOT EXISTS booked_business INTEGER DEFAULT 0`,
    `ALTER TABLE flights ADD COLUMN IF NOT EXISTS booked_first INTEGER DEFAULT 0`,
    `ALTER TABLE flights ADD COLUMN IF NOT EXISTS economy_price REAL`,
    `ALTER TABLE flights ADD COLUMN IF NOT EXISTS business_price REAL`,
    `ALTER TABLE flights ADD COLUMN IF NOT EXISTS first_price REAL`,
    `ALTER TABLE flights ADD COLUMN IF NOT EXISTS weekly_schedule_id INTEGER REFERENCES weekly_schedule(id)`,
    `ALTER TABLE flights ADD COLUMN IF NOT EXISTS booking_revenue_collected INTEGER DEFAULT 0`,
    `ALTER TABLE flights ADD COLUMN IF NOT EXISTS fuel_cost REAL DEFAULT 0`,
    `ALTER TABLE flights ADD COLUMN IF NOT EXISTS landing_fee REAL DEFAULT 0`,
    `ALTER TABLE flights ADD COLUMN IF NOT EXISTS ground_handling_cost REAL DEFAULT 0`,
    `ALTER TABLE flights ADD COLUMN IF NOT EXISTS catering_cost REAL DEFAULT 0`,
    `ALTER TABLE flights ADD COLUMN IF NOT EXISTS market_price_economy REAL DEFAULT 0`,
    `ALTER TABLE flights ADD COLUMN IF NOT EXISTS market_price_business REAL DEFAULT 0`,
    `ALTER TABLE flights ADD COLUMN IF NOT EXISTS market_price_first REAL DEFAULT 0`,
    `ALTER TABLE flights ADD COLUMN IF NOT EXISTS satisfaction_score INTEGER`,
    `ALTER TABLE flights ADD COLUMN IF NOT EXISTS violated_rules TEXT`,
    // weekly_schedule table
    `ALTER TABLE weekly_schedule ADD COLUMN IF NOT EXISTS economy_price REAL`,
    `ALTER TABLE weekly_schedule ADD COLUMN IF NOT EXISTS business_price REAL`,
    `ALTER TABLE weekly_schedule ADD COLUMN IF NOT EXISTS first_price REAL`,
    `ALTER TABLE weekly_schedule ADD COLUMN IF NOT EXISTS route_id INTEGER REFERENCES routes(id)`,
    `ALTER TABLE weekly_schedule ADD COLUMN IF NOT EXISTS service_profile_id INTEGER REFERENCES airline_service_profiles(id)`,
    // maintenance_schedule table — drop NOT NULL on time columns (stored as HH:MM strings, incompatible with TIMESTAMPTZ)
    `ALTER TABLE maintenance_schedule ALTER COLUMN start_time DROP NOT NULL`,
    `ALTER TABLE maintenance_schedule ALTER COLUMN end_time DROP NOT NULL`,
    `ALTER TABLE maintenance_schedule ADD COLUMN IF NOT EXISTS day_of_week INTEGER`,
    `ALTER TABLE maintenance_schedule ADD COLUMN IF NOT EXISTS start_minutes INTEGER`,
    `ALTER TABLE maintenance_schedule ADD COLUMN IF NOT EXISTS duration_minutes INTEGER`,
    `ALTER TABLE maintenance_schedule ADD COLUMN IF NOT EXISTS last_completed_at TIMESTAMPTZ`,
    // routes table
    `ALTER TABLE routes ADD COLUMN IF NOT EXISTS economy_price REAL`,
    `ALTER TABLE routes ADD COLUMN IF NOT EXISTS business_price REAL`,
    `ALTER TABLE routes ADD COLUMN IF NOT EXISTS first_price REAL`,
    `ALTER TABLE routes ADD COLUMN IF NOT EXISTS service_profile_id INTEGER REFERENCES airline_service_profiles(id)`,
    // airports table
    `ALTER TABLE airports ADD COLUMN IF NOT EXISTS landing_fee_light REAL DEFAULT 500`,
    `ALTER TABLE airports ADD COLUMN IF NOT EXISTS landing_fee_medium REAL DEFAULT 1500`,
    `ALTER TABLE airports ADD COLUMN IF NOT EXISTS landing_fee_heavy REAL DEFAULT 5000`,
    `ALTER TABLE airports ADD COLUMN IF NOT EXISTS ground_handling_fee REAL DEFAULT 1000`,
    `ALTER TABLE airports ADD COLUMN IF NOT EXISTS ground_handling_fee_light REAL DEFAULT 400`,
    `ALTER TABLE airports ADD COLUMN IF NOT EXISTS ground_handling_fee_medium REAL DEFAULT 650`,
    `ALTER TABLE airports ADD COLUMN IF NOT EXISTS ground_handling_fee_heavy REAL DEFAULT 950`,
    `ALTER TABLE airports ADD COLUMN IF NOT EXISTS category INTEGER DEFAULT 4`,
    `ALTER TABLE airports ADD COLUMN IF NOT EXISTS continent TEXT`,
    `ALTER TABLE airports ADD COLUMN IF NOT EXISTS state TEXT`,
    `ALTER TABLE airports ADD COLUMN IF NOT EXISTS runway_length_m INTEGER DEFAULT 2500`,
    `ALTER TABLE airports ADD COLUMN IF NOT EXISTS latitude REAL`,
    `ALTER TABLE airports ADD COLUMN IF NOT EXISTS longitude REAL`,
    // fuel_prices table
    `ALTER TABLE fuel_prices ADD COLUMN IF NOT EXISTS price_per_liter REAL`,
    `ALTER TABLE fuel_prices ADD COLUMN IF NOT EXISTS price_per_kg REAL`,
    // used_aircraft_market
    `ALTER TABLE used_aircraft_market ADD COLUMN IF NOT EXISTS seller_type TEXT DEFAULT 'system'`,
  ];
  await runStatements(alterCols, 'alter cols');

  // ── SEED service_item_types (upsert) ─────────────────────────────────────────
  await safeQuery(`
    INSERT INTO service_item_types (id, item_name, category, price_per_pax, price_economy, price_business, price_first, sort_order, image_eco, image_bus, image_fir) VALUES
    (1,  'Water',              'Beverages',      1.50,  1.50,  2.00,  3.00,  1, 'Service_Eco_Water.png',         'Service_Bus_Water.png',         'Service_Fir_Water.png'),
    (2,  'Soda & Juice',       'Beverages',      2.50,  2.50,  3.50,  5.00,  2, 'Service_Drinks_1.png',          'Service_Drinks_1.png',          'Service_Drinks_1.png'),
    (3,  'Beer & Wine',        'Beverages',      5.00,  5.00,  7.00, 10.00,  3, 'Service_Drinks_2.png',          'Service_Drinks_2.png',          'Service_Drinks_2.png'),
    (4,  'Cocktails',          'Beverages',     10.00, 10.00, 14.00, 20.00,  4, 'Service_Drinks_3.png',          'Service_Drinks_3.png',          'Service_Drinks_3.png'),
    (5,  'Welcome Chocolate',  'Food',           1.50,  1.50,  4.00, 12.00,  5, 'Service_Eco_Welcome.png',       'Service_Bus_Welcome.png',       'Service_Fir_Welcome.png'),
    (6,  'Snack',              'Food',           3.50,  3.50,  5.00,  8.00,  6, 'Service_Eco_Snack.png',         'Service_Bus_Snack.png',         'Service_Fir_Snack.png'),
    (7,  'Meal 1 – Small Cold','Food',           8.00,  8.00, 12.00, 18.00,  7, 'Service_Eco_Meal_1.png',        'Service_Bus_Meal_1.png',        'Service_Fir_Meal_1.png'),
    (8,  'Meal 2 – Large Cold','Food',          14.00, 14.00, 20.00, 30.00,  8, 'Service_Eco_Meal_2.png',        'Service_Bus_Meal_2.png',        'Service_Fir_Meal_2.png'),
    (9,  'Meal 3 – Large Hot', 'Food',          24.00, 24.00, 35.00, 50.00,  9, 'Service_Eco_Meal_3.png',        'Service_Bus_Meal_3.png',        'Service_Fir_Meal_3.png'),
    (10, 'Entertainment',      'Entertainment',  5.00,  5.00,  5.00,  5.00, 10, 'Service_Eco_Entertainment.png', 'Service_Bus_Entertainment.png', 'Service_Fir_Entertainment.png'),
    (11, 'Amenity Kit',        'Comfort',        8.00,  8.00, 12.00, 18.00, 11, 'Service_Eco_AmenityKit.png',    'Service_Bus_AmenityKit.png',    'Service_Fir_AmenityKit.png'),
    (12, 'Sleep Kit',          'Comfort',       15.00, 15.00, 22.00, 32.00, 12, 'Service_Eco_SleepKit.png',      'Service_Bus_SleepKit.png',      'Service_Fir_SleepKit.png'),
    (13, 'Luggage 1 – Cabin',  'Luggage',        5.00,  5.00,  5.00,  5.00, 13, 'Service_Luggage_1.png',         'Service_Luggage_1.png',         'Service_Luggage_1.png'),
    (14, 'Luggage 2 – Medium', 'Luggage',       20.00, 20.00, 20.00, 20.00, 14, 'Service_Luggage_2.png',         'Service_Luggage_2.png',         'Service_Luggage_2.png'),
    (15, 'Luggage 3 – Large',  'Luggage',       35.00, 35.00, 35.00, 35.00, 15, 'Service_Luggage_3.png',         'Service_Luggage_3.png',         'Service_Luggage_3.png')
    ON CONFLICT (id) DO UPDATE SET
      item_name=EXCLUDED.item_name, category=EXCLUDED.category,
      price_per_pax=EXCLUDED.price_per_pax, price_economy=EXCLUDED.price_economy,
      price_business=EXCLUDED.price_business, price_first=EXCLUDED.price_first,
      sort_order=EXCLUDED.sort_order, image_eco=EXCLUDED.image_eco,
      image_bus=EXCLUDED.image_bus, image_fir=EXCLUDED.image_fir
  `);

  await safeQuery(`SELECT setval('service_item_types_id_seq', COALESCE((SELECT MAX(id) FROM service_item_types), 1))`, null, 'setval sit');

  // ── SEED additional aircraft types (IDs 15-64) ───────────────────────────────
  await safeQuery(`
    INSERT INTO aircraft_types (id, manufacturer, model, full_name, max_passengers, range_km, cruise_speed_kmh, min_runway_takeoff_m, min_runway_landing_m, fuel_consumption_empty_per_km, fuel_consumption_full_per_km, wake_turbulence_category, new_price_usd, required_level, required_pilots, image_filename) VALUES
    (15,'Airbus','A319 Neo','Airbus A319 Neo',160,6850,828,1860,1400,0.020,0.025,'M',101500000,8,2,'Aircraft_Airbus_319_Neo.png'),
    (16,'Airbus','A330-200','Airbus A330-200',406,13450,871,2600,1830,0.031,0.040,'H',238500000,11,2,'Aircraft_Airbus_330-200.png'),
    (17,'Airbus','A330-300','Airbus A330-300',440,11750,871,2700,1830,0.033,0.042,'H',264200000,11,2,'Aircraft_Airbus_330-300.png'),
    (18,'Airbus','A330-800 Neo','Airbus A330-800 Neo',406,15094,871,2480,1830,0.028,0.036,'H',259900000,11,2,'Aircraft_Airbus_330-800_Neo.png'),
    (19,'Airbus','A330-900 Neo','Airbus A330-900 Neo',440,13334,871,2770,1830,0.029,0.037,'H',296400000,11,2,'Aircraft_Airbus_330-900_Neo.png'),
    (20,'Airbus','A340-300','Airbus A340-300',440,13500,871,3000,2000,0.038,0.048,'H',238000000,12,2,'Aircraft_Airbus_340-300.png'),
    (21,'Airbus','A340-500','Airbus A340-500',375,16670,871,3200,2100,0.040,0.050,'H',275400000,12,2,'Aircraft_Airbus_340-500.png'),
    (22,'Airbus','A340-600','Airbus A340-600',475,14630,871,3300,2100,0.042,0.052,'H',283000000,12,2,'Aircraft_Airbus_340-600.png'),
    (23,'Airbus','A350-900','Airbus A350-900',440,15372,903,2600,1800,0.026,0.034,'H',317400000,13,2,'Aircraft_Airbus_350-900.png'),
    (24,'Airbus','A350-1000','Airbus A350-1000',480,16112,903,2900,1900,0.028,0.036,'H',366500000,14,2,'Aircraft_Airbus_350-1000.png'),
    (25,'ATR','42','ATR 42',48,1302,556,1107,1107,0.015,0.019,'M',18400000,1,2,'Aircraft_ATR_ATR-42.png'),
    (26,'ATR','72','ATR 72',72,1403,510,1333,1279,0.016,0.020,'M',26500000,1,2,'Aircraft_ATR_ATR-72.png'),
    (27,'Avro','RJ85','Avro RJ85',112,3335,764,1540,1372,0.025,0.031,'M',35000000,4,2,'Aircraft_Avro_RJ85.png'),
    (28,'Boeing','737-8 Max','Boeing 737-8 Max',210,6570,839,2100,1524,0.022,0.028,'M',121600000,9,2,'Aircraft_Boeing_737-8-Max.png'),
    (29,'Boeing','737-10 Max','Boeing 737-10 Max',230,5740,839,2400,1585,0.024,0.030,'M',134900000,10,2,'Aircraft_Boeing_737-10-Max.png'),
    (30,'Boeing','737-300','Boeing 737-300',149,4204,794,2150,1524,0.026,0.033,'M',55000000,6,2,'Aircraft_Boeing_737-300.png'),
    (31,'Boeing','737-400','Boeing 737-400',188,4005,794,2250,1585,0.027,0.034,'M',60000000,6,2,'Aircraft_Boeing_737-400.png'),
    (32,'Boeing','737-500','Boeing 737-500',132,4444,794,2000,1524,0.025,0.032,'M',54500000,7,2,'Aircraft_Boeing_737-500.png'),
    (33,'Boeing','737-600','Boeing 737-600',132,5648,828,1850,1463,0.023,0.029,'M',74000000,7,2,'Aircraft_Boeing_737-600.png'),
    (34,'Boeing','737-800','Boeing 737-800',189,5436,828,2300,1524,0.024,0.030,'M',106100000,9,2,'Aircraft_Boeing_737-800.png'),
    (35,'Boeing','747-300','Boeing 747-300',660,12400,907,3100,2100,0.044,0.055,'H',280000000,14,2,'Aircraft_Boeing_747-300.png'),
    (36,'Boeing','747-400','Boeing 747-400',660,13450,907,3200,2134,0.042,0.053,'H',418400000,15,2,'Aircraft_Boeing_747-400.png'),
    (37,'Boeing','757-200','Boeing 757-200',239,7222,850,2400,1524,0.025,0.032,'H',125000000,10,2,'Aircraft_Boeing_757-200.png'),
    (38,'Boeing','757-300','Boeing 757-300',289,6287,850,2600,1676,0.027,0.034,'H',135000000,10,2,'Aircraft_Boeing_757-300.png'),
    (39,'Boeing','777-200','Boeing 777-200',440,9704,905,2800,1829,0.030,0.039,'H',306600000,13,2,'Aircraft_Boeing_777-200.png'),
    (40,'Boeing','787-9','Boeing 787-9',406,14140,903,3100,1676,0.028,0.036,'H',292500000,13,2,'Aircraft_Boeing_787-9.png'),
    (41,'Boeing','787-10','Boeing 787-10',440,11910,903,3200,1750,0.029,0.037,'H',338400000,13,2,'Aircraft_Boeing_787-10.png'),
    (42,'Bombardier','CRJ-200','Bombardier CRJ-200',50,3148,786,1510,1463,0.020,0.025,'M',27000000,3,2,'Aircraft_Bombardier_CRJ-200.png'),
    (43,'Bombardier','CRJ-700','Bombardier CRJ-700',78,3620,828,1600,1524,0.021,0.026,'M',36200000,3,2,'Aircraft_Bombardier_CRJ-700.png'),
    (44,'Bombardier','CRJ-900','Bombardier CRJ-900',90,2956,828,1700,1585,0.022,0.027,'M',46300000,4,2,'Aircraft_Bombardier_CRJ-900.png'),
    (45,'British Aerospace','Jetstream 41','British Aerospace Jetstream 41',29,1482,547,1130,1097,0.018,0.023,'L',8500000,1,2,'Aircraft_British-Aerospace_Jetstream-41.png'),
    (46,'COMAC','C909','COMAC C909 (ARJ21)',95,3704,828,1700,1600,0.023,0.029,'M',38000000,5,2,'Aircraft_Comac_909.png'),
    (47,'COMAC','C919','COMAC C919',174,5555,834,2000,1700,0.024,0.030,'M',99000000,8,2,'Aircraft_Comac_919.png'),
    (48,'De Havilland','DHC-8-300','De Havilland DHC-8-300',56,1558,528,1180,1128,0.016,0.020,'M',17500000,1,2,'Aircraft_DeHavilland_DHC-8-300.png'),
    (49,'De Havilland','DHC-8-400','De Havilland DHC-8-400',90,2040,667,1250,1189,0.017,0.021,'M',32700000,2,2,'Aircraft_DeHavilland_DHC-8-400.png'),
    (50,'Dornier','328-100','Dornier 328-100',33,1667,620,1100,1036,0.017,0.021,'L',10800000,1,2,'Aircraft_Dornier_328-100.png'),
    (51,'Dornier','328 JET','Dornier 328 JET',34,1852,750,1200,1128,0.018,0.022,'M',14000000,2,2,'Aircraft_Dornier_328-JET.png'),
    (52,'Embraer','EMB 120','Embraer EMB 120 Brasilia',30,1482,555,1100,1036,0.016,0.020,'L',8000000,1,2,'Aircraft_Embrear_120.png'),
    (53,'Embraer','ERJ 135','Embraer ERJ 135',37,3241,834,1440,1372,0.019,0.024,'M',18500000,2,2,'Aircraft_Embrear_135.png'),
    (54,'Embraer','ERJ 140','Embraer ERJ 140',44,2963,834,1480,1402,0.020,0.025,'M',21500000,2,2,'Aircraft_Embrear_140.png'),
    (55,'Embraer','ERJ 145','Embraer ERJ 145',50,2871,834,1520,1433,0.021,0.026,'M',29900000,3,2,'Aircraft_Embrear_145.png'),
    (56,'Embraer','E190','Embraer E190',114,4537,829,1600,1350,0.023,0.029,'M',51300000,5,2,'Aircraft_Embrear_190.png'),
    (57,'Embraer','E195','Embraer E195',124,4074,829,1650,1400,0.024,0.030,'M',53000000,6,2,'Aircraft_Embrear_195.png'),
    (58,'Saab','340','Saab 340',36,1735,522,1290,975,0.015,0.019,'L',7500000,1,2,'Aircraft_Saab_Saab-340.png'),
    (59,'Sukhoi','Superjet 100','Sukhoi Superjet 100',108,4578,828,1731,1680,0.022,0.028,'M',36000000,5,2,'Aircraft_Suchoi_Superjet-100.png'),
    (60,'Airbus','A350-900 ULR','Airbus A350-900 ULR',440,18000,903,2850,2200,0.033,0.043,'H',370000000,14,2,'Aircraft_Airbus_350-900.png'),
    (61,'Boeing','777-200LR','Boeing 777-200LR',440,17370,892,3100,2100,0.036,0.046,'H',360000000,13,2,'Aircraft_Boeing_777-200.png'),
    (62,'Airbus','A321 XLR','Airbus A321 XLR',206,8700,840,2500,1980,0.022,0.028,'M',142000000,11,2,'Aircraft_Airbus_321_Neo.png'),
    (63,'Airbus','A320neo','Airbus A320neo',180,6300,840,2100,1540,0.021,0.027,'M',110000000,9,2,'Aircraft_Airbus_320_Neo.png'),
    (64,'Boeing','747-8','Boeing 747-8',467,14320,920,3300,2200,0.044,0.055,'H',418000000,15,2,'Aircraft_Boeing_747-800.png')
    ON CONFLICT (id) DO NOTHING
  `, null, 'aircraft_types seed');
  await safeQuery(`SELECT setval('aircraft_types_id_seq', COALESCE((SELECT MAX(id) FROM aircraft_types), 1))`, null, 'setval at');

  // ── DATA CORRECTIONS ─────────────────────────────────────────────────────────
  // Aircraft runway & fuel corrections
  const fuelCorrections = [
    ["UPDATE aircraft_types SET min_runway_landing_m=1290, fuel_consumption_per_km=0.9  WHERE full_name='Saab 340'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1100, fuel_consumption_per_km=1.0  WHERE full_name='Dornier 328-100'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1100, fuel_consumption_per_km=0.9  WHERE full_name='Embraer EMB 120 Brasilia'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1130, fuel_consumption_per_km=0.8  WHERE full_name='British Aerospace Jetstream 41'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1107, fuel_consumption_per_km=1.15 WHERE full_name='ATR 42'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1180, fuel_consumption_per_km=1.0  WHERE full_name='De Havilland DHC-8-300'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1200, fuel_consumption_per_km=1.5  WHERE full_name='Dornier 328 JET'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1250, fuel_consumption_per_km=1.2  WHERE full_name='De Havilland DHC-8-400'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1350, fuel_consumption_per_km=1.7  WHERE full_name='Embraer E175-E2'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1333, fuel_consumption_per_km=1.5  WHERE full_name='ATR 72'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1380, fuel_consumption_per_km=1.8  WHERE full_name='Embraer E175'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1500, fuel_consumption_per_km=2.0  WHERE full_name='Embraer E190-E2'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1580, fuel_consumption_per_km=2.4  WHERE full_name='Embraer E190'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1463, fuel_consumption_per_km=2.3  WHERE full_name='Airbus A220-100'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1540, fuel_consumption_per_km=2.8  WHERE full_name='Avro RJ85'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1440, fuel_consumption_per_km=1.6  WHERE full_name='Embraer ERJ 135'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1560, fuel_consumption_per_km=2.1  WHERE full_name='Embraer E195-E2'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1850, fuel_consumption_per_km=2.9  WHERE full_name='Airbus A319'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1750, fuel_consumption_per_km=2.5  WHERE full_name='Airbus A319 Neo'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1600, fuel_consumption_per_km=2.6  WHERE full_name='Embraer E195'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1480, fuel_consumption_per_km=1.7  WHERE full_name='Embraer ERJ 140'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1520, fuel_consumption_per_km=1.8  WHERE full_name='Embraer ERJ 145'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1550, fuel_consumption_per_km=2.5  WHERE full_name='Airbus A220-300'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1690, fuel_consumption_per_km=2.8  WHERE full_name='Boeing 737-600'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1510, fuel_consumption_per_km=1.8  WHERE full_name='Bombardier CRJ-200'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=2090, fuel_consumption_per_km=3.0  WHERE full_name='Airbus A320'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1828, fuel_consumption_per_km=2.7  WHERE full_name='Airbus A318'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1800, fuel_consumption_per_km=2.6  WHERE full_name='Boeing 737-8 Max'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1940, fuel_consumption_per_km=3.3  WHERE full_name='Boeing 737-300'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1830, fuel_consumption_per_km=3.0  WHERE full_name='Boeing 737-500'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=2100, fuel_consumption_per_km=3.0  WHERE full_name='Boeing 737-800'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=2100, fuel_consumption_per_km=3.2  WHERE full_name='Boeing 757-200'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1600, fuel_consumption_per_km=2.1  WHERE full_name='Bombardier CRJ-700'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=2560, fuel_consumption_per_km=3.3  WHERE full_name='Airbus A321'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=2300, fuel_consumption_per_km=2.8  WHERE full_name='Airbus A321 Neo'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1980, fuel_consumption_per_km=3.3  WHERE full_name='Airbus A321 XLR'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=2100, fuel_consumption_per_km=2.9  WHERE full_name='Boeing 737-10 Max'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=2100, fuel_consumption_per_km=3.4  WHERE full_name='Boeing 737-400'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1700, fuel_consumption_per_km=2.3  WHERE full_name='Bombardier CRJ-900'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=2600, fuel_consumption_per_km=5.4  WHERE full_name='Boeing 787-8'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1700, fuel_consumption_per_km=2.4  WHERE full_name='COMAC C909 (ARJ21)'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=2400, fuel_consumption_per_km=3.4  WHERE full_name='Boeing 757-300'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=2800, fuel_consumption_per_km=6.2  WHERE full_name='Boeing 787-9'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=1731, fuel_consumption_per_km=2.3  WHERE full_name='Sukhoi Superjet 100'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=2000, fuel_consumption_per_km=3.0  WHERE full_name='COMAC C919'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=2900, fuel_consumption_per_km=6.5  WHERE full_name='Boeing 787-10'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=2480, fuel_consumption_per_km=6.1  WHERE full_name='Airbus A350-900'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=2500, fuel_consumption_per_km=6.8  WHERE full_name='Boeing 777-200'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=2400, fuel_consumption_per_km=6.0  WHERE full_name='Airbus A330-200'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=2500, fuel_consumption_per_km=6.3  WHERE full_name='Airbus A330-300'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=2480, fuel_consumption_per_km=5.3  WHERE full_name='Airbus A330-800 Neo'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=2600, fuel_consumption_per_km=5.6  WHERE full_name='Airbus A330-900 Neo'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=2800, fuel_consumption_per_km=7.9  WHERE full_name='Boeing 777-300'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=2700, fuel_consumption_per_km=6.5  WHERE full_name='Airbus A350-1000'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=3000, fuel_consumption_per_km=12.2 WHERE full_name='Airbus A380'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=2900, fuel_consumption_per_km=7.5  WHERE full_name='Airbus A340-300'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=3050, fuel_consumption_per_km=8.3  WHERE full_name='Airbus A340-500'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=3100, fuel_consumption_per_km=8.8  WHERE full_name='Airbus A340-600'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=3000, fuel_consumption_per_km=10.5 WHERE full_name='Boeing 747-300'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=2800, fuel_consumption_per_km=7.6  WHERE full_name='Boeing 777-200LR'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=3050, fuel_consumption_per_km=11.7 WHERE full_name='Boeing 747-400'"],
    ["UPDATE aircraft_types SET min_runway_landing_m=2700, fuel_consumption_per_km=7.2  WHERE full_name='Airbus A350-900 ULR'"],
    // List price corrections
    ["UPDATE aircraft_types SET list_price=320000000 WHERE full_name='Boeing 777-300'"],
    ["UPDATE aircraft_types SET list_price=23000000  WHERE full_name='Embraer ERJ 145'"],
    ["UPDATE aircraft_types SET list_price=41000000  WHERE full_name='Bombardier CRJ-700'"],
    ["UPDATE aircraft_types SET list_price=50000000  WHERE full_name='Boeing 737-500'"],
    // Image filename corrections
    ["UPDATE aircraft_types SET image_filename='Aircraft_British-Aerospace_Jetstream-41.png' WHERE full_name='British Aerospace Jetstream 41'"],
    ["UPDATE aircraft_types SET image_filename='Aircraft_Boeing_747-800.png' WHERE full_name='Boeing 747-8'"],
    ["UPDATE aircraft_types SET image_filename='Aircraft_Boeing_787-8.png' WHERE full_name='Boeing 787-8'"],
    // Wake turbulence fix
    ["UPDATE aircraft_types SET wake_turbulence_category='H' WHERE wake_turbulence_category='J'"],
    // Level redistribution (15-level system)
    ["UPDATE aircraft_types SET required_level=1  WHERE full_name IN ('Saab 340','Dornier 328-100','Embraer EMB 120 Brasilia','British Aerospace Jetstream 41','ATR 42','De Havilland DHC-8-300','ATR 72')"],
    ["UPDATE aircraft_types SET required_level=2  WHERE full_name IN ('Dornier 328 JET','Embraer ERJ 135','Embraer ERJ 140','De Havilland DHC-8-400')"],
    ["UPDATE aircraft_types SET required_level=3  WHERE full_name IN ('Embraer ERJ 145','Bombardier CRJ-200','Bombardier CRJ-700')"],
    ["UPDATE aircraft_types SET required_level=4  WHERE full_name IN ('Embraer E175','Embraer E175-E2','Bombardier CRJ-900','Avro RJ85')"],
    ["UPDATE aircraft_types SET required_level=5  WHERE full_name IN ('COMAC C909 (ARJ21)','Embraer E190','Embraer E190-E2','Sukhoi Superjet 100')"],
    ["UPDATE aircraft_types SET required_level=6  WHERE full_name IN ('Embraer E195','Embraer E195-E2','Boeing 737-300','Boeing 737-400')"],
    ["UPDATE aircraft_types SET required_level=7  WHERE full_name IN ('Boeing 737-500','Boeing 737-600','Airbus A318','Airbus A220-100')"],
    ["UPDATE aircraft_types SET required_level=8  WHERE full_name IN ('Airbus A220-300','Airbus A319','Airbus A319 Neo','COMAC C919')"],
    ["UPDATE aircraft_types SET required_level=9  WHERE full_name IN ('Airbus A320','Airbus A321','Boeing 737-800','Boeing 737-8 Max')"],
    ["UPDATE aircraft_types SET required_level=10 WHERE full_name IN ('Airbus A321 Neo','Boeing 737-10 Max','Boeing 757-200','Boeing 757-300')"],
    ["UPDATE aircraft_types SET required_level=11 WHERE full_name IN ('Airbus A330-200','Airbus A330-300','Airbus A330-800 Neo','Airbus A330-900 Neo','Airbus A321 XLR')"],
    ["UPDATE aircraft_types SET required_level=12 WHERE full_name IN ('Airbus A340-300','Airbus A340-500','Airbus A340-600','Boeing 787-8')"],
    ["UPDATE aircraft_types SET required_level=13 WHERE full_name IN ('Airbus A350-900','Boeing 787-9','Boeing 787-10','Boeing 777-200','Boeing 777-200LR')"],
    ["UPDATE aircraft_types SET required_level=14 WHERE full_name IN ('Boeing 747-300','Boeing 777-300','Airbus A350-1000','Airbus A350-900 ULR')"],
    ["UPDATE aircraft_types SET required_level=15 WHERE full_name IN ('Boeing 747-400','Airbus A380')"],
    // Display order — groups aircraft families together within each manufacturer
    // Airbus: A220=100, A318/A319=200, A320=300, A321=400, A330=500, A340=600, A350=700, A380=800
    ["UPDATE aircraft_types SET display_order=100 WHERE full_name='Airbus A220-100'"],
    ["UPDATE aircraft_types SET display_order=101 WHERE full_name='Airbus A220-300'"],
    ["UPDATE aircraft_types SET display_order=200 WHERE full_name='Airbus A318'"],
    ["UPDATE aircraft_types SET display_order=210 WHERE full_name='Airbus A319'"],
    ["UPDATE aircraft_types SET display_order=211 WHERE full_name='Airbus A319 Neo'"],
    ["UPDATE aircraft_types SET display_order=300 WHERE full_name='Airbus A320'"],
    ["UPDATE aircraft_types SET display_order=301 WHERE full_name='Airbus A320neo'"],
    ["UPDATE aircraft_types SET display_order=400 WHERE full_name='Airbus A321'"],
    ["UPDATE aircraft_types SET display_order=401 WHERE full_name='Airbus A321 Neo'"],
    ["UPDATE aircraft_types SET display_order=402 WHERE full_name='Airbus A321 XLR'"],
    ["UPDATE aircraft_types SET display_order=500 WHERE full_name='Airbus A330-200'"],
    ["UPDATE aircraft_types SET display_order=501 WHERE full_name='Airbus A330-300'"],
    ["UPDATE aircraft_types SET display_order=502 WHERE full_name='Airbus A330-800 Neo'"],
    ["UPDATE aircraft_types SET display_order=503 WHERE full_name='Airbus A330-900 Neo'"],
    ["UPDATE aircraft_types SET display_order=600 WHERE full_name='Airbus A340-300'"],
    ["UPDATE aircraft_types SET display_order=601 WHERE full_name='Airbus A340-500'"],
    ["UPDATE aircraft_types SET display_order=602 WHERE full_name='Airbus A340-600'"],
    ["UPDATE aircraft_types SET display_order=700 WHERE full_name='Airbus A350-900'"],
    ["UPDATE aircraft_types SET display_order=701 WHERE full_name='Airbus A350-900 ULR'"],
    ["UPDATE aircraft_types SET display_order=702 WHERE full_name='Airbus A350-1000'"],
    ["UPDATE aircraft_types SET display_order=800 WHERE full_name='Airbus A380'"],
    // ATR
    ["UPDATE aircraft_types SET display_order=100 WHERE full_name='ATR 42'"],
    ["UPDATE aircraft_types SET display_order=101 WHERE full_name='ATR 72'"],
    // Avro
    ["UPDATE aircraft_types SET display_order=100 WHERE full_name='Avro RJ85'"],
    // Boeing: 737=100, 747=200, 757=300, 777=400, 787=500
    ["UPDATE aircraft_types SET display_order=100 WHERE full_name='Boeing 737-300'"],
    ["UPDATE aircraft_types SET display_order=101 WHERE full_name='Boeing 737-400'"],
    ["UPDATE aircraft_types SET display_order=102 WHERE full_name='Boeing 737-500'"],
    ["UPDATE aircraft_types SET display_order=103 WHERE full_name='Boeing 737-600'"],
    ["UPDATE aircraft_types SET display_order=104 WHERE full_name='Boeing 737-800'"],
    ["UPDATE aircraft_types SET display_order=105 WHERE full_name='Boeing 737-8 Max'"],
    ["UPDATE aircraft_types SET display_order=106 WHERE full_name='Boeing 737-10 Max'"],
    ["UPDATE aircraft_types SET display_order=200 WHERE full_name='Boeing 747-300'"],
    ["UPDATE aircraft_types SET display_order=201 WHERE full_name='Boeing 747-400'"],
    ["UPDATE aircraft_types SET display_order=202 WHERE full_name='Boeing 747-8'"],
    ["UPDATE aircraft_types SET display_order=300 WHERE full_name='Boeing 757-200'"],
    ["UPDATE aircraft_types SET display_order=301 WHERE full_name='Boeing 757-300'"],
    ["UPDATE aircraft_types SET display_order=400 WHERE full_name='Boeing 777-200'"],
    ["UPDATE aircraft_types SET display_order=401 WHERE full_name='Boeing 777-200LR'"],
    ["UPDATE aircraft_types SET display_order=402 WHERE full_name='Boeing 777-300'"],
    ["UPDATE aircraft_types SET display_order=500 WHERE full_name='Boeing 787-8'"],
    ["UPDATE aircraft_types SET display_order=501 WHERE full_name='Boeing 787-9'"],
    ["UPDATE aircraft_types SET display_order=502 WHERE full_name='Boeing 787-10'"],
    // Bombardier
    ["UPDATE aircraft_types SET display_order=100 WHERE full_name='Bombardier CRJ-200'"],
    ["UPDATE aircraft_types SET display_order=101 WHERE full_name='Bombardier CRJ-700'"],
    ["UPDATE aircraft_types SET display_order=102 WHERE full_name='Bombardier CRJ-900'"],
    // British Aerospace
    ["UPDATE aircraft_types SET display_order=100 WHERE full_name='British Aerospace Jetstream 41'"],
    // COMAC
    ["UPDATE aircraft_types SET display_order=100 WHERE full_name='COMAC C909 (ARJ21)'"],
    ["UPDATE aircraft_types SET display_order=101 WHERE full_name='COMAC C919'"],
    // De Havilland
    ["UPDATE aircraft_types SET display_order=100 WHERE full_name='De Havilland DHC-8-300'"],
    ["UPDATE aircraft_types SET display_order=101 WHERE full_name='De Havilland DHC-8-400'"],
    // Dornier
    ["UPDATE aircraft_types SET display_order=100 WHERE full_name='Dornier 328-100'"],
    ["UPDATE aircraft_types SET display_order=101 WHERE full_name='Dornier 328 JET'"],
    // Embraer: EMB=100, ERJ=200, E-Jets=300, E2=400
    ["UPDATE aircraft_types SET display_order=100 WHERE full_name='Embraer EMB 120 Brasilia'"],
    ["UPDATE aircraft_types SET display_order=200 WHERE full_name='Embraer ERJ 135'"],
    ["UPDATE aircraft_types SET display_order=201 WHERE full_name='Embraer ERJ 140'"],
    ["UPDATE aircraft_types SET display_order=202 WHERE full_name='Embraer ERJ 145'"],
    ["UPDATE aircraft_types SET display_order=300 WHERE full_name='Embraer E175'"],
    ["UPDATE aircraft_types SET display_order=301 WHERE full_name='Embraer E190'"],
    ["UPDATE aircraft_types SET display_order=302 WHERE full_name='Embraer E195'"],
    ["UPDATE aircraft_types SET display_order=400 WHERE full_name='Embraer E175-E2'"],
    ["UPDATE aircraft_types SET display_order=401 WHERE full_name='Embraer E190-E2'"],
    ["UPDATE aircraft_types SET display_order=402 WHERE full_name='Embraer E195-E2'"],
    // Saab
    ["UPDATE aircraft_types SET display_order=100 WHERE full_name='Saab 340'"],
    // Sukhoi
    ["UPDATE aircraft_types SET display_order=100 WHERE full_name='Sukhoi Superjet 100'"],
  ];
  await runStatements(fuelCorrections.map(([s]) => s), 'data fixes');

  // ── TOFL (min_runway_takeoff_m) corrections ───────────────────────────────
  const toflCorrections = [
    "UPDATE aircraft_types SET min_runway_takeoff_m=1290 WHERE full_name='Saab 340'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1100 WHERE full_name='Dornier 328-100'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1100 WHERE full_name='Embraer EMB 120 Brasilia'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1130 WHERE full_name='British Aerospace Jetstream 41'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1107 WHERE full_name='ATR 42'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1180 WHERE full_name='De Havilland DHC-8-300'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1200 WHERE full_name='Dornier 328 JET'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1250 WHERE full_name='De Havilland DHC-8-400'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1350 WHERE full_name='Embraer E175-E2'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1333 WHERE full_name='ATR 72'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1400 WHERE full_name='Embraer E175'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1500 WHERE full_name='Embraer E190-E2'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1600 WHERE full_name='Embraer E190'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1463 WHERE full_name='Airbus A220-100'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1540 WHERE full_name='Avro RJ85'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1440 WHERE full_name='Embraer ERJ 135'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1560 WHERE full_name='Embraer E195-E2'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=2164 WHERE full_name='Airbus A319'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1860 WHERE full_name='Airbus A319 Neo'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1650 WHERE full_name='Embraer E195'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1480 WHERE full_name='Embraer ERJ 140'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1520 WHERE full_name='Embraer ERJ 145'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1600 WHERE full_name='Airbus A220-300'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1850 WHERE full_name='Boeing 737-600'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1510 WHERE full_name='Bombardier CRJ-200'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=2090 WHERE full_name='Airbus A320'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1828 WHERE full_name='Airbus A318'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=2100 WHERE full_name='Boeing 737-8 Max'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=2150 WHERE full_name='Boeing 737-300'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=2000 WHERE full_name='Boeing 737-500'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=2300 WHERE full_name='Boeing 737-800'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=2400 WHERE full_name='Boeing 757-200'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1600 WHERE full_name='Bombardier CRJ-700'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=2560 WHERE full_name='Airbus A321'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=2300 WHERE full_name='Airbus A321 Neo'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=2500 WHERE full_name='Airbus A321 XLR'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=2400 WHERE full_name='Boeing 737-10 Max'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=2250 WHERE full_name='Boeing 737-400'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1700 WHERE full_name='Bombardier CRJ-900'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=3050 WHERE full_name='Boeing 787-8'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1700 WHERE full_name='COMAC C909 (ARJ21)'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=2600 WHERE full_name='Boeing 757-300'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=3100 WHERE full_name='Boeing 787-9'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=1731 WHERE full_name='Sukhoi Superjet 100'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=2000 WHERE full_name='COMAC C919'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=3200 WHERE full_name='Boeing 787-10'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=2600 WHERE full_name='Airbus A350-900'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=2800 WHERE full_name='Boeing 777-200'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=2600 WHERE full_name='Airbus A330-200'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=2700 WHERE full_name='Airbus A330-300'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=2480 WHERE full_name='Airbus A330-800 Neo'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=2770 WHERE full_name='Airbus A330-900 Neo'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=3200 WHERE full_name='Boeing 777-300'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=2900 WHERE full_name='Airbus A350-1000'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=3000 WHERE full_name='Airbus A380'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=3000 WHERE full_name='Airbus A340-300'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=3200 WHERE full_name='Airbus A340-500'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=3300 WHERE full_name='Airbus A340-600'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=3100 WHERE full_name='Boeing 747-300'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=3100 WHERE full_name='Boeing 777-200LR'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=3200 WHERE full_name='Boeing 747-400'",
    "UPDATE aircraft_types SET min_runway_takeoff_m=2850 WHERE full_name='Airbus A350-900 ULR'",
  ];
  await runStatements(toflCorrections, 'TOFL corrections');

  // Depreciation parameters
  const depreciationData = [
    [25,0.048,0.0000048],[26,0.048,0.0000048],[45,0.048,0.0000048],[48,0.048,0.0000048],
    [49,0.048,0.0000048],[50,0.048,0.0000048],[52,0.048,0.0000048],[58,0.048,0.0000048],
    [1,0.044,0.0000054],[2,0.044,0.0000054],[42,0.044,0.0000054],[43,0.044,0.0000054],
    [44,0.044,0.0000054],[46,0.044,0.0000054],[51,0.044,0.0000054],[53,0.044,0.0000054],
    [54,0.044,0.0000054],[55,0.044,0.0000054],
    [3,0.038,0.000006],[4,0.038,0.000006],[5,0.038,0.000006],[6,0.038,0.000006],
    [7,0.038,0.000006],[8,0.038,0.000006],[9,0.038,0.000006],[10,0.038,0.000006],
    [11,0.038,0.000006],[15,0.038,0.000006],[27,0.038,0.000006],[28,0.038,0.000006],
    [29,0.038,0.000006],[30,0.038,0.000006],[31,0.038,0.000006],[32,0.038,0.000006],
    [33,0.038,0.000006],[34,0.038,0.000006],[37,0.038,0.000006],[38,0.038,0.000006],
    [47,0.038,0.000006],[56,0.038,0.000006],[57,0.038,0.000006],[59,0.038,0.000006],
    [12,0.032,0.0000072],[16,0.032,0.0000072],[17,0.032,0.0000072],[18,0.032,0.0000072],
    [19,0.032,0.0000072],[20,0.032,0.0000072],[21,0.032,0.0000072],[22,0.032,0.0000072],
    [23,0.032,0.0000072],[24,0.032,0.0000072],[39,0.032,0.0000072],[60,0.032,0.0000072],
    [61,0.032,0.0000072],[40,0.032,0.0000072],[41,0.032,0.0000072],
    [13,0.028,0.000009],[14,0.028,0.000009],[35,0.028,0.000009],[36,0.028,0.000009],
  ];
  for (const [id, kAge, kFh] of depreciationData) {
    await pool.query(
      'UPDATE aircraft_types SET depreciation_age=$1, depreciation_fh=$2 WHERE id=$3',
      [kAge, kFh, id]
    ).catch(() => {});
  }

  // fuel_consumption_per_km sync
  await pool.query(`
    UPDATE aircraft_types
    SET fuel_consumption_per_km = ROUND(CAST(fuel_consumption_full_per_km * 100 AS numeric), 4)
    WHERE fuel_consumption_per_km < 1
  `).catch(() => {});

  // ── AIRPORT COORDINATE + CATEGORY SEED ───────────────────────────────────────
  // Direct UPDATEs for every airport inserted without coordinates in schema.sql.
  // Uses safeQuery so any error is logged but never crashes startup.
  const airportGeoData = [
    // [iata_code, category, continent, runway_m, lat, lng]
    ['ZRH', 6, 'Europe',         3700,  47.4647,   8.5492],
    ['GVA', 5, 'Europe',         3900,  46.2381,   6.1090],
    ['BSL', 4, 'Europe',         3900,  47.5896,   7.5299],
    ['FRA', 7, 'Europe',         4000,  50.0379,   8.5622],
    ['MUC', 6, 'Europe',         4000,  48.3537,  11.7750],
    ['BER', 6, 'Europe',         3600,  52.3667,  13.5033],
    ['LHR', 8, 'Europe',         3902,  51.4700,  -0.4543],
    ['LGW', 6, 'Europe',         3316,  51.1537,  -0.1821],
    ['MAN', 5, 'Europe',         3048,  53.3537,  -2.2750],
    ['CDG', 8, 'Europe',         4200,  49.0097,   2.5479],
    ['ORY', 6, 'Europe',         3650,  48.7233,   2.3794],
    ['AMS', 7, 'Europe',         3800,  52.3105,   4.7683],
    ['JFK', 7, 'North America',  4423,  40.6413, -73.7781],
    ['LAX', 8, 'North America',  3685,  33.9416,-118.4085],
    ['ORD', 8, 'North America',  3962,  41.9742, -87.9073],
    ['ATL', 8, 'North America',  3776,  33.6407, -84.4277],
    ['DXB', 8, 'Asia',           4000,  25.2528,  55.3644],
    ['SIN', 8, 'Asia',           4000,   1.3644, 103.9915],
    ['NRT', 7, 'Asia',           4000,  35.7647, 140.3864],
    ['HND', 7, 'Asia',           3360,  35.5494, 139.7798],
    ['SYD', 6, 'Oceania',        3962, -33.9461, 151.1772],
    ['MAD', 7, 'Europe',         4349,  40.4936,  -3.5668],
    ['BCN', 6, 'Europe',         3743,  41.2974,   2.0833],
    ['PMI', 5, 'Europe',         3270,  39.5517,   2.7388],
    ['AGP', 5, 'Europe',         3200,  36.6749,  -4.4991],
    ['ALC', 4, 'Europe',         3000,  38.2822,  -0.5582],
    ['VLC', 4, 'Europe',         3210,  39.4893,  -0.4816],
    ['BIL', 3, 'Europe',         2400,  43.3011,  -2.9106],
    ['FCO', 6, 'Europe',         3900,  41.8003,  12.2389],
    ['MXP', 5, 'Europe',         3920,  45.6306,   8.7281],
    ['IST', 8, 'Europe',         4100,  41.2608,  28.7418],
    ['DME', 6, 'Europe',         3794,  55.4088,  37.9063],
    ['VIE', 5, 'Europe',         3600,  48.1103,  16.5697],
    ['CPH', 5, 'Europe',         3600,  55.6180,  12.6560],
    ['ARN', 5, 'Europe',         3301,  59.6519,  17.9186],
    ['DUB', 5, 'Europe',         3110,  53.4213,  -6.2701],
    ['OSL', 5, 'Europe',         3600,  60.1939,  11.1004],
    ['HEL', 5, 'Europe',         3440,  60.3172,  24.9633],
    ['LIS', 5, 'Europe',         3805,  38.7813,  -9.1359],
    ['OPO', 5, 'Europe',         3480,  41.2481,  -8.6814],
    ['FAO', 4, 'Europe',         2880,  37.0144,  -7.9659],
    ['ATH', 5, 'Europe',         4000,  37.9364,  23.9445],
    ['SKG', 4, 'Europe',         2600,  40.5197,  22.9709],
    ['WAW', 5, 'Europe',         3690,  52.1657,  20.9671],
    ['KRK', 3, 'Europe',         3580,  50.0777,  19.7848],
    ['GDN', 3, 'Europe',         2800,  54.3776,  18.4662],
    ['PRG', 4, 'Europe',         3715,  50.1008,  14.2632],
    ['BRU', 5, 'Europe',         3638,  50.9010,   4.4844],
    ['DUS', 5, 'Europe',         3000,  51.2895,   6.7668],
    ['HAM', 4, 'Europe',         3666,  53.6304,  10.0062],
    ['STR', 4, 'Europe',         3345,  48.6899,   9.2219],
    ['TXL', 4, 'Europe',         2428,  52.5597,  13.2877],
    ['BUD', 4, 'Europe',         3707,  47.4298,  19.2611],
    ['OTP', 4, 'Europe',         3500,  44.5711,  26.0850],
    ['SOF', 4, 'Europe',         3600,  42.6952,  23.4114],
    ['ZAG', 4, 'Europe',         3252,  45.7429,  16.0688],
    ['LJU', 3, 'Europe',         3300,  46.2237,  14.4576],
    ['NCE', 5, 'Europe',         3000,  43.6584,   7.2159],
    ['MRS', 4, 'Europe',         3500,  43.4393,   5.2214],
    ['LYS', 4, 'Europe',         4000,  45.7256,   5.0811],
    ['TLS', 4, 'Europe',         3500,  43.6293,   1.3638],
    ['RIX', 4, 'Europe',         3200,  56.9236,  23.9711],
    ['TLL', 3, 'Europe',         3070,  59.4133,  24.8328],
    ['VNO', 3, 'Europe',         2515,  54.6341,  25.2858],
  ];
  for (const [code, cat, cont, rwy, lat, lng] of airportGeoData) {
    await safeQuery(
      `UPDATE airports SET category=$1, continent=$2, runway_length_m=$3, latitude=$4, longitude=$5 WHERE iata_code=$6`,
      [cat, cont, rwy, lat, lng, code],
      `geo ${code}`
    );
  }

  // ── AIRPORT CATEGORY CORRECTIONS (runs after geo seed, before fee seed) ──────
  const airportCategoryFixes = [
    // Category 5
    ['DAC', 5], ['DMM', 5], ['DWC', 5],
    // Category 6
    ['BNE', 6], ['CGO', 6], ['CSX', 6], ['DLC', 6], ['DME', 6], ['DPS', 6],
    ['DTW', 6], ['ESB', 6], ['FUK', 6], ['HNL', 6], ['KIX', 6], ['LIM', 6],
    ['SCL', 6], ['CCU', 6],
    // Category 7
    ['AUH', 7], ['AYT', 7], ['BCN', 7], ['BER', 7], ['BOS', 7], ['CJU', 7],
    ['CLT', 7], ['CUN', 7], ['EWR', 7], ['FCO', 7], ['GRU', 7], ['IAD', 7],
    ['IAH', 7], ['JED', 7], ['LAS', 7], ['LGW', 7], ['MCO', 7], ['MEL', 7],
    ['MEX', 7], ['MSP', 7], ['MUC', 7], ['ORY', 7], ['PHL', 7], ['PHX', 7],
    ['RUH', 7], ['SEA', 7], ['SGN', 7], ['STN', 7], ['SVO', 7], ['SYD', 7],
    ['YVR', 7], ['ZRH', 7], ['BLR', 7], ['CKG', 7], ['DOH', 7], ['HKG', 7],
    ['MIA', 7], ['NRT', 7], ['SFO', 7], ['BOM', 7], ['CGK', 7], ['CTU', 7],
    ['XIY', 7],
    // Category 6 (batch 2)
    ['AGP', 6], ['AUS', 6], ['ARN', 6], ['BNA', 6], ['BRU', 6], ['BWI', 6],
    ['DUS', 6], ['EZE', 6], ['FLL', 6], ['GMP', 6], ['GVA', 6], ['HAN', 6],
    ['HEL', 6], ['HKT', 6], ['HYD', 6], ['LGA', 6], ['LIS', 6], ['MAN', 6],
    ['MXP', 6], ['NKG', 6], ['OPO', 6], ['OSL', 6], ['PDX', 6], ['PER', 6],
    ['PMI', 6], ['SAN', 6], ['SLC', 6], ['TPA', 6], ['WAW', 6], ['YUL', 6],
    ['YYC', 6],
    // Category 7 (batch 2)
    ['ATH', 7], ['CAI', 7], ['CPH', 7], ['DUB', 7], ['HGH', 7], ['KMG', 7],
    ['MNL', 7], ['SAW', 7], ['SHA', 7], ['TPE', 7], ['VIE', 7], ['YYZ', 7],
    // Category 8
    ['AMS', 8], ['DEN', 8], ['DFW', 8], ['FRA', 8], ['HND', 8], ['ICN', 8],
    ['JFK', 8], ['MAD', 8], ['PVG', 8], ['SZX', 8], ['ATL', 8], ['BKK', 8],
    ['CAN', 8], ['CDG', 8], ['DEL', 8], ['DXB', 8], ['IST', 8], ['LAX', 8],
    ['LHR', 8], ['ORD', 8], ['SIN', 8], ['PEK', 8],
  ];
  for (const [code, cat] of airportCategoryFixes) {
    await safeQuery('UPDATE airports SET category=$1 WHERE iata_code=$2', [cat, code], `cat fix ${code}`);
  }
  // BJS → PEK rename (Beijing city code → actual airport code)
  await safeQuery(`UPDATE airports SET iata_code='PEK', name='Beijing Capital International Airport' WHERE iata_code='BJS'`, null, 'BJS→PEK rename');

  // TEN → TFN consolidation (TEN was an incorrect duplicate for Tenerife Norte)
  {
    const { rows: tenRows } = await safeQuery(`SELECT 1 FROM airports WHERE iata_code='TEN'`, null, 'check TEN');
    if (tenRows.length) {
      const { rows: tfnRows } = await safeQuery(`SELECT 1 FROM airports WHERE iata_code='TFN'`, null, 'check TFN');
      if (!tfnRows.length) {
        await safeQuery(`UPDATE airports SET iata_code='TFN' WHERE iata_code='TEN'`, null, 'TEN→TFN rename');
      } else {
        const reassign = [
          ['aircraft', 'home_airport'],
          ['aircraft', 'current_location'],
          ['routes', 'departure_airport'],
          ['routes', 'arrival_airport'],
          ['weekly_schedule', 'departure_airport'],
          ['weekly_schedule', 'arrival_airport'],
          ['airline_destinations', 'airport_code'],
          ['personnel', 'airport_code'],
          ['airport_slots', 'airport_code'],
          ['slot_usage', 'airport_code'],
          ['transfer_flights', 'departure_airport'],
          ['transfer_flights', 'arrival_airport'],
          ['airport_expansions', 'airport_code'],
          ['expansion_usage', 'airport_code'],
          ['used_aircraft_market', 'location'],
        ];
        for (const [tbl, col] of reassign) {
          await safeQuery(`UPDATE ${tbl} SET ${col}='TFN' WHERE ${col}='TEN'`, null, `TEN→TFN ${tbl}.${col}`);
        }
        await safeQuery(`DELETE FROM airports WHERE iata_code='TEN'`, null, 'delete TEN');
      }
    }
  }

  // ── AIRPORT FEE SEED (runs after coordinate seed so category is correct) ─────
  const CAT_FEES = {
    8:[850,2900,7300,600,1200,2150], 7:[700,2400,5900,550,1075,1825],
    6:[600,1800,4000,500,950,1500],  5:[350,850,2850,450,800,1200],
    4:[300,700,2200,400,650,950],    3:[250,550,1800,350,500,750],
    2:[200,400,1400,300,400,600],    1:[150,300,1000,250,300,450],
  };
  const { rows: allAirports } = await safeQuery('SELECT iata_code, category FROM airports', null, 'airport fees fetch');
  for (const { iata_code, category } of allAirports) {
    const [l,m,h,gl,gm,gh] = CAT_FEES[category] || CAT_FEES[3];
    await safeQuery(
      `UPDATE airports SET landing_fee_light=$1, landing_fee_medium=$2, landing_fee_heavy=$3,
       ground_handling_fee=$4, ground_handling_fee_light=$4, ground_handling_fee_medium=$5, ground_handling_fee_heavy=$6
       WHERE iata_code=$7`,
      [l, m, h, gl, gm, gh, iata_code]
    );
  }

  // ── SEED INITIAL FUEL PRICE ───────────────────────────────────────────────────
  const { rows: fuelRows } = await safeQuery('SELECT COUNT(*) as c FROM fuel_prices', null, 'fuel count');
  if (parseInt(fuelRows[0]?.c ?? 0) === 0) {
    await safeQuery('INSERT INTO fuel_prices (price_per_liter) VALUES ($1)', [0.72], 'fuel seed');
  }

  // ── CLEANUP: drop legacy/unused tables ───────────────────────────────────────
  await safeQuery(`ALTER TABLE flights DROP CONSTRAINT IF EXISTS flights_service_profile_id_fkey`, null, 'drop sp fkey');
  await safeQuery(`DROP TABLE IF EXISTS service_profiles`, null, 'drop service_profiles');
  await safeQuery(`DROP TABLE IF EXISTS mega_hubs`, null, 'drop mega_hubs');
  await safeQuery(`ALTER TABLE aircraft DROP COLUMN IF EXISTS cabin_profile_id`, null, 'drop cabin_profile_id');
  await safeQuery(`DROP TABLE IF EXISTS cabin_profiles`, null, 'drop cabin_profiles');

  // ── BOOTSTRAP ADMINS ─────────────────────────────────────────────────────────
  await safeQuery(
    `UPDATE users SET is_admin = TRUE WHERE email = $1`,
    ['timjorik@gmail.com'],
    'bootstrap admin (email)'
  );
  await safeQuery(
    `UPDATE users SET is_admin = TRUE WHERE LOWER(username) = LOWER($1)`,
    ['Aclobe'],
    'bootstrap admin (Aclobe)'
  );

  // ── AUTO-SET active_airline_id for existing users ────────────────────────────
  await safeQuery(`
    UPDATE users
    SET active_airline_id = (
      SELECT id FROM airlines WHERE user_id = users.id ORDER BY id LIMIT 1
    )
    WHERE active_airline_id IS NULL
      AND EXISTS (SELECT 1 FROM airlines WHERE user_id = users.id)
  `, null, 'active airline');

  console.log('Schema and seed data applied');
}

// No-op for backwards compatibility — PostgreSQL doesn't need file persistence
function saveDatabase() {}

// Returns pool for any legacy code that might use it
function getDatabase() {
  return pool;
}

export { initDatabase, saveDatabase, getDatabase };
