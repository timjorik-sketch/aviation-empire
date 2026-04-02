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
    console.log('✅ Database created');
  }

  // Enable foreign key enforcement (required for ON DELETE CASCADE to work)
  db.exec('PRAGMA foreign_keys = ON');

  // Always run schema (uses IF NOT EXISTS and INSERT OR IGNORE)
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(schema);

  // Run ALTER TABLE migrations (columns may already exist)
  const migrations = [
    'ALTER TABLE flights ADD COLUMN service_profile_id INTEGER REFERENCES service_profiles(id)',
    'ALTER TABLE aircraft ADD COLUMN active INTEGER DEFAULT 1',
    'ALTER TABLE aircraft ADD COLUMN is_active INTEGER DEFAULT 0',
    'ALTER TABLE aircraft ADD COLUMN cabin_profile_id INTEGER REFERENCES cabin_profiles(id)',
    'ALTER TABLE flights ADD COLUMN booked_economy INTEGER DEFAULT 0',
    'ALTER TABLE flights ADD COLUMN booked_business INTEGER DEFAULT 0',
    'ALTER TABLE flights ADD COLUMN booked_first INTEGER DEFAULT 0',
    'ALTER TABLE flights ADD COLUMN economy_price REAL',
    'ALTER TABLE flights ADD COLUMN business_price REAL',
    'ALTER TABLE flights ADD COLUMN first_price REAL',
    // Weekly schedule template pricing & route
    'ALTER TABLE weekly_schedule ADD COLUMN economy_price REAL',
    'ALTER TABLE weekly_schedule ADD COLUMN business_price REAL',
    'ALTER TABLE weekly_schedule ADD COLUMN first_price REAL',
    'ALTER TABLE weekly_schedule ADD COLUMN route_id INTEGER REFERENCES routes(id)',
    // Maintenance template columns
    'ALTER TABLE maintenance_schedule ADD COLUMN day_of_week INTEGER',
    'ALTER TABLE maintenance_schedule ADD COLUMN start_minutes INTEGER',
    'ALTER TABLE maintenance_schedule ADD COLUMN duration_minutes INTEGER',
    // Route pricing columns
    'ALTER TABLE routes ADD COLUMN economy_price REAL',
    'ALTER TABLE routes ADD COLUMN business_price REAL',
    'ALTER TABLE routes ADD COLUMN first_price REAL',
    // Multi-airline support
    'ALTER TABLE users ADD COLUMN active_airline_id INTEGER REFERENCES airlines(id)',
    // Service profile on schedule entries
    'ALTER TABLE weekly_schedule ADD COLUMN service_profile_id INTEGER REFERENCES airline_service_profiles(id)',
    // Airport fees
    'ALTER TABLE airports ADD COLUMN landing_fee_light REAL DEFAULT 500',
    'ALTER TABLE airports ADD COLUMN landing_fee_medium REAL DEFAULT 1500',
    'ALTER TABLE airports ADD COLUMN landing_fee_heavy REAL DEFAULT 5000',
    'ALTER TABLE airports ADD COLUMN ground_handling_fee REAL DEFAULT 1000',
    // Ground handling fees by wake category
    'ALTER TABLE airports ADD COLUMN ground_handling_fee_light REAL DEFAULT 400',
    'ALTER TABLE airports ADD COLUMN ground_handling_fee_medium REAL DEFAULT 650',
    'ALTER TABLE airports ADD COLUMN ground_handling_fee_heavy REAL DEFAULT 950',
    // User-defined cabin profile assignment
    'ALTER TABLE aircraft ADD COLUMN airline_cabin_profile_id INTEGER REFERENCES airline_cabin_profiles(id)',
    // Airport metadata
    'ALTER TABLE airports ADD COLUMN category INTEGER DEFAULT 4',
    'ALTER TABLE airports ADD COLUMN continent TEXT',
    'ALTER TABLE airports ADD COLUMN state TEXT',
    'ALTER TABLE airports ADD COLUMN runway_length_m INTEGER DEFAULT 2500',
    'ALTER TABLE airports ADD COLUMN latitude REAL',
    'ALTER TABLE airports ADD COLUMN longitude REAL',
    // Flight generation: link generated flights back to weekly template
    'ALTER TABLE flights ADD COLUMN weekly_schedule_id INTEGER REFERENCES weekly_schedule(id)',
    // Physical location of aircraft (updated when flights complete)
    'ALTER TABLE aircraft ADD COLUMN current_location TEXT REFERENCES airports(iata_code)',
    'ALTER TABLE aircraft ADD COLUMN crew_assigned INTEGER DEFAULT 0',
    // Depreciation model
    'ALTER TABLE aircraft_types ADD COLUMN depreciation_age REAL DEFAULT 0.035',
    'ALTER TABLE aircraft_types ADD COLUMN depreciation_fh REAL DEFAULT 0.000006',
    'ALTER TABLE aircraft ADD COLUMN total_flight_hours REAL DEFAULT 0',
    // Consolidate fuel consumption to single column
    'ALTER TABLE aircraft_types ADD COLUMN fuel_consumption_per_km REAL DEFAULT 0.028',
    // Current location for used market listings
    'ALTER TABLE used_aircraft_market ADD COLUMN location TEXT',
    // Seller tracking for player-listed aircraft
    'ALTER TABLE used_aircraft_market ADD COLUMN seller_aircraft_id INTEGER',
    'ALTER TABLE used_aircraft_market ADD COLUMN seller_airline_id INTEGER',
    // Mark aircraft as listed for sale (stays in fleet until bought)
    'ALTER TABLE aircraft ADD COLUMN is_listed_for_sale INTEGER DEFAULT 0',
    // Track whether booking revenue has been collected upfront for a flight
    'ALTER TABLE flights ADD COLUMN booking_revenue_collected INTEGER DEFAULT 0',
    // Weekly payroll tracking
    'ALTER TABLE airlines ADD COLUMN last_payroll_at DATETIME',
    // Per-flight fuel cost (calculated at departure using live fuel price)
    'ALTER TABLE flights ADD COLUMN fuel_cost REAL DEFAULT 0',
    // Per-flight ATC fee (calculated at scheduling time from route distance)
    'ALTER TABLE flights ADD COLUMN atc_fee REAL DEFAULT 0',
    // Fuel price: migrate from kg to liter (Jet A1 density 0.8 kg/L)
    'ALTER TABLE fuel_prices ADD COLUMN price_per_liter REAL',
    // Track when maintenance was last completed (for condition restore)
    'ALTER TABLE maintenance_schedule ADD COLUMN last_completed_at DATETIME',
    // Per-flight cost breakdown for profit calculation
    'ALTER TABLE flights ADD COLUMN landing_fee REAL DEFAULT 0',
    'ALTER TABLE flights ADD COLUMN ground_handling_cost REAL DEFAULT 0',
    'ALTER TABLE flights ADD COLUMN catering_cost REAL DEFAULT 0',
    // Hidden market prices for booking demand calculation (never shown to user)
    'ALTER TABLE flights ADD COLUMN market_price_economy REAL DEFAULT 0',
    'ALTER TABLE flights ADD COLUMN market_price_business REAL DEFAULT 0',
    'ALTER TABLE flights ADD COLUMN market_price_first REAL DEFAULT 0',
    // Passenger satisfaction score (0–100) calculated at flight generation
    'ALTER TABLE flights ADD COLUMN satisfaction_score INTEGER',
    // Violated rules JSON array for customer feedback display
    'ALTER TABLE flights ADD COLUMN violated_rules TEXT',
    // Type rating for cockpit/cabin crew so we can match after aircraft is sold
    'ALTER TABLE personnel ADD COLUMN type_rating TEXT',
    // Airline logo filename (stored in /public/airline-logos/)
    'ALTER TABLE airlines ADD COLUMN logo_filename TEXT',
    // Service profile coupled to route (mirrors how prices are route-scoped)
    'ALTER TABLE routes ADD COLUMN service_profile_id INTEGER REFERENCES airline_service_profiles(id)',
  ];

  // Data fixes: run after schema/migrations
  const dataFixes = [
    // ── Aircraft runway & fuel corrections ────────────────────────────────────
    "UPDATE aircraft_types SET min_runway_landing_m=1290, fuel_consumption_per_km=0.9  WHERE full_name='Saab 340'",
    "UPDATE aircraft_types SET min_runway_landing_m=1100, fuel_consumption_per_km=1.0  WHERE full_name='Dornier 328-100'",
    "UPDATE aircraft_types SET min_runway_landing_m=1100, fuel_consumption_per_km=0.9  WHERE full_name='Embraer EMB 120 Brasilia'",
    "UPDATE aircraft_types SET min_runway_landing_m=1130, fuel_consumption_per_km=0.8  WHERE full_name='British Aerospace Jetstream 41'",
    "UPDATE aircraft_types SET min_runway_landing_m=1107, fuel_consumption_per_km=1.15 WHERE full_name='ATR 42'",
    "UPDATE aircraft_types SET min_runway_landing_m=1180, fuel_consumption_per_km=1.0  WHERE full_name='De Havilland DHC-8-300'",
    "UPDATE aircraft_types SET min_runway_landing_m=1200, fuel_consumption_per_km=1.5  WHERE full_name='Dornier 328 JET'",
    "UPDATE aircraft_types SET min_runway_landing_m=1250, fuel_consumption_per_km=1.2  WHERE full_name='De Havilland DHC-8-400'",
    "UPDATE aircraft_types SET min_runway_landing_m=1350, fuel_consumption_per_km=1.7  WHERE full_name='Embraer E175-E2'",
    "UPDATE aircraft_types SET min_runway_landing_m=1333, fuel_consumption_per_km=1.5  WHERE full_name='ATR 72'",
    "UPDATE aircraft_types SET min_runway_landing_m=1380, fuel_consumption_per_km=1.8  WHERE full_name='Embraer E175'",
    "UPDATE aircraft_types SET min_runway_landing_m=1500, fuel_consumption_per_km=2.0  WHERE full_name='Embraer E190-E2'",
    "UPDATE aircraft_types SET min_runway_landing_m=1580, fuel_consumption_per_km=2.4  WHERE full_name='Embraer E190'",
    "UPDATE aircraft_types SET min_runway_landing_m=1463, fuel_consumption_per_km=2.3  WHERE full_name='Airbus A220-100'",
    "UPDATE aircraft_types SET min_runway_landing_m=1540, fuel_consumption_per_km=2.8  WHERE full_name='Avro RJ85'",
    "UPDATE aircraft_types SET min_runway_landing_m=1440, fuel_consumption_per_km=1.6  WHERE full_name='Embraer ERJ 135'",
    "UPDATE aircraft_types SET min_runway_landing_m=1560, fuel_consumption_per_km=2.1  WHERE full_name='Embraer E195-E2'",
    "UPDATE aircraft_types SET min_runway_landing_m=1850, fuel_consumption_per_km=2.9  WHERE full_name='Airbus A319'",
    "UPDATE aircraft_types SET min_runway_landing_m=1750, fuel_consumption_per_km=2.5  WHERE full_name='Airbus A319 Neo'",
    "UPDATE aircraft_types SET min_runway_landing_m=1600, fuel_consumption_per_km=2.6  WHERE full_name='Embraer E195'",
    "UPDATE aircraft_types SET min_runway_landing_m=1480, fuel_consumption_per_km=1.7  WHERE full_name='Embraer ERJ 140'",
    "UPDATE aircraft_types SET min_runway_landing_m=1520, fuel_consumption_per_km=1.8  WHERE full_name='Embraer ERJ 145'",
    "UPDATE aircraft_types SET min_runway_landing_m=1550, fuel_consumption_per_km=2.5  WHERE full_name='Airbus A220-300'",
    "UPDATE aircraft_types SET min_runway_landing_m=1690, fuel_consumption_per_km=2.8  WHERE full_name='Boeing 737-600'",
    "UPDATE aircraft_types SET min_runway_landing_m=1510, fuel_consumption_per_km=1.8  WHERE full_name='Bombardier CRJ-200'",
    "UPDATE aircraft_types SET min_runway_landing_m=2090, fuel_consumption_per_km=3.0  WHERE full_name='Airbus A320'",
    "UPDATE aircraft_types SET min_runway_landing_m=1828, fuel_consumption_per_km=2.7  WHERE full_name='Airbus A318'",
    "UPDATE aircraft_types SET min_runway_landing_m=1800, fuel_consumption_per_km=2.6  WHERE full_name='Boeing 737-8 Max'",
    "UPDATE aircraft_types SET min_runway_landing_m=1940, fuel_consumption_per_km=3.3  WHERE full_name='Boeing 737-300'",
    "UPDATE aircraft_types SET min_runway_landing_m=1830, fuel_consumption_per_km=3.0  WHERE full_name='Boeing 737-500'",
    "UPDATE aircraft_types SET min_runway_landing_m=2100, fuel_consumption_per_km=3.0  WHERE full_name='Boeing 737-800'",
    "UPDATE aircraft_types SET min_runway_landing_m=2100, fuel_consumption_per_km=3.2  WHERE full_name='Boeing 757-200'",
    "UPDATE aircraft_types SET min_runway_landing_m=1600, fuel_consumption_per_km=2.1  WHERE full_name='Bombardier CRJ-700'",
    "UPDATE aircraft_types SET min_runway_landing_m=2560, fuel_consumption_per_km=3.3  WHERE full_name='Airbus A321'",
    "UPDATE aircraft_types SET min_runway_landing_m=2300, fuel_consumption_per_km=2.8  WHERE full_name='Airbus A321 Neo'",
    "UPDATE aircraft_types SET min_runway_landing_m=2100, fuel_consumption_per_km=2.9  WHERE full_name='Boeing 737-10 Max'",
    "UPDATE aircraft_types SET min_runway_landing_m=2100, fuel_consumption_per_km=3.4  WHERE full_name='Boeing 737-400'",
    "UPDATE aircraft_types SET min_runway_landing_m=1700, fuel_consumption_per_km=2.3  WHERE full_name='Bombardier CRJ-900'",
    "UPDATE aircraft_types SET min_runway_landing_m=2600, fuel_consumption_per_km=5.4  WHERE full_name='Boeing 787-8'",
    "UPDATE aircraft_types SET min_runway_landing_m=1700, fuel_consumption_per_km=2.4  WHERE full_name='COMAC C909 (ARJ21)'",
    "UPDATE aircraft_types SET min_runway_landing_m=2400, fuel_consumption_per_km=3.4  WHERE full_name='Boeing 757-300'",
    "UPDATE aircraft_types SET min_runway_landing_m=2800, fuel_consumption_per_km=6.2  WHERE full_name='Boeing 787-9'",
    "UPDATE aircraft_types SET min_runway_landing_m=1731, fuel_consumption_per_km=2.3  WHERE full_name='Sukhoi Superjet 100'",
    "UPDATE aircraft_types SET min_runway_landing_m=2000, fuel_consumption_per_km=3.0  WHERE full_name='COMAC C919'",
    "UPDATE aircraft_types SET min_runway_landing_m=2900, fuel_consumption_per_km=6.5  WHERE full_name='Boeing 787-10'",
    "UPDATE aircraft_types SET min_runway_landing_m=2480, fuel_consumption_per_km=6.1  WHERE full_name='Airbus A350-900'",
    "UPDATE aircraft_types SET min_runway_landing_m=2500, fuel_consumption_per_km=6.8  WHERE full_name='Boeing 777-200'",
    "UPDATE aircraft_types SET min_runway_landing_m=2400, fuel_consumption_per_km=6.0  WHERE full_name='Airbus A330-200'",
    "UPDATE aircraft_types SET min_runway_landing_m=2500, fuel_consumption_per_km=6.3  WHERE full_name='Airbus A330-300'",
    "UPDATE aircraft_types SET min_runway_landing_m=2480, fuel_consumption_per_km=5.3  WHERE full_name='Airbus A330-800 Neo'",
    "UPDATE aircraft_types SET min_runway_landing_m=2600, fuel_consumption_per_km=5.6  WHERE full_name='Airbus A330-900 Neo'",
    "UPDATE aircraft_types SET min_runway_landing_m=2800, fuel_consumption_per_km=7.9  WHERE full_name='Boeing 777-300'",
    "UPDATE aircraft_types SET min_runway_landing_m=2700, fuel_consumption_per_km=6.5  WHERE full_name='Airbus A350-1000'",
    "UPDATE aircraft_types SET min_runway_landing_m=3000, fuel_consumption_per_km=12.2 WHERE full_name='Airbus A380'",
    "UPDATE aircraft_types SET min_runway_landing_m=2900, fuel_consumption_per_km=7.5  WHERE full_name='Airbus A340-300'",
    "UPDATE aircraft_types SET min_runway_landing_m=3050, fuel_consumption_per_km=8.3  WHERE full_name='Airbus A340-500'",
    "UPDATE aircraft_types SET min_runway_landing_m=3100, fuel_consumption_per_km=8.8  WHERE full_name='Airbus A340-600'",
    "UPDATE aircraft_types SET min_runway_landing_m=3000, fuel_consumption_per_km=10.5 WHERE full_name='Boeing 747-300'",
    "UPDATE aircraft_types SET min_runway_landing_m=2800, fuel_consumption_per_km=7.6  WHERE full_name='Boeing 777-200LR'",
    "UPDATE aircraft_types SET min_runway_landing_m=3050, fuel_consumption_per_km=11.7 WHERE full_name='Boeing 747-400'",
    "UPDATE aircraft_types SET min_runway_landing_m=2700, fuel_consumption_per_km=7.2  WHERE full_name='Airbus A350-900 ULR'",
    // ── Aircraft list price corrections ───────────────────────────────────────
    "UPDATE aircraft_types SET list_price=320000000 WHERE full_name='Boeing 777-300'",
    "UPDATE aircraft_types SET list_price=23000000  WHERE full_name='Embraer ERJ 145'",
    "UPDATE aircraft_types SET list_price=41000000  WHERE full_name='Bombardier CRJ-700'",
    "UPDATE aircraft_types SET list_price=50000000  WHERE full_name='Boeing 737-500'",
    // ── End aircraft corrections ───────────────────────────────────────────────
    // Clear old-format satisfaction scores (no violated_rules column) so new system recalculates them
    "UPDATE flights SET satisfaction_score = NULL WHERE satisfaction_score IS NOT NULL AND violated_rules IS NULL",
    // Remove J category — reclassify A380 (and any other J aircraft) as H
    "UPDATE aircraft_types SET wake_turbulence_category = 'H' WHERE wake_turbulence_category = 'J'",
    // One-time migration: seed is_active from active for all existing aircraft that have never been activated
    "UPDATE aircraft SET is_active = 1 WHERE active = 1 AND NOT EXISTS (SELECT 1 FROM aircraft WHERE is_active = 1 LIMIT 1)",
    // Convert fuel_consumption_per_km from L/km to kg/km (×100). Guard: only runs while values are still in old units (<1)
    "UPDATE aircraft_types SET fuel_consumption_per_km = fuel_consumption_full_per_km * 100 WHERE fuel_consumption_per_km < 1",
    // Initialize current_location from home_airport for existing aircraft
    "UPDATE aircraft SET current_location = home_airport WHERE current_location IS NULL AND home_airport IS NOT NULL",
    // Migrate existing kg prices to liter (×0.8)
    "UPDATE fuel_prices SET price_per_liter = ROUND(price_per_kg * 0.8, 2) WHERE price_per_liter IS NULL",
    // Seed initial fuel price if none exists (0.80 $/kg)
    "INSERT INTO fuel_prices (price_per_liter) SELECT 0.80 WHERE NOT EXISTS (SELECT 1 FROM fuel_prices)",
    // Normalize existing $/L prices to $/kg (multiply by 1.25) — runs once when old data exists
    "UPDATE fuel_prices SET price_per_liter = ROUND(price_per_liter * 1.25, 2) WHERE price_per_liter < 0.20",
    // Spec corrections based on official manufacturer data
    "UPDATE aircraft_types SET max_passengers=48, range_km=1302, min_runway_landing_m=1107 WHERE full_name='ATR 42'",
    "UPDATE aircraft_types SET max_passengers=72, range_km=1403, cruise_speed_kmh=510, min_runway_landing_m=1279 WHERE full_name='ATR 72'",
    "UPDATE aircraft_types SET cruise_speed_kmh=828 WHERE full_name IN ('Airbus A318','Airbus A320','Airbus A321','Airbus A321 Neo','Airbus A319 Neo')",
    "UPDATE aircraft_types SET cruise_speed_kmh=871 WHERE full_name IN ('Airbus A220-100','Airbus A220-300')",
    // Cleanup: remove orphaned airlines whose user no longer exists (cascade deletes all dependent data)
    "DELETE FROM airlines WHERE user_id NOT IN (SELECT id FROM users)",
    // Backward compat: auto-open home bases for existing airlines
    "INSERT OR IGNORE INTO airline_destinations (airline_id, airport_code, destination_type) SELECT id, home_airport_code, 'home_base' FROM airlines",
    // Auto-open departure airports from existing routes
    "INSERT OR IGNORE INTO airline_destinations (airline_id, airport_code, destination_type) SELECT DISTINCT r.airline_id, r.departure_airport, 'destination' FROM routes r WHERE r.departure_airport NOT IN (SELECT airport_code FROM airline_destinations WHERE airline_id = r.airline_id)",
    // Auto-open arrival airports from existing routes
    "INSERT OR IGNORE INTO airline_destinations (airline_id, airport_code, destination_type) SELECT DISTINCT r.airline_id, r.arrival_airport, 'destination' FROM routes r WHERE r.arrival_airport NOT IN (SELECT airport_code FROM airline_destinations WHERE airline_id = r.airline_id)",
    // ── 15-level aircraft progression ──────────────────────────────────────────
    // Level 1: turboprops & small regionals
    "UPDATE aircraft_types SET required_level = 1 WHERE id IN (25,26,48,49,58,45,50,51,52)",
    // Level 2: small regional jets
    "UPDATE aircraft_types SET required_level = 2 WHERE id IN (53,54,55,42)",
    // Level 3: mid regional jets
    "UPDATE aircraft_types SET required_level = 3 WHERE id IN (1,56,57,43,44)",
    // Level 4: E-Jet E2 & Avro/Superjet
    "UPDATE aircraft_types SET required_level = 4 WHERE id IN (2,3,4,27,59)",
    // Level 5: A220 family, 737 classics, C909
    "UPDATE aircraft_types SET required_level = 5 WHERE id IN (5,6,30,31,32,46)",
    // Level 6: A318/A319, 757-200
    "UPDATE aircraft_types SET required_level = 6 WHERE id IN (7,8,37)",
    // Level 7: 737 NG, A320
    "UPDATE aircraft_types SET required_level = 7 WHERE id IN (33,34,9)",
    // Level 8: A321, 737 MAX, Neo family, C919
    "UPDATE aircraft_types SET required_level = 8 WHERE id IN (10,28,29,15,11,47)",
    // Level 9: 757-300
    "UPDATE aircraft_types SET required_level = 9 WHERE id IN (38)",
    // Level 10: A330, 787-8
    "UPDATE aircraft_types SET required_level = 10 WHERE id IN (16,17,12)",
    // Level 11: 777-200/300, 787-9, A330neo
    "UPDATE aircraft_types SET required_level = 11 WHERE id IN (39,13,40,18,19)",
    // Level 12: A350-900, 787-10
    "UPDATE aircraft_types SET required_level = 12 WHERE id IN (23,41)",
    // Level 13: A350-1000, A340-500/600
    "UPDATE aircraft_types SET required_level = 13 WHERE id IN (24,21,22)",
    // Level 14: 747-400, A340-300
    "UPDATE aircraft_types SET required_level = 14 WHERE id IN (36,20)",
    // Level 15: A380, 747-300
    "UPDATE aircraft_types SET required_level = 15 WHERE id IN (14,35)",
    // New airport batch (INSERT OR IGNORE — skip if IATA already present)
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('GZT','Gaziantep Airport','Turkey','TC',4,'Asia',3000,36.9472,37.4787)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('GZP','Gazipasa Alanya Airport','Turkey','TC',3,'Asia',3000,36.2993,32.3006)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('GES','General Santos International Airport','Philippines','RP',3,'Asia',3000,6.058,125.0958)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('GIL','Gilgit Airport','Pakistan','AP',1,'Asia',1676,35.9188,74.3336)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('GOI','Goa Dabolim International Airport','India','VT',4,'Asia',3294,15.3808,73.8314)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('GOQ','Golmud Airport','China','B',2,'Asia',3600,36.4006,94.7858)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('GMQ','Golog Maqin Airport','China','B',2,'Asia',4000,34.4181,100.3014)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('GBT','Gorgan Airport','Iran','EP',3,'Asia',2800,36.9094,54.4013)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('GKA','Goroka Airport','Papua New Guinea','P2',2,'Oceania',1670,-6.0816,145.3919)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('GTO','Jalaluddin Airport','Indonesia','PK',2,'Asia',2450,0.6378,122.8498)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('FUJ','Fukue Airport','Japan','JA',2,'Asia',1500,32.6663,128.8328)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('GYS','Guangyuan Panlong Airport','China','B',3,'Asia',3200,32.3911,105.7022)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('CAN','Guangzhou Baiyun International Airport','China','B',7,'Asia',3800,23.3924,113.299)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KWL','Guilin Liangjiang International Airport','China','B',4,'Asia',3200,25.2181,110.0394)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KWE','Guiyang Longdongbao International Airport','China','B',5,'Asia',3600,26.5386,106.8017)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KUV','Gunsan Airport','South Korea','HL',2,'Asia',2744,35.9038,126.6158)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('URY','Gurayat Domestic Airport','Saudi Arabia','HZ',2,'Asia',3600,31.7123,37.2797)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('GUR','Gurney Airport','Papua New Guinea','P2',2,'Oceania',1900,-10.3115,150.3339)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('GAU','Guwahati Lokpriya Gopinath Bordoloi International Airport','India','VT',4,'Asia',2743,26.1061,91.5858)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('GYU','Guyuan Liupanshan Airport','China','B',2,'Asia',3600,36.0786,106.2169)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KWJ','Gwangju Airport','South Korea','HL',3,'Asia',2835,35.1236,126.8089)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KVD','Ganja Airport','Azerbaijan','4K',3,'Asia',3000,40.7377,46.3176)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('LWN','Gyumri Shirak Airport','Armenia','EK',3,'Asia',2700,40.7503,43.8593)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HAS','Hail Regional Airport','Saudi Arabia','HZ',3,'Asia',4000,27.4379,41.6863)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HAC','Hachijojima Airport','Japan','JA',2,'Asia',1500,33.115,139.7858)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HPH','Cat Bi International Airport','Vietnam','VN',4,'Asia',3200,20.8194,106.7247)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HFA','Haifa Airport','Israel','4X',2,'Asia',1200,32.8094,35.0431)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HAK','Haikou Meilan International Airport','China','B',5,'Asia',3600,19.935,110.4589)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HKD','Hakodate Airport','Japan','JA',3,'Asia',3000,41.77,140.8222)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HMI','Hami Airport','China','B',3,'Asia',3600,42.8414,93.6692)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HNA','Hanamaki Airport','Japan','JA',2,'Asia',2500,39.4286,141.1353)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HDB','Handan Airport','China','B',3,'Asia',3200,36.5258,114.4253)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HGH','Hangzhou Xiaoshan International Airport','China','B',5,'Asia',3600,30.2295,120.4339)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HAN','Noi Bai International Airport','Vietnam','VN',5,'Asia',4000,21.2212,105.8072)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HZG','Hanzhong Chenggu Airport','China','B',2,'Asia',2800,33.0636,107.0081)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HRB','Harbin Taiping International Airport','China','B',5,'Asia',3400,45.6234,126.2503)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HDY','Hat Yai International Airport','Thailand','HS',4,'Asia',3050,6.9332,100.3928)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HCJ','Hechi Jinchengjiang Airport','China','B',3,'Asia',3200,24.8056,107.6997)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HFE','Hefei Luogang Airport','China','B',4,'Asia',3200,31.78,117.2983)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HEH','Heho Airport','Myanmar','XY',2,'Asia',2000,20.747,96.7919)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HEK','Heihe Aihui Airport','China','B',2,'Asia',3200,50.1717,127.4489)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HNY','Hengyang Nanyue Airport','China','B',3,'Asia',3200,26.9053,112.6278)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HEA','Herat International Airport','Afghanistan','YA',3,'Asia',2900,34.21,62.2283)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HIJ','Hiroshima Airport','Japan','JA',4,'Asia',2500,34.4361,132.9194)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('SGN','Tan Son Nhat International Airport','Vietnam','VN',6,'Asia',3800,10.8188,106.652)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HOF','Al-Ahsa International Airport','Saudi Arabia','HZ',3,'Asia',3600,25.2853,49.4851)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HET','Hohhot Baita International Airport','China','B',4,'Asia',3600,40.8511,111.8239)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HKG','Hong Kong International Airport','China','B',7,'Asia',3800,22.308,113.9185)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('AHU','Hongyuan Airport','China','B',1,'Asia',3200,32.5308,102.3525)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HGU','Mount Hagen Kagamuga Airport','Papua New Guinea','P2',3,'Oceania',2440,-5.8267,144.2958)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HTN','Hotan Airport','China','B',3,'Asia',3000,37.0386,79.8644)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HIA','Huaian Lianshui Airport','China','B',3,'Asia',3200,33.7908,119.1253)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HJJ','Huaihua Zhijiang Airport','China','B',2,'Asia',3200,27.4411,109.7006)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HUN','Hualien Airport','Taiwan','B',3,'Asia',2750,23.9741,121.6181)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('TXN','Huangshan Tunxi International Airport','China','B',3,'Asia',2800,29.7333,118.2561)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HBX','Hubli Airport','India','VT',3,'Asia',2286,15.3617,75.0849)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HUI','Hue Phu Bai International Airport','Vietnam','VN',3,'Asia',3000,16.4014,107.7028)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HUZ','Huizhou Pingtan Airport','China','B',3,'Asia',3200,23.0503,114.5997)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HLD','Hulunbuir Hailar Airport','China','B',3,'Asia',3200,49.2047,119.8247)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HYD','Hyderabad Rajiv Gandhi International Airport','India','VT',5,'Asia',4260,17.2313,78.4298)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('IBR','Ibaraki Airport','Japan','JA',3,'Asia',2700,36.1811,140.4147)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('IGT','Ignatyevo Airport','Russia','RA',3,'Asia',2680,50.4328,127.4117)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('ILO','Iloilo International Airport','Philippines','RP',3,'Asia',2600,10.833,122.4936)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('IMF','Imphal Airport','India','VT',3,'Asia',2743,24.76,93.8967)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('IDR','Devi Ahilyabai Holkar Airport','India','VT',4,'Asia',3048,22.7217,75.8011)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('IPH','Sultan Azlan Shah Airport','Malaysia','9M',3,'Asia',2470,4.5678,101.0922)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('IKT','Irkutsk Airport','Russia','RA',4,'Asia',3400,52.2681,104.3889)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('ISG','Painushima Ishigaki Airport','Japan','JA',3,'Asia',2000,24.3961,124.2414)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('ISB','Islamabad International Airport','Pakistan','AP',5,'Asia',3800,33.6167,72.8519)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('ISE','Isparta Airport','Turkey','TC',2,'Asia',2750,37.8554,30.3681)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('SAW','Sabiha Gokcen International Airport','Turkey','TC',5,'Asia',3000,40.8986,29.3092)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('IWK','Marine Corps Air Station Iwakuni','Japan','JA',3,'Asia',3000,34.1447,132.2358)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('IWJ','Iwami Airport','Japan','JA',2,'Asia',2000,34.6764,131.79)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('ADB','Adnan Menderes International Airport','Turkey','TC',5,'Asia',3240,38.2924,27.157)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('IZO','Izumo Airport','Japan','JA',2,'Asia',2000,35.4136,132.89)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('JLR','Jabalpur Airport','India','VT',2,'Asia',2286,23.1778,80.0522)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('JAI','Jaipur International Airport','India','VT',4,'Asia',2902,26.8242,75.8122)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HLP','Halim Perdanakusuma International Airport','Indonesia','PK',3,'Asia',3000,-6.2661,106.8908)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('CGK','Soekarno-Hatta International Airport','Indonesia','PK',6,'Asia',3600,-6.1256,106.6558)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('DJB','Sultan Thaha Airport','Indonesia','PK',3,'Asia',2500,-1.6381,103.6442)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('IXJ','Jammu Airport','India','VT',3,'Asia',2286,32.6891,74.8374)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('JGA','Jamnagar Airport','India','VT',3,'Asia',2440,22.4655,70.0126)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('DJJ','Sentani International Airport','Indonesia','PK',3,'Asia',2500,-2.5769,140.5164)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('JED','King Abdulaziz International Airport','Saudi Arabia','HZ',6,'Asia',4000,21.6796,39.1565)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('CJU','Jeju International Airport','South Korea','HL',5,'Asia',3180,33.5113,126.493)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('JSR','Jessore Airport','Bangladesh','S2',3,'Asia',2896,23.1839,89.1608)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('JRH','Jorhat Airport','India','VT',3,'Asia',2290,26.7315,94.175)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('JIA','Ji''an Jinggangshan Airport','China','B',3,'Asia',3200,26.8556,114.7311)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('JGD','Jiagedaqi Airport','China','B',2,'Asia',3200,50.3714,124.1172)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('JMU','Jiamusi Dongjiao Airport','China','B',3,'Asia',3200,46.8434,130.4647)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('JGN','Jiayuguan Airport','China','B',3,'Asia',3400,39.8569,98.3414)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('TNA','Jinan Yaoqiang International Airport','China','B',5,'Asia',3600,36.8572,117.2158)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('JIC','Jinchang Jinchuan Airport','China','B',2,'Asia',3200,38.5422,102.3481)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('VDZ','Jindal Vijaynagar Airport','India','VT',2,'Asia',2286,15.175,76.6333)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('JDZ','Jingdezhen Luojia Airport','China','B',3,'Asia',3200,29.3386,117.1761)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('JHG','Jinghong Airport','China','B',3,'Asia',3200,21.9739,100.76)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('JNG','Jining Qufu Airport','China','B',3,'Asia',3200,35.2925,116.3469)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('JNZ','Jinzhou Bay Airport','China','B',3,'Asia',3000,41.1014,121.0625)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('JZH','Jiuzhaigou Huanglong Airport','China','B',2,'Asia',3600,32.8533,103.6822)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('JXA','Jixi Xingkaihu Airport','China','B',2,'Asia',2800,45.2931,131.1931)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('GIZ','Jizan Regional Airport','Saudi Arabia','HZ',3,'Asia',3600,16.9011,42.5858)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('JDH','Jodhpur Airport','India','VT',3,'Asia',2874,26.2511,73.0489)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('JHB','Sultan Ismail International Airport','Malaysia','9M',4,'Asia',3300,1.6413,103.6697)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KBL','Kabul International Airport','Afghanistan','YA',4,'Asia',3400,34.5659,69.2123)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HTG','Khatanga Airport','Russia','RA',2,'Asia',2700,71.9781,102.4908)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('CDP','Kadapa Airport','India','VT',2,'Asia',1710,14.5131,78.7728)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KOJ','Kagoshima Airport','Japan','JA',3,'Asia',3000,31.8034,130.7194)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KJH','Kaili Huangping Airport','China','B',2,'Asia',3200,26.9722,107.9881)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KNG','Kaimana Utarom Airport','Indonesia','PK',2,'Asia',1200,-3.6445,133.6956)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KLO','Kalibo International Airport','Philippines','RP',3,'Asia',2000,11.6795,122.3761)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KJI','Kanas Airport','China','B',2,'Asia',3800,48.2222,86.9989)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KDH','Kandahar International Airport','Afghanistan','YA',3,'Asia',3200,31.5058,65.8478)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KGT','Kangding Airport','China','B',2,'Asia',4200,30.1428,101.7314)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('CNN2','Kannur International Airport','India','VT',3,'Asia',3050,11.9186,75.5472)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KNU','Kanpur Airport','India','VT',2,'Asia',2286,26.4044,80.365)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KHH','Kaohsiung International Airport','Taiwan','B',4,'Asia',3150,22.5771,120.3497)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KHI','Jinnah International Airport','Pakistan','AP',5,'Asia',3200,24.9065,67.1608)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KGF','Karaganda Sary-Arka Airport','Kazakhstan','UP',3,'Asia',3000,49.6708,73.3344)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KRY','Karamay Airport','China','B',2,'Asia',3200,45.4656,84.9528)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('CCJ','Calicut International Airport','India','VT',4,'Asia',2860,11.1368,75.9553)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KYS','Kars Airport','Turkey','TC',3,'Asia',3500,40.5622,43.115)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KHG','Kashgar Airport','China','B',3,'Asia',3500,39.5425,76.02)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KFS','Kastamonu Airport','Turkey','TC',2,'Asia',2000,41.3142,33.7958)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KTM','Tribhuvan International Airport','Nepal','9N',4,'Asia',3050,27.6966,85.3591)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KVG','Kavieng Airport','Papua New Guinea','P2',2,'Oceania',1500,-2.5794,150.8081)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('ASR','Kayseri Airport','Turkey','TC',3,'Asia',3500,38.7703,35.4953)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('RDP','Kazi Nazrul Islam Airport','India','VT',3,'Asia',2750,23.6236,87.2436)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KEJ','Kemerovo Airport','Russia','RA',3,'Asia',3600,55.27,86.1072)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KMA','Kerema Airport','Papua New Guinea','P2',1,'Oceania',1100,-7.9636,145.7706)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KER','Kerman Airport','Iran','EP',3,'Asia',3200,30.2744,56.9511)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KSH','Kermanshah Airport','Iran','EP',3,'Asia',3100,34.3459,47.1581)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KHV','Khabarovsk Novy Airport','Russia','RA',4,'Asia',4000,48.528,135.1883)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('UGT','Khanbumbat Airport','Mongolia','JU',2,'Asia',3200,43.15,107.25)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('HMA','Khanty Mansiysk Airport','Russia','RA',3,'Asia',2600,60.9269,69.0861)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KHS','Khasab Airport','Oman','A4O',2,'Asia',1800,26.171,56.2406)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KKC','Khon Kaen Airport','Thailand','HS',3,'Asia',3000,16.4667,102.7836)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KKX','Kikai Airport','Japan','JA',1,'Asia',1500,28.3213,129.9283)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KNH','Kinmen Airport','Taiwan','B',2,'Asia',1500,24.4278,118.3594)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KIH','Kish Island Airport','Iran','EP',3,'Asia',3200,26.5261,53.9803)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('ONJ','Odate Noshiro Airport','Japan','JA',2,'Asia',2000,40.1919,140.3711)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('UKB','Kobe Airport','Japan','JA',3,'Asia',2500,34.6328,135.2239)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KCZ','Kochi Airport','Japan','JA',3,'Asia',2500,33.5461,133.6694)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KGP','Kogalym International Airport','Russia','RA',2,'Asia',2500,62.1897,74.5344)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KTK','Kitaakita Airport','Japan','JA',2,'Asia',2000,40.2128,140.4056)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KKJ','Kitakyushu Airport','Japan','JA',3,'Asia',2500,33.846,131.035)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KLH','Kolhapur Airport','India','VT',2,'Asia',1380,16.6647,74.2894)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('CCU','Kolkata Netaji Subhash Chandra Bose International Airport','India','VT',5,'Asia',3627,22.6547,88.4467)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KMQ','Komatsu Airport','Japan','JA',3,'Asia',2700,36.3946,136.4067)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KYA','Konya Airport','Turkey','TC',3,'Asia',3400,37.979,32.5619)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KDO','Kooddoo Airport','Maldives','8Q',2,'Asia',1200,0.5328,73.4667)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KRL','Korla Airport','China','B',3,'Asia',3400,41.6978,86.1289)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KBR','Sultan Ismail Petra Airport','Malaysia','9M',3,'Asia',2650,6.1669,102.2928)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('BKI','Kota Kinabalu International Airport','Malaysia','9M',5,'Asia',3780,5.9372,116.0508)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KBV','Krabi Airport','Thailand','HS',4,'Asia',3000,8.0992,98.9861)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KJA','Krasnoyarsk Yemelyanovo International Airport','Russia','RA',4,'Asia',3700,56.1731,92.4936)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('SZB','Sultan Abdul Aziz Shah Airport','Malaysia','9M',3,'Asia',3780,3.1306,101.5492)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KUL','Kuala Lumpur International Airport','Malaysia','9M',6,'Asia',4000,2.7456,101.71)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('TGG','Sultan Mahmud Airport','Malaysia','9M',3,'Asia',2741,5.3826,103.1033)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KNO','Kualanamu International Airport','Indonesia','PK',5,'Asia',3750,3.6422,98.8853)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KUA','Sultan Haji Ahmad Shah Airport','Malaysia','9M',3,'Asia',2440,3.7753,103.2092)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KCH','Kuching International Airport','Malaysia','9M',4,'Asia',3780,1.4847,110.3469)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KUU','Kullu Manali Airport','India','VT',1,'Asia',1372,31.8767,77.1544)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KMJ','Kumamoto Airport','Japan','JA',3,'Asia',3000,32.8372,130.8553)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('UEO','Kumejima Airport','Japan','JA',2,'Asia',2000,26.3636,126.7136)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KMG','Kunming Changshui International Airport','China','B',5,'Asia',4500,25.1019,102.9292)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KOE','El Tari International Airport','Indonesia','PK',3,'Asia',2500,-10.1717,123.6706)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KCA','Kuqa Qiuci Airport','China','B',3,'Asia',3200,41.7181,82.9869)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KRO','Kurgan Airport','Russia','RA',2,'Asia',2200,55.4753,65.4156)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KUH','Kushiro Airport','Japan','JA',3,'Asia',2500,43.0411,144.1928)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KZR','Zafer Airport','Turkey','TC',3,'Asia',3000,39.1131,30.1281)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('KWI','Kuwait International Airport','Kuwait','9K',5,'Asia',3400,29.2267,47.9689)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('LBU','Labuan Airport','Malaysia','9M',2,'Asia',1900,5.3006,115.25)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('LAE','Nadzab Airport','Papua New Guinea','P2',3,'Oceania',2682,-6.57,146.7261)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('LDU','Lahad Datu Airport','Malaysia','9M',2,'Asia',1800,5.0322,118.3242)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('LHE','Allama Iqbal International Airport','Pakistan','AP',5,'Asia',3400,31.5216,74.4036)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('LNJ','Lancang Jingmai Airport','China','B',2,'Asia',3200,22.4158,99.7864)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('LGK','Langkawi International Airport','Malaysia','9M',3,'Asia',3300,6.3297,99.7286)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('LHW','Lanzhou Zhongchuan International Airport','China','B',4,'Asia',3600,36.5153,103.6208)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('LAO','Laoag International Airport','Philippines','RP',3,'Asia',2600,18.1781,120.5314)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('LRR','Larestan International Airport','Iran','EP',3,'Asia',3200,27.6747,54.3833)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('LGP','Legazpi Airport','Philippines','RP',3,'Asia',2077,13.1575,123.7353)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('IXL','Leh Kushok Bakula Rimpochee Airport','India','VT',2,'Asia',3444,34.1359,77.5465)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('LXA','Lhasa Gonggar Airport','China','B',3,'Asia',5500,29.2978,90.9119)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('LYG','Lianyungang Baitabu Airport','China','B',3,'Asia',3200,34.5719,119.1231)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('LLB','Libo Airport','China','B',2,'Asia',3200,25.4525,107.9611)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('LJG','Lijiang Airport','China','B',3,'Asia',3600,26.6803,100.2461)",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('LMN','Limbang Airport','Malaysia','9M',2,'Asia',1300,4.8083,115.0103)",
    // Rename destination types: 'mega_hub' → 'hub', 'hub' → 'base'
    "UPDATE airline_destinations SET destination_type = 'hub' WHERE destination_type = 'mega_hub'",
    // Backfill type_rating for existing cockpit/cabin crew where aircraft still exists
    `UPDATE personnel SET type_rating = (
       SELECT at.manufacturer || ' ' || at.model
       FROM aircraft ac JOIN aircraft_types at ON at.id = ac.aircraft_type_id
       WHERE ac.id = personnel.aircraft_id
     ) WHERE staff_type IN ('cockpit','cabin') AND type_rating IS NULL AND aircraft_id IS NOT NULL`,
    // Fix placeholder IATA codes — delete old rows, then insert with correct codes
    "DELETE FROM airports WHERE iata_code = 'ORD2'",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('OMR','Oradea International Airport','Romania','YR',2,'Europe',2500,47.0253,21.9025)",
    "DELETE FROM airports WHERE iata_code = 'ISP2'",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('JBQ','La Isabela International Airport','Dominican Republic','HI',3,'North America',2500,18.5750,-69.9859)",
    "DELETE FROM airports WHERE iata_code = 'PIR2'",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('QHB','Pedro Morganti Airport','Brazil','PP',1,'South America',1200,-22.7115,-47.6182)",
    "DELETE FROM airports WHERE iata_code = 'SIN2'",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('GPS','Seymour Baltra Airport','Ecuador','HC',2,'South America',2400,-0.4538,-90.2659)",
    "DELETE FROM airports WHERE iata_code = 'SNS2'",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('SCY','San Cristobal Airport','Ecuador','HC',1,'South America',1905,-0.9102,-89.6174)",
    "DELETE FROM airports WHERE iata_code = 'BHC2'",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('BRC','Teniente Luis Candelaria Airport','Argentina','LV',3,'South America',2348,-41.1511,-71.1578)",
    "DELETE FROM airports WHERE iata_code = 'SCA2'",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('QSC','Sao Carlos Airport','Brazil','PP',1,'South America',1400,-21.8756,-47.9033)",
    "DELETE FROM airports WHERE iata_code = 'SAP2'",
    "INSERT OR IGNORE INTO airports (iata_code,name,country,registration_prefix,category,continent,runway_length_m,latitude,longitude) VALUES ('ILS','San Salvador Ilopango Airport','El Salvador','YS',2,'North America',1800,13.6994,-89.1194)",
  ];

  // Create new tables that may not exist on older DBs
  const newTables = [
    `CREATE TABLE IF NOT EXISTS service_item_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_name TEXT NOT NULL,
      category TEXT NOT NULL,
      price_per_pax REAL NOT NULL,
      sort_order INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS airline_service_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      airline_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS service_profile_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      item_type_id INTEGER NOT NULL,
      cabin_class TEXT NOT NULL CHECK(cabin_class IN ('economy', 'business', 'first')),
      FOREIGN KEY (profile_id) REFERENCES airline_service_profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (item_type_id) REFERENCES service_item_types(id),
      UNIQUE(profile_id, item_type_id, cabin_class)
    )`,
    `CREATE TABLE IF NOT EXISTS airline_cabin_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      airline_id INTEGER NOT NULL,
      aircraft_type_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE,
      FOREIGN KEY (aircraft_type_id) REFERENCES aircraft_types(id)
    )`,
    `CREATE TABLE IF NOT EXISTS airline_cabin_classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      class_type TEXT NOT NULL CHECK(class_type IN ('economy', 'business', 'first')),
      seat_type TEXT NOT NULL,
      seat_ratio REAL NOT NULL DEFAULT 1.0,
      percentage REAL NOT NULL DEFAULT 0,
      actual_capacity INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (profile_id) REFERENCES airline_cabin_profiles(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS airline_destinations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      airline_id INTEGER NOT NULL,
      airport_code TEXT NOT NULL,
      destination_type TEXT DEFAULT 'destination' CHECK(destination_type IN ('home_base', 'hub', 'base', 'destination')),
      opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE,
      FOREIGN KEY (airport_code) REFERENCES airports(iata_code),
      UNIQUE(airline_id, airport_code)
    )`,
    `CREATE TABLE IF NOT EXISTS personnel (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  airline_id INTEGER NOT NULL REFERENCES airlines(id) ON DELETE CASCADE,
  staff_type TEXT NOT NULL,
  airport_code TEXT,
  aircraft_id INTEGER REFERENCES aircraft(id) ON DELETE CASCADE,
  count INTEGER NOT NULL DEFAULT 0,
  weekly_wage_per_person INTEGER NOT NULL DEFAULT 0
)`,
    `CREATE TABLE IF NOT EXISTS used_aircraft_market (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  aircraft_type_id INTEGER NOT NULL REFERENCES aircraft_types(id),
  registration TEXT NOT NULL UNIQUE,
  manufactured_year INTEGER NOT NULL,
  total_flight_hours REAL NOT NULL DEFAULT 0,
  current_value REAL NOT NULL,
  listed_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`,
    `CREATE TABLE IF NOT EXISTS mega_hubs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  airline_id INTEGER NOT NULL,
  airport_code TEXT NOT NULL,
  hub_number INTEGER NOT NULL,
  category INTEGER NOT NULL,
  cost INTEGER NOT NULL,
  purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE,
  UNIQUE(airline_id, airport_code)
)`,
    `CREATE TABLE IF NOT EXISTS airport_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  airline_id INTEGER NOT NULL,
  airport_code TEXT NOT NULL,
  category INTEGER NOT NULL,
  slots_count INTEGER DEFAULT 0,
  cost_per_slot INTEGER NOT NULL,
  FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE,
  UNIQUE(airline_id, airport_code)
)`,
    `CREATE TABLE IF NOT EXISTS slot_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  airline_id INTEGER NOT NULL,
  airport_code TEXT NOT NULL,
  week_start DATE NOT NULL,
  departures_used INTEGER DEFAULT 0,
  FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE,
  UNIQUE(airline_id, airport_code, week_start)
)`,
    `CREATE TABLE IF NOT EXISTS transfer_flights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  aircraft_id INTEGER NOT NULL,
  airline_id INTEGER NOT NULL,
  departure_airport TEXT NOT NULL,
  arrival_airport TEXT NOT NULL,
  departure_time DATETIME NOT NULL,
  arrival_time DATETIME NOT NULL,
  cost REAL NOT NULL DEFAULT 500000,
  status TEXT DEFAULT 'scheduled',
  FOREIGN KEY (aircraft_id) REFERENCES aircraft(id) ON DELETE CASCADE,
  FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE
)`,
    `CREATE TABLE IF NOT EXISTS airport_expansions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  airline_id INTEGER NOT NULL,
  airport_code TEXT NOT NULL,
  expansion_level INTEGER DEFAULT 0,
  FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE,
  UNIQUE(airline_id, airport_code)
)`,
    `CREATE TABLE IF NOT EXISTS expansion_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  airline_id INTEGER NOT NULL,
  airport_code TEXT NOT NULL,
  week_start DATE NOT NULL,
  departures_used INTEGER DEFAULT 0,
  FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE,
  UNIQUE(airline_id, airport_code, week_start)
)`,
    `CREATE TABLE IF NOT EXISTS market_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  airline_id INTEGER NOT NULL,
  route_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NOT NULL,
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
  for (const t of newTables) {
    try { db.exec(t); } catch (e) { /* already exists */ }
  }

  // Migrate mega_hubs → airport_expansions (10 levels each)
  try {
    db.exec(`INSERT OR IGNORE INTO airport_expansions (airline_id, airport_code, expansion_level)
      SELECT airline_id, airport_code, 10 FROM mega_hubs`);
  } catch (e) { /* table may not exist */ }
  // Migrate airport_slots → airport_expansions (slots_count = expansion_level)
  try {
    db.exec(`INSERT INTO airport_expansions (airline_id, airport_code, expansion_level)
      SELECT airline_id, airport_code, slots_count FROM airport_slots WHERE slots_count > 0
      ON CONFLICT(airline_id, airport_code) DO UPDATE SET expansion_level = MAX(expansion_level, excluded.expansion_level)`);
  } catch (e) { /* table may not exist */ }

  // Migrate service_item_types: add image + per-class price columns if missing
  const imageColMigrations = [
    'ALTER TABLE service_item_types ADD COLUMN image_eco TEXT',
    'ALTER TABLE service_item_types ADD COLUMN image_bus TEXT',
    'ALTER TABLE service_item_types ADD COLUMN image_fir TEXT',
    'ALTER TABLE service_item_types ADD COLUMN price_economy REAL NOT NULL DEFAULT 0',
    'ALTER TABLE service_item_types ADD COLUMN price_business REAL NOT NULL DEFAULT 0',
    'ALTER TABLE service_item_types ADD COLUMN price_first REAL NOT NULL DEFAULT 0',
  ];
  for (const m of imageColMigrations) {
    try { db.exec(m); } catch (e) { /* column already exists */ }
  }

  // Remove legacy item 16 (Wi-Fi Access) if present
  try {
    db.exec('DELETE FROM service_profile_items WHERE item_type_id = 16');
    db.exec('DELETE FROM service_item_types WHERE id = 16');
  } catch (e) { /* ignore */ }

  // Seed / update the 15 canonical service item types (INSERT OR REPLACE keeps data fresh)
  // price_per_pax kept for backward compat = price_economy
  db.exec(`
    INSERT OR REPLACE INTO service_item_types (id, item_name, category, price_per_pax, price_economy, price_business, price_first, sort_order, image_eco, image_bus, image_fir) VALUES
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
  `);
  for (const m of migrations) {
    try { db.exec(m); } catch (e) { /* column already exists */ }
  }

  // Apply data fixes (idempotent corrections to existing data)
  for (const fix of dataFixes) {
    try { db.exec(fix); } catch (e) { /* ignore */ }
  }

  // Assign random (diverse) airports to used market listings that have no location
  try {
    const aptStmt = db.prepare('SELECT iata_code FROM airports');
    const apts = [];
    while (aptStmt.step()) apts.push(aptStmt.get()[0]);
    aptStmt.free();
    if (apts.length) {
      const noLocStmt = db.prepare('SELECT id FROM used_aircraft_market WHERE location IS NULL OR location = ?');
      noLocStmt.bind(['MUC']); // also fix the incorrectly bulk-assigned MUC entries
      const ids = [];
      while (noLocStmt.step()) ids.push(noLocStmt.get()[0]);
      noLocStmt.free();
      for (const id of ids) {
        const apt = apts[Math.floor(Math.random() * apts.length)];
        const upd = db.prepare('UPDATE used_aircraft_market SET location = ? WHERE id = ?');
        upd.bind([apt, id]); upd.step(); upd.free();
      }
    }
  } catch(e) { /* ignore */ }

  // Seed airport fees — category-based values per game spec
  // [iata, landing_light, landing_medium, landing_heavy, gh_light, gh_medium, gh_heavy]
  // Cat 8: landing $850/$2,900/$7,300  ground $600/$1,200/$2,150
  // Cat 7: landing $700/$2,400/$5,900  ground $550/$1,075/$1,825
  // Cat 6: landing $600/$1,800/$4,000  ground $500/$950/$1,500
  // Cat 5: landing $350/$850/$2,850    ground $450/$800/$1,200
  // Cat 4: landing $300/$700/$2,200    ground $400/$650/$950
  const airportFeeData = [
    // Cat 6
    ['ZRH',  600, 1800, 4000,  500,  950, 1500],
    // Cat 5
    ['GVA',  350,  850, 2850,  450,  800, 1200],
    // Cat 4
    ['BSL',  300,  700, 2200,  400,  650,  950],
    // Cat 7
    ['FRA',  700, 2400, 5900,  550, 1075, 1825],
    // Cat 6
    ['MUC',  600, 1800, 4000,  500,  950, 1500],
    ['BER',  600, 1800, 4000,  500,  950, 1500],
    // Cat 8
    ['LHR',  850, 2900, 7300,  600, 1200, 2150],
    // Cat 6
    ['LGW',  600, 1800, 4000,  500,  950, 1500],
    ['MAN',  600, 1800, 4000,  500,  950, 1500],
    // Cat 7
    ['CDG',  700, 2400, 5900,  550, 1075, 1825],
    // Cat 6
    ['ORY',  600, 1800, 4000,  500,  950, 1500],
    // Cat 7
    ['AMS',  700, 2400, 5900,  550, 1075, 1825],
    ['JFK',  700, 2400, 5900,  550, 1075, 1825],
    // Cat 8
    ['LAX',  850, 2900, 7300,  600, 1200, 2150],
    ['ORD',  850, 2900, 7300,  600, 1200, 2150],
    ['ATL',  850, 2900, 7300,  600, 1200, 2150],
    ['DXB',  850, 2900, 7300,  600, 1200, 2150],
    // Cat 7
    ['SIN',  700, 2400, 5900,  550, 1075, 1825],
    // Cat 6
    ['NRT',  600, 1800, 4000,  500,  950, 1500],
    // Cat 8
    ['HND',  850, 2900, 7300,  600, 1200, 2150],
    // Cat 6
    ['SYD',  600, 1800, 4000,  500,  950, 1500],
    // New European airports
    // Cat 8
    ['IST',  850, 2900, 7300,  600, 1200, 2150],
    // Cat 7
    ['MAD',  700, 2400, 5900,  550, 1075, 1825],
    // Cat 6
    ['BCN',  600, 1800, 4000,  500,  950, 1500],
    ['FCO',  600, 1800, 4000,  500,  950, 1500],
    ['DME',  600, 1800, 4000,  500,  950, 1500],
    // Cat 5
    ['VIE',  350,  850, 2850,  450],
    ['CPH',  350,  850, 2850,  450],
    ['ARN',  350,  850, 2850,  450],
    ['DUB',  350,  850, 2850,  450,  800, 1200],
    ['OSL',  350,  850, 2850,  450,  800, 1200],
    ['HEL',  350,  850, 2850,  450,  800, 1200],
    ['LIS',  350,  850, 2850,  450,  800, 1200],
    ['ATH',  350,  850, 2850,  450,  800, 1200],
    ['WAW',  350,  850, 2850,  450,  800, 1200],
    ['BRU',  350,  850, 2850,  450,  800, 1200],
    ['MXP',  350,  850, 2850,  450,  800, 1200],
    ['DUS',  350,  850, 2850,  450,  800, 1200],
    ['TXL',  350,  850, 2850,  450,  800, 1200],
    ['PMI',  350,  850, 2850,  450,  800, 1200],
    ['AGP',  350,  850, 2850,  450,  800, 1200],
    ['OPO',  350,  850, 2850,  450,  800, 1200],
    ['NCE',  350,  850, 2850,  450,  800, 1200],
    // Cat 4
    ['PRG',  300,  700, 2200,  400,  650,  950],
    ['HAM',  300,  700, 2200,  400,  650,  950],
    ['STR',  300,  700, 2200,  400,  650,  950],
    ['BUD',  300,  700, 2200,  400,  650,  950],
    ['OTP',  300,  700, 2200,  400,  650,  950],
    ['SOF',  300,  700, 2200,  400,  650,  950],
    ['SKG',  300,  700, 2200,  400,  650,  950],
    ['MRS',  300,  700, 2200,  400,  650,  950],
    ['LYS',  300,  700, 2200,  400,  650,  950],
    ['TLS',  300,  700, 2200,  400,  650,  950],
    ['ALC',  300,  700, 2200,  400,  650,  950],
    ['VLC',  300,  700, 2200,  400,  650,  950],
    ['FAO',  300,  700, 2200,  400,  650,  950],
    ['RIX',  300,  700, 2200,  400,  650,  950],
    ['KRK',  300,  700, 2200,  400,  650,  950],
    // Cat 3
    ['ZAG',  250,  550, 1800,  350,  500,  750],
    ['LJU',  250,  550, 1800,  350,  500,  750],
    ['BIL',  250,  550, 1800,  350,  500,  750],
    ['TLL',  250,  550, 1800,  350,  500,  750],
    ['VNO',  250,  550, 1800,  350,  500,  750],
    ['GDN',  250,  550, 1800,  350,  500,  750],
  ];
  for (const [code, light, medium, heavy, ghl, ghm, ghh] of airportFeeData) {
    try {
      db.exec(`UPDATE airports SET landing_fee_light=${light}, landing_fee_medium=${medium}, landing_fee_heavy=${heavy}, ground_handling_fee=${ghl}, ground_handling_fee_light=${ghl}, ground_handling_fee_medium=${ghm}, ground_handling_fee_heavy=${ghh} WHERE iata_code='${code}'`);
    } catch (e) { /* ignore */ }
  }

  // Auto-fill fees for any airport that still has defaults, based on its category
  const CAT_FEES = {
    8: [850, 2900, 7300,  600, 1200, 2150],
    7: [700, 2400, 5900,  550, 1075, 1825],
    6: [600, 1800, 4000,  500,  950, 1500],
    5: [350,  850, 2850,  450,  800, 1200],
    4: [300,  700, 2200,  400,  650,  950],
    3: [250,  550, 1800,  350,  500,  750],
    2: [200,  400, 1400,  300,  400,  600],
    1: [150,  300, 1000,  250,  300,  450],
  };
  try {
    const catStmt = db.prepare('SELECT iata_code, category FROM airports');
    const toFill = [];
    while (catStmt.step()) { const r = catStmt.get(); toFill.push({ code: r[0], cat: r[1] }); }
    catStmt.free();
    for (const { code, cat } of toFill) {
      const [light, medium, heavy, ghl, ghm, ghh] = CAT_FEES[cat] || CAT_FEES[3];
      db.exec(`UPDATE airports SET landing_fee_light=${light}, landing_fee_medium=${medium}, landing_fee_heavy=${heavy}, ground_handling_fee=${ghl}, ground_handling_fee_light=${ghl}, ground_handling_fee_medium=${ghm}, ground_handling_fee_heavy=${ghh} WHERE iata_code='${code}'`);
    }
  } catch (e) { console.error('Auto-fill airport fees error:', e); }

  // Seed airport metadata: category, continent, state, runway_length_m
  // Category scale: 1=Airstrip(<100k) 2=Local(100k-500k) 3=Regional(500k-3M) 4=Medium(3M-10M)
  //                 5=Large(10M-25M) 6=National Hub(25M-50M) 7=International Hub(50M-80M) 8=Mega Hub(80M+)
  const airportInfoData = [
    // code,  cat, continent,       country,                      runway_m
    ['ZRH',    6,  'Europe',        'Switzerland',                3700],
    ['GVA',    5,  'Europe',        'Switzerland',                3900],
    ['BSL',    4,  'Europe',        'Switzerland',                3900],
    ['FRA',    7,  'Europe',        'Germany',                    4000],
    ['MUC',    6,  'Europe',        'Germany',                    4000],
    ['BER',    6,  'Europe',        'Germany',                    3600],
    ['LHR',    8,  'Europe',        'United Kingdom',             3902],
    ['LGW',    6,  'Europe',        'United Kingdom',             3316],
    ['MAN',    6,  'Europe',        'United Kingdom',             3048],
    ['CDG',    7,  'Europe',        'France',                     4215],
    ['ORY',    6,  'Europe',        'France',                     3650],
    ['AMS',    7,  'Europe',        'Netherlands',                3800],
    ['JFK',    7,  'North America', 'United States',              4423],
    ['LAX',    8,  'North America', 'United States',              3685],
    ['ORD',    8,  'North America', 'United States',              3962],
    ['ATL',    8,  'North America', 'United States',              3624],
    ['DXB',    8,  'Asia',          'United Arab Emirates',       4000],
    ['SIN',    7,  'Asia',          'Singapore',                  4000],
    ['NRT',    6,  'Asia',          'Japan',                      4000],
    ['HND',    8,  'Asia',          'Japan',                      3360],
    ['SYD',    6,  'Oceania',       'Australia',                  3962],
    // New European airports
    ['MAD',    7,  'Europe',        'Spain',                      4349],
    ['BCN',    6,  'Europe',        'Spain',                      3743],
    ['PMI',    5,  'Europe',        'Spain',                      3270],
    ['AGP',    5,  'Europe',        'Spain',                      3200],
    ['ALC',    4,  'Europe',        'Spain',                      3000],
    ['VLC',    4,  'Europe',        'Spain',                      3210],
    ['BIL',    3,  'Europe',        'Spain',                      3550],
    ['FCO',    6,  'Europe',        'Italy',                      3900],
    ['MXP',    5,  'Europe',        'Italy',                      3920],
    ['IST',    8,  'Europe',        'Turkey',                     4100],
    ['DME',    6,  'Europe',        'Russia',                     3794],
    ['VIE',    5,  'Europe',        'Austria',                    3600],
    ['CPH',    5,  'Europe',        'Denmark',                    3600],
    ['ARN',    5,  'Europe',        'Sweden',                     3301],
    ['DUB',    5,  'Europe',        'Ireland',                    3110],
    ['OSL',    5,  'Europe',        'Norway',                     3600],
    ['HEL',    5,  'Europe',        'Finland',                    3440],
    ['LIS',    5,  'Europe',        'Portugal',                   3805],
    ['OPO',    5,  'Europe',        'Portugal',                   3480],
    ['FAO',    4,  'Europe',        'Portugal',                   2880],
    ['ATH',    5,  'Europe',        'Greece',                     4000],
    ['SKG',    4,  'Europe',        'Greece',                     2600],
    ['WAW',    5,  'Europe',        'Poland',                     3690],
    ['KRK',    4,  'Europe',        'Poland',                     3300],
    ['GDN',    3,  'Europe',        'Poland',                     2800],
    ['PRG',    4,  'Europe',        'Czech Republic',             3715],
    ['BRU',    5,  'Europe',        'Belgium',                    3638],
    ['DUS',    5,  'Europe',        'Germany',                    3000],
    ['HAM',    4,  'Europe',        'Germany',                    3666],
    ['STR',    4,  'Europe',        'Germany',                    3345],
    ['TXL',    5,  'Europe',        'Germany',                    4000],
    ['BUD',    4,  'Europe',        'Hungary',                    3707],
    ['OTP',    4,  'Europe',        'Romania',                    3500],
    ['SOF',    4,  'Europe',        'Bulgaria',                   3600],
    ['ZAG',    3,  'Europe',        'Croatia',                    3252],
    ['LJU',    3,  'Europe',        'Slovenia',                   3300],
    ['NCE',    5,  'Europe',        'France',                     3000],
    ['MRS',    4,  'Europe',        'France',                     3500],
    ['LYS',    4,  'Europe',        'France',                     4000],
    ['TLS',    4,  'Europe',        'France',                     3500],
    ['RIX',    4,  'Europe',        'Latvia',                     3200],
    ['TLL',    3,  'Europe',        'Estonia',                    3070],
    ['VNO',    3,  'Europe',        'Lithuania',                  2515],
  ];
  for (const [code, cat, continent, state, runway] of airportInfoData) {
    try {
      db.exec(`UPDATE airports SET category=${cat}, continent='${continent}', state='${state}', runway_length_m=${runway} WHERE iata_code='${code}'`);
    } catch (e) { /* ignore */ }
  }

  // Seed airport coordinates (WGS84)
  const airportCoords = [
    ['ZRH',  47.4647,   8.5492],
    ['GVA',  46.2381,   6.1089],
    ['BSL',  47.5896,   7.5299],
    ['FRA',  50.0379,   8.5622],
    ['MUC',  48.3537,  11.7750],
    ['BER',  52.3667,  13.5033],
    ['LHR',  51.4700,  -0.4543],
    ['LGW',  51.1537,  -0.1821],
    ['MAN',  53.3537,  -2.2750],
    ['CDG',  49.0097,   2.5479],
    ['ORY',  48.7233,   2.3794],
    ['AMS',  52.3105,   4.7683],
    ['JFK',  40.6413,  -73.7781],
    ['LAX',  33.9425, -118.4081],
    ['ORD',  41.9742,  -87.9073],
    ['ATL',  33.6407,  -84.4277],
    ['DXB',  25.2532,  55.3657],
    ['SIN',   1.3644, 103.9915],
    ['NRT',  35.7720, 140.3929],
    ['HND',  35.5494, 139.7798],
    ['SYD', -33.9399, 151.1753],
    // New European airports
    ['MAD',  40.4936,  -3.5668],
    ['BCN',  41.2974,   2.0833],
    ['PMI',  39.5517,   2.7388],
    ['AGP',  36.6749,  -4.4991],
    ['ALC',  38.2822,  -0.5582],
    ['VLC',  39.4893,  -0.4816],
    ['BIL',  43.3011,  -2.9106],
    ['FCO',  41.8003,  12.2389],
    ['MXP',  45.6306,   8.7281],
    ['IST',  41.2608,  28.7418],
    ['DME',  55.4088,  37.9063],
    ['VIE',  48.1103,  16.5697],
    ['CPH',  55.6180,  12.6560],
    ['ARN',  59.6519,  17.9186],
    ['DUB',  53.4213,  -6.2701],
    ['OSL',  60.1939,  11.1004],
    ['HEL',  60.3172,  24.9633],
    ['LIS',  38.7813,  -9.1359],
    ['OPO',  41.2481,  -8.6814],
    ['FAO',  37.0144,  -7.9659],
    ['ATH',  37.9364,  23.9445],
    ['SKG',  40.5197,  22.9709],
    ['WAW',  52.1657,  20.9671],
    ['KRK',  50.0777,  19.7848],
    ['GDN',  54.3776,  18.4662],
    ['PRG',  50.1008,  14.2632],
    ['BRU',  50.9010,   4.4844],
    ['DUS',  51.2895,   6.7668],
    ['HAM',  53.6304,  10.0062],
    ['STR',  48.6899,   9.2219],
    ['TXL',  52.3667,  13.5033],
    ['BUD',  47.4298,  19.2611],
    ['OTP',  44.5711,  26.0850],
    ['SOF',  42.6952,  23.4114],
    ['ZAG',  45.7429,  16.0688],
    ['LJU',  46.2237,  14.4576],
    ['NCE',  43.6584,   7.2159],
    ['MRS',  43.4393,   5.2214],
    ['LYS',  45.7256,   5.0811],
    ['TLS',  43.6293,   1.3638],
    ['RIX',  56.9236,  23.9711],
    ['TLL',  59.4133,  24.8328],
    ['VNO',  54.6341,  25.2858],
  ];
  for (const [code, lat, lng] of airportCoords) {
    try {
      db.exec(`UPDATE airports SET latitude=${lat}, longitude=${lng} WHERE iata_code='${code}'`);
    } catch (e) { /* ignore */ }
  }

  // Update Boeing 787-8 image filename to match new asset convention
  try {
    db.exec(`UPDATE aircraft_types SET image_filename='Aircraft_Boeing_787-8.png' WHERE id=12 AND image_filename='Aircraft_Boeing_787-800.png'`);
  } catch (e) { /* ignore */ }

  // Seed new aircraft types (IDs 15-59) for existing databases
  db.exec(`
    INSERT OR IGNORE INTO aircraft_types (id, manufacturer, model, full_name, max_passengers, range_km, cruise_speed_kmh, min_runway_takeoff_m, min_runway_landing_m, fuel_consumption_empty_per_km, fuel_consumption_full_per_km, wake_turbulence_category, new_price_usd, required_level, required_pilots, image_filename) VALUES
    (15,'Airbus','A319 Neo','Airbus A319 Neo',160,6850,828,1850,1400,0.020,0.025,'M',101500000,3,2,'Aircraft_Airbus_319_Neo.png'),
    (16,'Airbus','A330-200','Airbus A330-200',406,13450,871,2770,1830,0.031,0.040,'H',238500000,4,2,'Aircraft_Airbus_330-200.png'),
    (17,'Airbus','A330-300','Airbus A330-300',440,11750,871,2770,1830,0.033,0.042,'H',264200000,4,2,'Aircraft_Airbus_330-300.png'),
    (18,'Airbus','A330-800 Neo','Airbus A330-800 Neo',406,15094,871,2500,1830,0.028,0.036,'H',259900000,4,2,'Aircraft_Airbus_330-800_Neo.png'),
    (19,'Airbus','A330-900 Neo','Airbus A330-900 Neo',440,13334,871,2770,1830,0.029,0.037,'H',296400000,4,2,'Aircraft_Airbus_330-900_Neo.png'),
    (20,'Airbus','A340-300','Airbus A340-300',440,13500,871,3000,2000,0.038,0.048,'H',238000000,4,2,'Aircraft_Airbus_340-300.png'),
    (21,'Airbus','A340-500','Airbus A340-500',375,16670,871,3050,2100,0.040,0.050,'H',275400000,4,2,'Aircraft_Airbus_340-500.png'),
    (22,'Airbus','A340-600','Airbus A340-600',475,14630,871,3100,2100,0.042,0.052,'H',283000000,4,2,'Aircraft_Airbus_340-600.png'),
    (23,'Airbus','A350-900','Airbus A350-900',440,15372,903,2600,1800,0.026,0.034,'H',317400000,4,2,'Aircraft_Airbus_350-900.png'),
    (24,'Airbus','A350-1000','Airbus A350-1000',480,16112,903,2750,1900,0.028,0.036,'H',366500000,5,2,'Aircraft_Airbus_350-1000.png'),
    (25,'ATR','42','ATR 42',48,1302,556,1165,1107,0.015,0.019,'M',18400000,1,2,'Aircraft_ATR_ATR-42.png'),
    (26,'ATR','72','ATR 72',72,1403,510,1333,1279,0.016,0.020,'M',26500000,1,2,'Aircraft_ATR_ATR-72.png'),
    (27,'Avro','RJ85','Avro RJ85',112,3335,764,1677,1372,0.025,0.031,'M',35000000,1,2,'Aircraft_Avro_RJ85.png'),
    (28,'Boeing','737-8 Max','Boeing 737-8 Max',210,6570,839,2286,1524,0.022,0.028,'M',121600000,3,2,'Aircraft_Boeing_737-8-Max.png'),
    (29,'Boeing','737-10 Max','Boeing 737-10 Max',230,5740,839,2438,1585,0.024,0.030,'M',134900000,3,2,'Aircraft_Boeing_737-10-Max.png'),
    (30,'Boeing','737-300','Boeing 737-300',149,4204,794,2316,1524,0.026,0.033,'M',55000000,1,2,'Aircraft_Boeing_737-300.png'),
    (31,'Boeing','737-400','Boeing 737-400',188,4005,794,2438,1585,0.027,0.034,'M',60000000,1,2,'Aircraft_Boeing_737-400.png'),
    (32,'Boeing','737-500','Boeing 737-500',132,4444,794,2286,1524,0.025,0.032,'M',54500000,1,2,'Aircraft_Boeing_737-500.png'),
    (33,'Boeing','737-600','Boeing 737-600',132,5648,828,1981,1463,0.023,0.029,'M',74000000,1,2,'Aircraft_Boeing_737-600.png'),
    (34,'Boeing','737-800','Boeing 737-800',189,5436,828,2438,1524,0.024,0.030,'M',106100000,3,2,'Aircraft_Boeing_737-800.png'),
    (35,'Boeing','747-300','Boeing 747-300',660,12400,907,3200,2100,0.044,0.055,'H',280000000,4,2,'Aircraft_Boeing_747-300.png'),
    (36,'Boeing','747-400','Boeing 747-400',660,13450,907,3018,2134,0.042,0.053,'H',418400000,5,2,'Aircraft_Boeing_747-400.png'),
    (37,'Boeing','757-200','Boeing 757-200',239,7222,850,1981,1524,0.025,0.032,'H',125000000,3,2,'Aircraft_Boeing_757-200.png'),
    (38,'Boeing','757-300','Boeing 757-300',289,6287,850,2438,1676,0.027,0.034,'H',135000000,3,2,'Aircraft_Boeing_757-300.png'),
    (39,'Boeing','777-200','Boeing 777-200',440,9704,905,3139,1829,0.030,0.039,'H',306600000,4,2,'Aircraft_Boeing_777-200.png'),
    (40,'Boeing','787-9','Boeing 787-9',406,14140,903,2750,1676,0.028,0.036,'H',292500000,4,2,'Aircraft_Boeing_787-9.png'),
    (41,'Boeing','787-10','Boeing 787-10',440,11910,903,2900,1750,0.029,0.037,'H',338400000,5,2,'Aircraft_Boeing_787-10.png'),
    (42,'Bombardier','CRJ-200','Bombardier CRJ-200',50,3148,786,1876,1463,0.020,0.025,'M',27000000,1,2,'Aircraft_Bombardier_CRJ-200.png'),
    (43,'Bombardier','CRJ-700','Bombardier CRJ-700',78,3620,828,1905,1524,0.021,0.026,'M',36200000,1,2,'Aircraft_Bombardier_CRJ-700.png'),
    (44,'Bombardier','CRJ-900','Bombardier CRJ-900',90,2956,828,2042,1585,0.022,0.027,'M',46300000,1,2,'Aircraft_Bombardier_CRJ-900.png'),
    (45,'British Aerospace','Jetstream 41','British Aerospace Jetstream 41',29,1482,547,1372,1097,0.018,0.023,'L',8500000,1,2,'Aircraft_British-Aerospace_Jetstream-41_.png'),
    (46,'COMAC','C909','COMAC C909 (ARJ21)',95,3704,828,1850,1600,0.023,0.029,'M',38000000,1,2,'Aircraft_Comac_909.png'),
    (47,'COMAC','C919','COMAC C919',174,5555,834,2200,1700,0.024,0.030,'M',99000000,2,2,'Aircraft_Comac_919.png'),
    (48,'De Havilland','DHC-8-300','De Havilland DHC-8-300',56,1558,528,1372,1128,0.016,0.020,'M',17500000,1,2,'Aircraft_DeHavilland_DHC-8-300.png'),
    (49,'De Havilland','DHC-8-400','De Havilland DHC-8-400',90,2040,667,1425,1189,0.017,0.021,'M',32700000,1,2,'Aircraft_DeHavilland_DHC-8-400.png'),
    (50,'Dornier','328-100','Dornier 328-100',33,1667,620,1280,1036,0.017,0.021,'L',10800000,1,2,'Aircraft_Dornier_328-100.png'),
    (51,'Dornier','328 JET','Dornier 328 JET',34,1852,750,1372,1128,0.018,0.022,'M',14000000,1,2,'Aircraft_Dornier_328-JET.png'),
    (52,'Embraer','EMB 120','Embraer EMB 120 Brasilia',30,1482,555,1280,1036,0.016,0.020,'L',8000000,1,2,'Aircraft_Embrear_120.png'),
    (53,'Embraer','ERJ 135','Embraer ERJ 135',37,3241,834,1905,1372,0.019,0.024,'M',18500000,1,2,'Aircraft_Embrear_135.png'),
    (54,'Embraer','ERJ 140','Embraer ERJ 140',44,2963,834,2012,1402,0.020,0.025,'M',21500000,1,2,'Aircraft_Embrear_140.png'),
    (55,'Embraer','ERJ 145','Embraer ERJ 145',50,2871,834,2042,1433,0.021,0.026,'M',29900000,1,2,'Aircraft_Embrear_145.png'),
    (56,'Embraer','E190','Embraer E190',114,4537,829,1693,1350,0.023,0.029,'M',51300000,1,2,'Aircraft_Embrear_190.png'),
    (57,'Embraer','E195','Embraer E195',124,4074,829,1788,1400,0.024,0.030,'M',53000000,1,2,'Aircraft_Embrear_195.png'),
    (58,'Saab','340','Saab 340',36,1735,522,1200,975,0.015,0.019,'L',7500000,1,2,'Aircraft_Saab_Saab-340.png'),
    (59,'Sukhoi','Superjet 100','Sukhoi Superjet 100',108,4578,828,2052,1680,0.022,0.028,'M',36000000,1,2,'Aircraft_Suchoi_Superjet-100.png'),
    (60,'Airbus','A350-900 ULR','Airbus A350-900 ULR',440,18000,903,3000,2200,0.033,0.043,'H',370000000,6,2,'Aircraft_Airbus_350-900.png'),
    (61,'Boeing','777-200LR','Boeing 777-200LR',440,17370,892,3050,2100,0.036,0.046,'H',360000000,6,2,'Aircraft_Boeing_777-200.png')
  `);

  // Seed cabin profiles for new aircraft types (IDs 36-146)
  db.exec(`
    INSERT OR IGNORE INTO cabin_profiles (id, name, aircraft_type_id, economy_seats, business_seats, first_seats) VALUES
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
  `);

  // Seed depreciation parameters per aircraft type (canonical values — always applied)
  // k_age: annual decay rate  k_fh: per-flight-hour decay rate
  // Base: kAge=0.035, kFh=0.000006, floor=30%
  // Categories: small turboprops (0.048/4.8e-6) · regional jets (0.044/5.4e-6)
  //             narrow-body (0.038/6e-6) · wide-body (0.032/7.2e-6) · very large (0.028/9e-6)
  const aircraftDepreciationData = [
    // Small turboprops & piston
    [25, 0.048, 0.0000048], // ATR 42
    [26, 0.048, 0.0000048], // ATR 72
    [45, 0.048, 0.0000048], // BA Jetstream 41
    [48, 0.048, 0.0000048], // DHC-8-300
    [49, 0.048, 0.0000048], // DHC-8-400
    [50, 0.048, 0.0000048], // Dornier 328-100
    [52, 0.048, 0.0000048], // EMB 120 Brasilia
    [58, 0.048, 0.0000048], // Saab 340
    // Small regional jets (< ~100 pax)
    [1,  0.044, 0.0000054], // Embraer E175
    [2,  0.044, 0.0000054], // Embraer E175-E2
    [42, 0.044, 0.0000054], // CRJ-200
    [43, 0.044, 0.0000054], // CRJ-700
    [44, 0.044, 0.0000054], // CRJ-900
    [46, 0.044, 0.0000054], // COMAC C909
    [51, 0.044, 0.0000054], // Dornier 328 JET
    [53, 0.044, 0.0000054], // ERJ 135
    [54, 0.044, 0.0000054], // ERJ 140
    [55, 0.044, 0.0000054], // ERJ 145
    // Narrow-body (100–300 pax)
    [3,  0.038, 0.000006], // Embraer E190-E2
    [4,  0.038, 0.000006], // Embraer E195-E2
    [5,  0.038, 0.000006], // Airbus A220-100
    [6,  0.038, 0.000006], // Airbus A220-300
    [7,  0.038, 0.000006], // Airbus A318
    [8,  0.038, 0.000006], // Airbus A319
    [9,  0.038, 0.000006], // Airbus A320
    [10, 0.038, 0.000006], // Airbus A321
    [11, 0.038, 0.000006], // Airbus A321 Neo
    [15, 0.038, 0.000006], // Airbus A319 Neo
    [27, 0.038, 0.000006], // Avro RJ85
    [28, 0.038, 0.000006], // Boeing 737-8 Max
    [29, 0.038, 0.000006], // Boeing 737-10 Max
    [30, 0.038, 0.000006], // Boeing 737-300
    [31, 0.038, 0.000006], // Boeing 737-400
    [32, 0.038, 0.000006], // Boeing 737-500
    [33, 0.038, 0.000006], // Boeing 737-600
    [34, 0.038, 0.000006], // Boeing 737-800
    [37, 0.038, 0.000006], // Boeing 757-200
    [38, 0.038, 0.000006], // Boeing 757-300
    [47, 0.038, 0.000006], // COMAC C919
    [56, 0.038, 0.000006], // Embraer E190
    [57, 0.038, 0.000006], // Embraer E195
    [59, 0.038, 0.000006], // Sukhoi Superjet 100
    // Wide-body (300–500 pax)
    [12, 0.032, 0.0000072], // Boeing 787-8
    [16, 0.032, 0.0000072], // Airbus A330-200
    [17, 0.032, 0.0000072], // Airbus A330-300
    [18, 0.032, 0.0000072], // Airbus A330-800 Neo
    [19, 0.032, 0.0000072], // Airbus A330-900 Neo
    [20, 0.032, 0.0000072], // Airbus A340-300
    [21, 0.032, 0.0000072], // Airbus A340-500
    [22, 0.032, 0.0000072], // Airbus A340-600
    [23, 0.032, 0.0000072], // Airbus A350-900
    [24, 0.032, 0.0000072], // Airbus A350-1000
    [39, 0.032, 0.0000072], // Boeing 777-200
    [60, 0.032, 0.0000072], // Airbus A350-900 ULR
    [61, 0.032, 0.0000072], // Boeing 777-200LR
    [40, 0.032, 0.0000072], // Boeing 787-9
    [41, 0.032, 0.0000072], // Boeing 787-10
    // Very large (> 500 pax)
    [13, 0.028, 0.000009], // Boeing 777-300
    [14, 0.028, 0.000009], // Airbus A380
    [35, 0.028, 0.000009], // Boeing 747-300
    [36, 0.028, 0.000009], // Boeing 747-400
  ];
  for (const [id, kAge, kFh] of aircraftDepreciationData) {
    try {
      db.exec(`UPDATE aircraft_types SET depreciation_age=${kAge}, depreciation_fh=${kFh} WHERE id=${id}`);
    } catch (e) { /* ignore */ }
  }

  // Ensure fuel_consumption_per_km is in sync for all aircraft (runs after all INSERTs)
  try {
    db.exec(`UPDATE aircraft_types SET fuel_consumption_per_km = ROUND(fuel_consumption_full_per_km * 100, 4) WHERE fuel_consumption_per_km < 1`);
  } catch (e) { /* ignore */ }

  // Auto-set active_airline_id for existing users who have airlines but no active selection
  db.exec(`
    UPDATE users
    SET active_airline_id = (
      SELECT id FROM airlines WHERE user_id = users.id ORDER BY id LIMIT 1
    )
    WHERE active_airline_id IS NULL
      AND EXISTS (SELECT 1 FROM airlines WHERE user_id = users.id)
  `);

  saveDatabase();
  console.log('✅ Schema and seed data applied');

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