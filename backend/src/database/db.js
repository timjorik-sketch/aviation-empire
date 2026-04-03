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

    // INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING
    if (pgStmt.includes('__INSERT_IGNORE__')) {
      pgStmt = pgStmt.replace('__INSERT_IGNORE__', 'INSERT');
      pgStmt += ' ON CONFLICT DO NOTHING';
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
      if (msg.includes('already exists') || msg.includes('duplicate key')) continue;
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
  console.log('✅ PostgreSQL connected');

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
    `CREATE TABLE IF NOT EXISTS mega_hubs (
      id SERIAL PRIMARY KEY,
      airline_id INTEGER NOT NULL,
      airport_code TEXT NOT NULL,
      hub_number INTEGER NOT NULL,
      category INTEGER NOT NULL,
      cost INTEGER NOT NULL,
      purchased_at TIMESTAMPTZ DEFAULT NOW(),
      FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE,
      UNIQUE(airline_id, airport_code)
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
  ];
  await runStatements(extraTables, 'extra tables');

  // ── ADD MISSING COLUMNS (idempotent — DO NOTHING if already exist) ──────────
  const alterCols = [
    // aircraft table
    `ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS is_active INTEGER DEFAULT 0`,
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
    // airlines table
    `ALTER TABLE airlines ADD COLUMN IF NOT EXISTS active_airline_id INTEGER REFERENCES airlines(id)`,
    `ALTER TABLE airlines ADD COLUMN IF NOT EXISTS last_payroll_at TIMESTAMPTZ`,
    `ALTER TABLE airlines ADD COLUMN IF NOT EXISTS logo_filename TEXT`,
    // users table
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS active_airline_id INTEGER REFERENCES airlines(id)`,
    // flights table
    `ALTER TABLE flights ADD COLUMN IF NOT EXISTS service_profile_id INTEGER REFERENCES service_profiles(id)`,
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
    // maintenance_schedule table
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

  // ── SEED additional aircraft types (IDs 15-61) ───────────────────────────────
  await safeQuery(`
    INSERT INTO aircraft_types (id, manufacturer, model, full_name, max_passengers, range_km, cruise_speed_kmh, min_runway_takeoff_m, min_runway_landing_m, fuel_consumption_empty_per_km, fuel_consumption_full_per_km, wake_turbulence_category, new_price_usd, required_level, required_pilots, image_filename) VALUES
    (15,'Airbus','A319 Neo','Airbus A319 Neo',160,6850,828,1850,1400,0.020,0.025,'M',101500000,8,2,'Aircraft_Airbus_319_Neo.png'),
    (16,'Airbus','A330-200','Airbus A330-200',406,13450,871,2770,1830,0.031,0.040,'H',238500000,11,2,'Aircraft_Airbus_330-200.png'),
    (17,'Airbus','A330-300','Airbus A330-300',440,11750,871,2770,1830,0.033,0.042,'H',264200000,11,2,'Aircraft_Airbus_330-300.png'),
    (18,'Airbus','A330-800 Neo','Airbus A330-800 Neo',406,15094,871,2500,1830,0.028,0.036,'H',259900000,11,2,'Aircraft_Airbus_330-800_Neo.png'),
    (19,'Airbus','A330-900 Neo','Airbus A330-900 Neo',440,13334,871,2770,1830,0.029,0.037,'H',296400000,11,2,'Aircraft_Airbus_330-900_Neo.png'),
    (20,'Airbus','A340-300','Airbus A340-300',440,13500,871,3000,2000,0.038,0.048,'H',238000000,12,2,'Aircraft_Airbus_340-300.png'),
    (21,'Airbus','A340-500','Airbus A340-500',375,16670,871,3050,2100,0.040,0.050,'H',275400000,12,2,'Aircraft_Airbus_340-500.png'),
    (22,'Airbus','A340-600','Airbus A340-600',475,14630,871,3100,2100,0.042,0.052,'H',283000000,12,2,'Aircraft_Airbus_340-600.png'),
    (23,'Airbus','A350-900','Airbus A350-900',440,15372,903,2600,1800,0.026,0.034,'H',317400000,13,2,'Aircraft_Airbus_350-900.png'),
    (24,'Airbus','A350-1000','Airbus A350-1000',480,16112,903,2750,1900,0.028,0.036,'H',366500000,14,2,'Aircraft_Airbus_350-1000.png'),
    (25,'ATR','42','ATR 42',48,1302,556,1165,1107,0.015,0.019,'M',18400000,1,2,'Aircraft_ATR_ATR-42.png'),
    (26,'ATR','72','ATR 72',72,1403,510,1333,1279,0.016,0.020,'M',26500000,1,2,'Aircraft_ATR_ATR-72.png'),
    (27,'Avro','RJ85','Avro RJ85',112,3335,764,1677,1372,0.025,0.031,'M',35000000,4,2,'Aircraft_Avro_RJ85.png'),
    (28,'Boeing','737-8 Max','Boeing 737-8 Max',210,6570,839,2286,1524,0.022,0.028,'M',121600000,9,2,'Aircraft_Boeing_737-8-Max.png'),
    (29,'Boeing','737-10 Max','Boeing 737-10 Max',230,5740,839,2438,1585,0.024,0.030,'M',134900000,10,2,'Aircraft_Boeing_737-10-Max.png'),
    (30,'Boeing','737-300','Boeing 737-300',149,4204,794,2316,1524,0.026,0.033,'M',55000000,6,2,'Aircraft_Boeing_737-300.png'),
    (31,'Boeing','737-400','Boeing 737-400',188,4005,794,2438,1585,0.027,0.034,'M',60000000,6,2,'Aircraft_Boeing_737-400.png'),
    (32,'Boeing','737-500','Boeing 737-500',132,4444,794,2286,1524,0.025,0.032,'M',54500000,7,2,'Aircraft_Boeing_737-500.png'),
    (33,'Boeing','737-600','Boeing 737-600',132,5648,828,1981,1463,0.023,0.029,'M',74000000,7,2,'Aircraft_Boeing_737-600.png'),
    (34,'Boeing','737-800','Boeing 737-800',189,5436,828,2438,1524,0.024,0.030,'M',106100000,9,2,'Aircraft_Boeing_737-800.png'),
    (35,'Boeing','747-300','Boeing 747-300',660,12400,907,3200,2100,0.044,0.055,'H',280000000,14,2,'Aircraft_Boeing_747-300.png'),
    (36,'Boeing','747-400','Boeing 747-400',660,13450,907,3018,2134,0.042,0.053,'H',418400000,15,2,'Aircraft_Boeing_747-400.png'),
    (37,'Boeing','757-200','Boeing 757-200',239,7222,850,1981,1524,0.025,0.032,'H',125000000,10,2,'Aircraft_Boeing_757-200.png'),
    (38,'Boeing','757-300','Boeing 757-300',289,6287,850,2438,1676,0.027,0.034,'H',135000000,10,2,'Aircraft_Boeing_757-300.png'),
    (39,'Boeing','777-200','Boeing 777-200',440,9704,905,3139,1829,0.030,0.039,'H',306600000,13,2,'Aircraft_Boeing_777-200.png'),
    (40,'Boeing','787-9','Boeing 787-9',406,14140,903,2750,1676,0.028,0.036,'H',292500000,13,2,'Aircraft_Boeing_787-9.png'),
    (41,'Boeing','787-10','Boeing 787-10',440,11910,903,2900,1750,0.029,0.037,'H',338400000,13,2,'Aircraft_Boeing_787-10.png'),
    (42,'Bombardier','CRJ-200','Bombardier CRJ-200',50,3148,786,1876,1463,0.020,0.025,'M',27000000,3,2,'Aircraft_Bombardier_CRJ-200.png'),
    (43,'Bombardier','CRJ-700','Bombardier CRJ-700',78,3620,828,1905,1524,0.021,0.026,'M',36200000,3,2,'Aircraft_Bombardier_CRJ-700.png'),
    (44,'Bombardier','CRJ-900','Bombardier CRJ-900',90,2956,828,2042,1585,0.022,0.027,'M',46300000,4,2,'Aircraft_Bombardier_CRJ-900.png'),
    (45,'British Aerospace','Jetstream 41','British Aerospace Jetstream 41',29,1482,547,1372,1097,0.018,0.023,'L',8500000,1,2,'Aircraft_British-Aerospace_Jetstream-41_.png'),
    (46,'COMAC','C909','COMAC C909 (ARJ21)',95,3704,828,1850,1600,0.023,0.029,'M',38000000,5,2,'Aircraft_Comac_909.png'),
    (47,'COMAC','C919','COMAC C919',174,5555,834,2200,1700,0.024,0.030,'M',99000000,8,2,'Aircraft_Comac_919.png'),
    (48,'De Havilland','DHC-8-300','De Havilland DHC-8-300',56,1558,528,1372,1128,0.016,0.020,'M',17500000,1,2,'Aircraft_DeHavilland_DHC-8-300.png'),
    (49,'De Havilland','DHC-8-400','De Havilland DHC-8-400',90,2040,667,1425,1189,0.017,0.021,'M',32700000,2,2,'Aircraft_DeHavilland_DHC-8-400.png'),
    (50,'Dornier','328-100','Dornier 328-100',33,1667,620,1280,1036,0.017,0.021,'L',10800000,1,2,'Aircraft_Dornier_328-100.png'),
    (51,'Dornier','328 JET','Dornier 328 JET',34,1852,750,1372,1128,0.018,0.022,'M',14000000,2,2,'Aircraft_Dornier_328-JET.png'),
    (52,'Embraer','EMB 120','Embraer EMB 120 Brasilia',30,1482,555,1280,1036,0.016,0.020,'L',8000000,1,2,'Aircraft_Embrear_120.png'),
    (53,'Embraer','ERJ 135','Embraer ERJ 135',37,3241,834,1905,1372,0.019,0.024,'M',18500000,2,2,'Aircraft_Embrear_135.png'),
    (54,'Embraer','ERJ 140','Embraer ERJ 140',44,2963,834,2012,1402,0.020,0.025,'M',21500000,2,2,'Aircraft_Embrear_140.png'),
    (55,'Embraer','ERJ 145','Embraer ERJ 145',50,2871,834,2042,1433,0.021,0.026,'M',29900000,3,2,'Aircraft_Embrear_145.png'),
    (56,'Embraer','E190','Embraer E190',114,4537,829,1693,1350,0.023,0.029,'M',51300000,5,2,'Aircraft_Embrear_190.png'),
    (57,'Embraer','E195','Embraer E195',124,4074,829,1788,1400,0.024,0.030,'M',53000000,6,2,'Aircraft_Embrear_195.png'),
    (58,'Saab','340','Saab 340',36,1735,522,1200,975,0.015,0.019,'L',7500000,1,2,'Aircraft_Saab_Saab-340.png'),
    (59,'Sukhoi','Superjet 100','Sukhoi Superjet 100',108,4578,828,2052,1680,0.022,0.028,'M',36000000,5,2,'Aircraft_Suchoi_Superjet-100.png'),
    (60,'Airbus','A350-900 ULR','Airbus A350-900 ULR',440,18000,903,3000,2200,0.033,0.043,'H',370000000,14,2,'Aircraft_Airbus_350-900.png'),
    (61,'Boeing','777-200LR','Boeing 777-200LR',440,17370,892,3050,2100,0.036,0.046,'H',360000000,13,2,'Aircraft_Boeing_777-200.png')
    ON CONFLICT (id) DO NOTHING
  `, null, 'aircraft_types seed');
  await safeQuery(`SELECT setval('aircraft_types_id_seq', COALESCE((SELECT MAX(id) FROM aircraft_types), 1))`, null, 'setval at');

  // ── SEED cabin profiles (IDs 36-152) ─────────────────────────────────────────
  await safeQuery(`
    INSERT INTO cabin_profiles (id, name, aircraft_type_id, economy_seats, business_seats, first_seats) VALUES
    (36,'All Economy',15,160,0,0),(37,'Mixed',15,136,24,0),(38,'Two Class',15,120,28,12),
    (39,'All Economy',16,406,0,0),(40,'Two Class',16,300,70,36),(41,'Three Class',16,250,90,66),
    (42,'All Economy',17,440,0,0),(43,'Two Class',17,320,80,40),(44,'Three Class',17,270,100,70),
    (45,'All Economy',18,406,0,0),(46,'Two Class',18,300,70,36),(47,'Three Class',18,250,90,66),
    (48,'All Economy',19,440,0,0),(49,'Two Class',19,320,80,40),(50,'Three Class',19,270,100,70),
    (51,'All Economy',20,440,0,0),(52,'Two Class',20,320,80,40),(53,'Three Class',20,270,100,70),
    (54,'All Economy',21,375,0,0),(55,'Two Class',21,275,65,35),(56,'Three Class',21,225,85,65),
    (57,'All Economy',22,475,0,0),(58,'Two Class',22,350,85,40),(59,'Three Class',22,290,110,75),
    (60,'All Economy',23,440,0,0),(61,'Two Class',23,320,80,40),(62,'Three Class',23,265,100,75),
    (63,'All Economy',24,480,0,0),(64,'Two Class',24,350,90,40),(65,'Three Class',24,290,110,80),
    (66,'All Economy',25,50,0,0),(67,'Mixed',25,42,8,0),
    (68,'All Economy',26,78,0,0),(69,'Mixed',26,66,12,0),
    (70,'All Economy',27,112,0,0),(71,'Mixed',27,94,18,0),(72,'Two Class',27,84,22,6),
    (73,'All Economy',28,210,0,0),(74,'Mixed',28,174,36,0),(75,'Two Class',28,160,38,12),
    (76,'All Economy',29,230,0,0),(77,'Mixed',29,190,40,0),(78,'Two Class',29,175,43,12),
    (79,'All Economy',30,149,0,0),(80,'Mixed',30,125,24,0),(81,'Two Class',30,110,27,12),
    (82,'All Economy',31,188,0,0),(83,'Mixed',31,158,30,0),(84,'Two Class',31,145,33,10),
    (85,'All Economy',32,132,0,0),(86,'Mixed',32,110,22,0),
    (87,'All Economy',33,132,0,0),(88,'Mixed',33,110,22,0),
    (89,'All Economy',34,189,0,0),(90,'Mixed',34,159,30,0),(91,'Two Class',34,148,33,8),
    (92,'All Economy',35,660,0,0),(93,'Two Class',35,480,140,40),(94,'Three Class',35,400,160,100),
    (95,'All Economy',36,660,0,0),(96,'Two Class',36,480,140,40),(97,'Three Class',36,400,160,100),
    (98,'All Economy',37,239,0,0),(99,'Mixed',37,195,44,0),(100,'Two Class',37,178,49,12),
    (101,'All Economy',38,289,0,0),(102,'Mixed',38,235,54,0),(103,'Two Class',38,220,57,12),
    (104,'All Economy',39,440,0,0),(105,'Two Class',39,320,80,40),(106,'Three Class',39,270,100,70),
    (107,'All Economy',40,406,0,0),(108,'Two Class',40,300,70,36),(109,'Three Class',40,250,90,66),
    (110,'All Economy',41,440,0,0),(111,'Two Class',41,320,80,40),(112,'Three Class',41,270,100,70),
    (113,'All Economy',42,50,0,0),(114,'Mixed',42,44,6,0),
    (115,'All Economy',43,78,0,0),(116,'Mixed',43,64,14,0),
    (117,'All Economy',44,90,0,0),(118,'Mixed',44,74,16,0),
    (119,'All Economy',45,29,0,0),
    (120,'All Economy',46,95,0,0),(121,'Mixed',46,79,16,0),
    (122,'All Economy',47,174,0,0),(123,'Mixed',47,148,26,0),(124,'Two Class',47,134,28,12),
    (125,'All Economy',48,56,0,0),(126,'Mixed',48,48,8,0),
    (127,'All Economy',49,90,0,0),(128,'Mixed',49,76,14,0),
    (129,'All Economy',50,33,0,0),
    (130,'All Economy',51,34,0,0),
    (131,'All Economy',52,30,0,0),
    (132,'All Economy',53,37,0,0),
    (133,'All Economy',54,44,0,0),(134,'Mixed',54,38,6,0),
    (135,'All Economy',55,50,0,0),(136,'Mixed',55,44,6,0),
    (137,'All Economy',56,114,0,0),(138,'Mixed',56,96,18,0),(139,'Two Class',56,86,22,6),
    (140,'All Economy',57,124,0,0),(141,'Mixed',57,104,20,0),(142,'Two Class',57,94,24,6),
    (143,'All Economy',58,36,0,0),
    (144,'All Economy',59,108,0,0),(145,'Mixed',59,90,18,0),(146,'Two Class',59,80,22,6),
    (147,'All Economy',60,440,0,0),(148,'Two Class',60,320,80,40),(149,'Three Class',60,265,100,75),
    (150,'All Economy',61,440,0,0),(151,'Two Class',61,320,80,40),(152,'Three Class',61,265,100,75)
    ON CONFLICT (id) DO NOTHING
  `, null, 'cabin_profiles seed');
  await safeQuery(`SELECT setval('cabin_profiles_id_seq', COALESCE((SELECT MAX(id) FROM cabin_profiles), 1))`, null, 'setval cp');

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
    ["UPDATE aircraft_types SET required_level=11 WHERE full_name IN ('Airbus A330-200','Airbus A330-300','Airbus A330-800 Neo','Airbus A330-900 Neo')"],
    ["UPDATE aircraft_types SET required_level=12 WHERE full_name IN ('Airbus A340-300','Airbus A340-500','Airbus A340-600','Boeing 787-8')"],
    ["UPDATE aircraft_types SET required_level=13 WHERE full_name IN ('Airbus A350-900','Boeing 787-9','Boeing 787-10','Boeing 777-200','Boeing 777-200LR')"],
    ["UPDATE aircraft_types SET required_level=14 WHERE full_name IN ('Boeing 747-300','Boeing 777-300','Airbus A350-1000','Airbus A350-900 ULR')"],
    ["UPDATE aircraft_types SET required_level=15 WHERE full_name IN ('Boeing 747-400','Airbus A380')"],
  ];
  await runStatements(fuelCorrections.map(([s]) => s), 'data fixes');

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

  // ── AIRPORT FEE SEED ──────────────────────────────────────────────────────────
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

  // ── AUTO-SET active_airline_id for existing users ────────────────────────────
  await safeQuery(`
    UPDATE users
    SET active_airline_id = (
      SELECT id FROM airlines WHERE user_id = users.id ORDER BY id LIMIT 1
    )
    WHERE active_airline_id IS NULL
      AND EXISTS (SELECT 1 FROM airlines WHERE user_id = users.id)
  `, null, 'active airline');

  console.log('✅ Schema and seed data applied');
}

// No-op for backwards compatibility — PostgreSQL doesn't need file persistence
function saveDatabase() {}

// Returns pool for any legacy code that might use it
function getDatabase() {
  return pool;
}

export { initDatabase, saveDatabase, getDatabase };
