-- AVIATION EMPIRE DATABASE SCHEMA

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME
);

CREATE TABLE IF NOT EXISTS airlines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  airline_code TEXT UNIQUE NOT NULL,
  home_airport_code TEXT NOT NULL,
  balance REAL DEFAULT 50000000,
  image_score INTEGER DEFAULT 100,
  level INTEGER DEFAULT 1,
  total_points INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS aircraft_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manufacturer TEXT NOT NULL,
  model TEXT NOT NULL,
  full_name TEXT NOT NULL,
  max_passengers INTEGER NOT NULL,
  range_km INTEGER NOT NULL,
  cruise_speed_kmh INTEGER NOT NULL DEFAULT 850,
  min_runway_takeoff_m INTEGER NOT NULL DEFAULT 2000,
  min_runway_landing_m INTEGER NOT NULL DEFAULT 1500,
  fuel_consumption_empty_per_km REAL NOT NULL DEFAULT 0.025,
  fuel_consumption_full_per_km REAL NOT NULL DEFAULT 0.032,
  fuel_consumption_per_km REAL DEFAULT 0.028,
  wake_turbulence_category TEXT NOT NULL DEFAULT 'M',
  new_price_usd REAL NOT NULL,
  required_level INTEGER DEFAULT 1,
  required_pilots INTEGER NOT NULL DEFAULT 2,
  image_filename TEXT
);

CREATE TABLE IF NOT EXISTS airports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  iata_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  registration_prefix TEXT NOT NULL,
  category INTEGER DEFAULT 4,
  continent TEXT,
  state TEXT,
  runway_length_m INTEGER DEFAULT 2500,
  latitude REAL,
  longitude REAL
);

CREATE TABLE IF NOT EXISTS aircraft (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  airline_id INTEGER NOT NULL,
  aircraft_type_id INTEGER NOT NULL,
  registration TEXT UNIQUE NOT NULL,
  name TEXT,
  home_airport TEXT,
  condition INTEGER DEFAULT 100,
  purchased_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_active INTEGER DEFAULT 0,
  FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE,
  FOREIGN KEY (aircraft_type_id) REFERENCES aircraft_types(id),
  FOREIGN KEY (home_airport) REFERENCES airports(iata_code)
);

CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  airline_id INTEGER NOT NULL,
  departure_airport TEXT NOT NULL,
  arrival_airport TEXT NOT NULL,
  aircraft_id INTEGER,
  flight_number TEXT NOT NULL,
  distance_km INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE,
  FOREIGN KEY (aircraft_id) REFERENCES aircraft(id) ON DELETE SET NULL,
  FOREIGN KEY (departure_airport) REFERENCES airports(iata_code),
  FOREIGN KEY (arrival_airport) REFERENCES airports(iata_code),
  UNIQUE(airline_id, departure_airport, arrival_airport)
);

CREATE TABLE IF NOT EXISTS flights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  airline_id INTEGER NOT NULL,
  route_id INTEGER NOT NULL,
  aircraft_id INTEGER NOT NULL,
  flight_number TEXT NOT NULL,
  departure_time DATETIME NOT NULL,
  arrival_time DATETIME NOT NULL,
  ticket_price REAL NOT NULL,
  total_seats INTEGER NOT NULL,
  seats_sold INTEGER DEFAULT 0,
  status TEXT DEFAULT 'scheduled' CHECK(status IN ('scheduled', 'boarding', 'in-flight', 'completed', 'cancelled')),
  revenue REAL DEFAULT 0,
  atc_fee REAL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE,
  FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
  FOREIGN KEY (aircraft_id) REFERENCES aircraft(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  airline_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('aircraft_purchase', 'flight_revenue', 'maintenance', 'fuel', 'other')),
  amount REAL NOT NULL,
  description TEXT,
  reference_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS fuel_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  price_per_liter REAL NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS service_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  meal_quality INTEGER DEFAULT 3 CHECK(meal_quality BETWEEN 1 AND 5),
  beverage_quality INTEGER DEFAULT 3 CHECK(beverage_quality BETWEEN 1 AND 5),
  entertainment_quality INTEGER DEFAULT 3 CHECK(entertainment_quality BETWEEN 1 AND 5),
  comfort_level INTEGER DEFAULT 3 CHECK(comfort_level BETWEEN 1 AND 5),
  price_multiplier REAL DEFAULT 1.0
);

CREATE TABLE IF NOT EXISTS maintenance_schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  aircraft_id INTEGER NOT NULL,
  airline_id INTEGER NOT NULL,
  start_time DATETIME NOT NULL,
  end_time DATETIME NOT NULL,
  type TEXT NOT NULL DEFAULT 'routine',
  status TEXT DEFAULT 'scheduled',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (aircraft_id) REFERENCES aircraft(id) ON DELETE CASCADE,
  FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_airlines_user ON airlines(user_id);
CREATE INDEX IF NOT EXISTS idx_aircraft_airline ON aircraft(airline_id);
CREATE INDEX IF NOT EXISTS idx_routes_airline ON routes(airline_id);
CREATE INDEX IF NOT EXISTS idx_flights_airline ON flights(airline_id);
CREATE INDEX IF NOT EXISTS idx_flights_status ON flights(status);
CREATE INDEX IF NOT EXISTS idx_transactions_airline ON transactions(airline_id);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_maintenance_aircraft ON maintenance_schedule(aircraft_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_airline ON maintenance_schedule(airline_id);

CREATE TABLE IF NOT EXISTS cabin_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  aircraft_type_id INTEGER NOT NULL,
  economy_seats INTEGER NOT NULL DEFAULT 0,
  business_seats INTEGER NOT NULL DEFAULT 0,
  first_seats INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (aircraft_type_id) REFERENCES aircraft_types(id)
);

CREATE TABLE IF NOT EXISTS weekly_schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  aircraft_id INTEGER NOT NULL,
  day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
  flight_number TEXT NOT NULL,
  departure_airport TEXT NOT NULL,
  arrival_airport TEXT NOT NULL,
  departure_time TEXT NOT NULL,
  arrival_time TEXT NOT NULL,
  FOREIGN KEY (aircraft_id) REFERENCES aircraft(id) ON DELETE CASCADE,
  FOREIGN KEY (departure_airport) REFERENCES airports(iata_code),
  FOREIGN KEY (arrival_airport) REFERENCES airports(iata_code)
);

CREATE INDEX IF NOT EXISTS idx_cabin_profiles_type ON cabin_profiles(aircraft_type_id);
CREATE INDEX IF NOT EXISTS idx_weekly_schedule_aircraft ON weekly_schedule(aircraft_id);

-- ── Service Profiles (per-airline, custom item selection) ──────────────────

-- Global reference: 15 predefined service item types
CREATE TABLE IF NOT EXISTS service_item_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
);

-- Per-airline profile header
CREATE TABLE IF NOT EXISTS airline_service_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  airline_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE
);

-- Which items are included per cabin class in a profile
CREATE TABLE IF NOT EXISTS service_profile_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  item_type_id INTEGER NOT NULL,
  cabin_class TEXT NOT NULL CHECK(cabin_class IN ('economy', 'business', 'first')),
  FOREIGN KEY (profile_id) REFERENCES airline_service_profiles(id) ON DELETE CASCADE,
  FOREIGN KEY (item_type_id) REFERENCES service_item_types(id),
  UNIQUE(profile_id, item_type_id, cabin_class)
);

CREATE INDEX IF NOT EXISTS idx_asp_airline ON airline_service_profiles(airline_id);
CREATE INDEX IF NOT EXISTS idx_spi_profile  ON service_profile_items(profile_id);

-- ── Airline Cabin Profiles (user-defined seating layouts per aircraft type) ──

CREATE TABLE IF NOT EXISTS airline_cabin_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  airline_id INTEGER NOT NULL,
  aircraft_type_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE,
  FOREIGN KEY (aircraft_type_id) REFERENCES aircraft_types(id)
);

CREATE TABLE IF NOT EXISTS airline_cabin_classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  class_type TEXT NOT NULL CHECK(class_type IN ('economy', 'business', 'first')),
  seat_type TEXT NOT NULL,
  seat_ratio REAL NOT NULL DEFAULT 1.0,
  percentage REAL NOT NULL DEFAULT 0,
  actual_capacity INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (profile_id) REFERENCES airline_cabin_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_acp_airline  ON airline_cabin_profiles(airline_id);
CREATE INDEX IF NOT EXISTS idx_acc_profile  ON airline_cabin_classes(profile_id);

-- Seed the 15 predefined service item types
-- Image columns (image_eco/bus/fir) are populated by db.js after migrations add those columns
INSERT OR IGNORE INTO service_item_types (id, item_name, category, price_per_pax, sort_order) VALUES
(1,  'Water',               'Beverages',      1.50,  1),
(2,  'Soda & Juice',        'Beverages',      2.50,  2),
(3,  'Beer & Wine',         'Beverages',      5.00,  3),
(4,  'Cocktails',           'Beverages',     10.00,  4),
(5,  'Welcome Chocolate',   'Food',           1.50,  5),
(6,  'Snack',               'Food',           3.50,  6),
(7,  'Meal 1 – Small Cold', 'Food',           8.00,  7),
(8,  'Meal 2 – Large Cold', 'Food',          14.00,  8),
(9,  'Meal 3 – Large Hot',  'Food',          24.00,  9),
(10, 'Entertainment',       'Entertainment',  5.00, 10),
(11, 'Amenity Kit',         'Comfort',        8.00, 11),
(12, 'Sleep Kit',           'Comfort',       15.00, 12),
(13, 'Luggage 1 – Cabin',   'Luggage',        5.00, 13),
(14, 'Luggage 2 – Medium',  'Luggage',       20.00, 14),
(15, 'Luggage 3 – Large',   'Luggage',       35.00, 15);

-- Seed airport data
INSERT OR IGNORE INTO airports (iata_code, name, country, registration_prefix) VALUES
-- Switzerland
('ZRH', 'Zürich Airport', 'Switzerland', 'HB'),
('GVA', 'Geneva Airport', 'Switzerland', 'HB'),
('BSL', 'Basel EuroAirport', 'Switzerland', 'HB'),
-- Germany
('FRA', 'Frankfurt Airport', 'Germany', 'D'),
('MUC', 'Munich Airport', 'Germany', 'D'),
('BER', 'Berlin Brandenburg Airport', 'Germany', 'D'),
-- United Kingdom
('LHR', 'London Heathrow Airport', 'United Kingdom', 'G'),
('LGW', 'London Gatwick Airport', 'United Kingdom', 'G'),
('MAN', 'Manchester Airport', 'United Kingdom', 'G'),
-- France
('CDG', 'Paris Charles de Gaulle Airport', 'France', 'F'),
('ORY', 'Paris Orly Airport', 'France', 'F'),
-- Netherlands
('AMS', 'Amsterdam Schiphol Airport', 'Netherlands', 'PH'),
-- USA
('JFK', 'New York John F. Kennedy Airport', 'USA', 'N'),
('LAX', 'Los Angeles International Airport', 'USA', 'N'),
('ORD', 'Chicago O''Hare Airport', 'USA', 'N'),
('ATL', 'Atlanta Hartsfield-Jackson Airport', 'USA', 'N'),
-- UAE
('DXB', 'Dubai International Airport', 'United Arab Emirates', 'A6'),
-- Singapore
('SIN', 'Singapore Changi Airport', 'Singapore', '9V'),
-- Japan
('NRT', 'Tokyo Narita Airport', 'Japan', 'JA'),
('HND', 'Tokyo Haneda Airport', 'Japan', 'JA'),
-- Australia
('SYD', 'Sydney Kingsford Smith Airport', 'Australia', 'VH'),
-- Spain
('MAD', 'Madrid Barajas Airport', 'Spain', 'EC'),
('BCN', 'Barcelona El Prat Airport', 'Spain', 'EC'),
('PMI', 'Palma de Mallorca Airport', 'Spain', 'EC'),
('AGP', 'Málaga Costa del Sol Airport', 'Spain', 'EC'),
('ALC', 'Alicante-Elche Airport', 'Spain', 'EC'),
('VLC', 'Valencia Airport', 'Spain', 'EC'),
('BIL', 'Bilbao Airport', 'Spain', 'EC'),
-- Italy
('FCO', 'Rome Fiumicino Airport', 'Italy', 'I'),
('MXP', 'Milan Malpensa Airport', 'Italy', 'I'),
-- Turkey
('IST', 'Istanbul Airport', 'Turkey', 'TC'),
-- Russia
('DME', 'Moscow Domodedovo Airport', 'Russia', 'RA'),
-- Austria
('VIE', 'Vienna International Airport', 'Austria', 'OE'),
-- Denmark
('CPH', 'Copenhagen Airport', 'Denmark', 'OY'),
-- Sweden
('ARN', 'Stockholm Arlanda Airport', 'Sweden', 'SE'),
-- Ireland
('DUB', 'Dublin Airport', 'Ireland', 'EI'),
-- Norway
('OSL', 'Oslo Gardermoen Airport', 'Norway', 'LN'),
-- Finland
('HEL', 'Helsinki-Vantaa Airport', 'Finland', 'OH'),
-- Portugal
('LIS', 'Lisbon Humberto Delgado Airport', 'Portugal', 'CS'),
('OPO', 'Porto Airport', 'Portugal', 'CS'),
('FAO', 'Faro Airport', 'Portugal', 'CS'),
-- Greece
('ATH', 'Athens Eleftherios Venizelos Airport', 'Greece', 'SX'),
('SKG', 'Thessaloniki Macedonia Airport', 'Greece', 'SX'),
-- Poland
('WAW', 'Warsaw Chopin Airport', 'Poland', 'SP'),
('KRK', 'Kraków John Paul II Airport', 'Poland', 'SP'),
('GDN', 'Gdańsk Lech Wałęsa Airport', 'Poland', 'SP'),
-- Czech Republic
('PRG', 'Prague Václav Havel Airport', 'Czech Republic', 'OK'),
-- Belgium
('BRU', 'Brussels Airport', 'Belgium', 'OO'),
-- Germany (additional)
('DUS', 'Düsseldorf Airport', 'Germany', 'D'),
('HAM', 'Hamburg Airport', 'Germany', 'D'),
('STR', 'Stuttgart Airport', 'Germany', 'D'),
('TXL', 'Berlin Tegel Airport', 'Germany', 'D'),
-- Hungary
('BUD', 'Budapest Ferenc Liszt Airport', 'Hungary', 'HA'),
-- Romania
('OTP', 'Bucharest Henri Coandă Airport', 'Romania', 'YR'),
-- Bulgaria
('SOF', 'Sofia Airport', 'Bulgaria', 'LZ'),
-- Croatia
('ZAG', 'Zagreb Airport', 'Croatia', '9A'),
-- Slovenia
('LJU', 'Ljubljana Jože Pučnik Airport', 'Slovenia', 'S5'),
-- France (additional)
('NCE', 'Nice Côte d''Azur Airport', 'France', 'F'),
('MRS', 'Marseille Provence Airport', 'France', 'F'),
('LYS', 'Lyon Saint-Exupéry Airport', 'France', 'F'),
('TLS', 'Toulouse-Blagnac Airport', 'France', 'F'),
-- Latvia
('RIX', 'Riga International Airport', 'Latvia', 'YL'),
-- Estonia
('TLL', 'Tallinn Lennart Meri Airport', 'Estonia', 'ES'),
-- Lithuania
('VNO', 'Vilnius Airport', 'Lithuania', 'LY');

-- European airport expansion (INSERT OR IGNORE — skips any IATA already present)
INSERT OR IGNORE INTO airports (iata_code, name, country, registration_prefix, category, continent, runway_length_m, latitude, longitude) VALUES
-- Denmark
('AAL', 'Aalborg Airport',                          'Denmark',              'OY', 3, 'Europe', 2700,  57.0928,   9.8492),
('AAR', 'Aarhus Airport',                           'Denmark',              'OY', 3, 'Europe', 2777,  56.2999,  10.619),
('EBJ', 'Esbjerg Airport',                          'Denmark',              'OY', 2, 'Europe', 2600,  55.526,    8.5534),
('BLL', 'Billund Airport',                          'Denmark',              'OY', 4, 'Europe', 3301,  55.7403,   9.1518),
-- United Kingdom
('ABZ', 'Aberdeen International Airport',           'United Kingdom',       'G',  4, 'Europe', 1829,  57.2019,  -2.1978),
('BHX', 'Birmingham Airport',                       'United Kingdom',       'G',  5, 'Europe', 3052,  52.4539,  -1.748),
('BLK', 'Blackpool International Airport',          'United Kingdom',       'G',  2, 'Europe', 1869,  53.7717,  -3.0286),
('CBG', 'Cambridge Airport',                        'United Kingdom',       'G',  1, 'Europe', 1690,  52.205,    0.175),
('CWL', 'Cardiff Airport',                          'United Kingdom',       'G',  3, 'Europe', 2395,  51.3967,  -3.3433),
('CAX', 'Carlisle Lake District Airport',           'United Kingdom',       'G',  1, 'Europe', 1829,  54.9375,  -2.8092),
('DND', 'Dundee Airport',                           'United Kingdom',       'G',  1, 'Europe', 1399,  56.4525,  -3.0258),
('DSC', 'Doncaster Sheffield Airport',              'United Kingdom',       'G',  3, 'Europe', 2893,  53.4805,  -1.0106),
('EMA', 'East Midlands Airport',                    'United Kingdom',       'G',  4, 'Europe', 2893,  52.8311,  -1.3281),
('EDI', 'Edinburgh Airport',                        'United Kingdom',       'G',  5, 'Europe', 2556,  55.95,    -3.3725),
('EXT', 'Exeter International Airport',             'United Kingdom',       'G',  3, 'Europe', 2083,  50.7344,  -3.4139),
('FAB', 'Farnborough Airport',                      'United Kingdom',       'G',  2, 'Europe', 2440,  51.2758,  -0.7758),
('GIB', 'Gibraltar International Airport',          'Gibraltar',            'G',  2, 'Europe', 1829,  36.1512,  -5.3497),
('PIK', 'Glasgow Prestwick Airport',                'United Kingdom',       'G',  3, 'Europe', 2987,  55.5094,  -4.5869),
-- Germany
('AGB', 'Augsburg Airport',                         'Germany',              'D',  1, 'Europe', 1980,  48.4252,  10.9317),
('BFE', 'Bielefeld Airport',                        'Germany',              'D',  1, 'Europe', 1900,  51.9644,   8.5442),
('BWE', 'Braunschweig-Wolfsburg Airport',           'Germany',              'D',  1, 'Europe', 2300,  52.3192,  10.5561),
('BRE', 'Bremen Airport',                           'Germany',              'D',  4, 'Europe', 2993,  53.0475,   8.7867),
('DTM', 'Dortmund Airport',                         'Germany',              'D',  3, 'Europe', 2000,  51.5183,   7.6122),
('DRS', 'Dresden International Airport',            'Germany',              'D',  4, 'Europe', 2850,  51.1328,  13.7672),
('ERF', 'Erfurt Weimar Airport',                    'Germany',              'D',  3, 'Europe', 2287,  50.9798,  10.9581),
('FDH', 'Friedrichshafen Bodensee Airport',         'Germany',              'D',  3, 'Europe', 2400,  47.6713,   9.5115),
('HHN', 'Frankfurt Hahn Airport',                   'Germany',              'D',  3, 'Europe', 3800,  49.9487,   7.2639),
('MGL', 'Düsseldorf-Mönchengladbach Airport',       'Germany',              'D',  1, 'Europe', 2060,  51.2303,   6.5044),
-- France
('AGF', 'Agen-La Garenne Airport',                  'France',               'F',  1, 'Europe', 1950,  44.1747,   0.5906),
('AJA', 'Ajaccio Napoleon Bonaparte Airport',       'France',               'F',  3, 'Europe', 2370,  41.9236,   8.8029),
('ANG', 'Angoulême-Cognac Airport',                 'France',               'F',  1, 'Europe', 2150,  45.7292,   0.2215),
('NCY', 'Annecy Airport',                           'France',               'F',  1, 'Europe', 1527,  45.9292,   6.1008),
('AVN', 'Avignon Caumont Airport',                  'France',               'F',  1, 'Europe', 2100,  43.9073,   4.9018),
('BIA', 'Bastia Poretta Airport',                   'France',               'F',  3, 'Europe', 2517,  42.5527,   9.4837),
('CFR', 'Caen Carpiquet Airport',                   'France',               'F',  2, 'Europe', 2050,  49.1733,  -0.4497),
('CLY', 'Calvi Sainte Catherine Airport',           'France',               'F',  2, 'Europe', 2800,  42.5244,   8.7933),
('CEQ', 'Cannes Mandelieu Airport',                 'France',               'F',  1, 'Europe', 1760,  43.542,    6.9534),
('CCF', 'Carcassonne Airport',                      'France',               'F',  2, 'Europe', 2000,  43.216,    2.3063),
('XCR', 'Chalons Vatry Airport',                    'France',               'F',  2, 'Europe', 3000,  48.7761,   4.1853),
('CMF', 'Chambery Savoie Airport',                  'France',               'F',  2, 'Europe', 2100,  45.6381,   5.8803),
('CFE', 'Clermont-Ferrand Auvergne Airport',        'France',               'F',  3, 'Europe', 2950,  45.7867,   3.1692),
('DCM', 'Castres Mazamet Airport',                  'France',               'F',  1, 'Europe', 1815,  43.5563,   2.2892),
('DIJ', 'Dijon Longvic Airport',                    'France',               'F',  2, 'Europe', 2500,  47.2689,   5.09),
('DNR', 'Dinard Pleurtuit Saint-Malo Airport',      'France',               'F',  2, 'Europe', 2100,  48.5877,  -2.08),
('DLE', 'Dole Jura Airport',                        'France',               'F',  1, 'Europe', 2000,  47.0427,   5.4273),
('FSC', 'Figari Sud-Corse Airport',                 'France',               'F',  2, 'Europe', 2010,  41.5006,   9.0978),
-- Italy
('AHO', 'Alghero Airport',                          'Italy',                'I',  3, 'Europe', 2805,  40.6321,   8.2908),
('AOI', 'Ancona Raffaello Sanzio Airport',          'Italy',                'I',  3, 'Europe', 3048,  43.6163,  13.3622),
('AOT', 'Aosta Airport',                            'Italy',                'I',  1, 'Europe', 1620,  45.7385,   7.3687),
('BRI', 'Bari International Airport',               'Italy',                'I',  4, 'Europe', 3047,  41.1389,  16.7606),
('CAG', 'Cagliari Elmas Airport',                   'Italy',                'I',  4, 'Europe', 3080,  39.2515,   9.0543),
('CIY', 'Comiso Vincenzo Magliocco Airport',        'Italy',                'I',  2, 'Europe', 2000,  36.9946,  14.6072),
('CRV', 'Crotone Airport',                          'Italy',                'I',  1, 'Europe', 1820,  38.9972,  17.0802),
('CUF', 'Cuneo Levaldigi Airport',                  'Italy',                'I',  2, 'Europe', 2040,  44.547,    7.6232),
('FLR', 'Firenze Amerigo Vespucci Airport',         'Italy',                'I',  4, 'Europe', 2051,  43.81,    11.2051),
('FOG', 'Foggia Gino Lisa Airport',                 'Italy',                'I',  2, 'Europe', 1700,  41.4329,  15.535),
('FRL', 'Forlì Luigi Ridolfi Airport',              'Italy',                'I',  2, 'Europe', 2502,  44.1978,  12.0701),
('GOA', 'Genoa Cristoforo Colombo Airport',         'Italy',                'I',  3, 'Europe', 3000,  44.4133,   8.8375),
('NAP', 'Napoli International Airport',             'Italy',                'I',  5, 'Europe', 2628,  40.886,   14.2908),
-- Spain
('ABC', 'Albacete Airport',                         'Spain',                'EC', 1, 'Europe', 3000,  38.9485,  -1.8635),
('ACE', 'Arrecife Lanzarote Airport',               'Spain',                'EC', 5, 'Europe', 3400,  28.9455, -13.6052),
('BJZ', 'Badajoz Airport',                          'Spain',                'EC', 2, 'Europe', 3000,  38.8913,  -6.8213),
('BIO', 'Bilbao Airport',                           'Spain',                'EC', 3, 'Europe', 3550,  43.3011,  -2.9106),
('RGS', 'Burgos Airport',                           'Spain',                'EC', 2, 'Europe', 2600,  42.3576,  -3.6207),
('CDT', 'Castellon Costa Azahar Airport',           'Spain',                'EC', 2, 'Europe', 2800,  40.0013,   0.0731),
('ODB', 'Córdoba Airport',                          'Spain',                'EC', 2, 'Europe', 2200,  37.842,   -4.8488),
('FUE', 'Fuerteventura El Matorral Airport',        'Spain',                'EC', 5, 'Europe', 3400,  28.4527, -13.8638),
('GRO', 'Girona Costa Brava Airport',               'Spain',                'EC', 3, 'Europe', 2400,  41.901,    2.7605),
('LEI', 'Almería Airport',                          'Spain',                'EC', 3, 'Europe', 2300,  36.8439,  -2.3701),
-- Norway
('AES', 'Ålesund Vigra Airport',                    'Norway',               'LN', 3, 'Europe', 2100,  62.5625,   6.1197),
('ALF', 'Alta Airport',                             'Norway',               'LN', 2, 'Europe', 2158,  69.9761,  23.3718),
('ANX', 'Andøya Airport',                           'Norway',               'LN', 1, 'Europe', 2700,  69.2925,  16.1442),
('BDU', 'Bardufoss Airport',                        'Norway',               'LN', 2, 'Europe', 2798,  69.0558,  18.5404),
('BOO', 'Bodø Airport',                             'Norway',               'LN', 3, 'Europe', 2798,  67.2692,  14.3653),
('EVE', 'Evenes Airport',                           'Norway',               'LN', 3, 'Europe', 3300,  68.4913,  16.6781),
('FRO', 'Floro Airport',                            'Norway',               'LN', 2, 'Europe', 1500,  61.5836,   5.0247),
-- Sweden
('AGH', 'Ängelholm-Helsingborg Airport',            'Sweden',               'SE', 2, 'Europe', 2300,  56.2962,  12.8471),
('AJR', 'Arvidsjaur Airport',                       'Sweden',               'SE', 1, 'Europe', 2100,  65.5903,  19.2819),
-- Iceland
('AEY', 'Akureyri Airport',                         'Iceland',              'TF', 2, 'Europe', 2000,  65.66,   -18.0727),
('EGS', 'Egilsstadir Airport',                      'Iceland',              'TF', 2, 'Europe', 1600,  65.2833, -14.4014),
-- Greece
('AXD', 'Alexandroupolis Demokritos Airport',       'Greece',               'SX', 2, 'Europe', 2710,  40.8559,  25.9563),
('GPA', 'Araxos Airport',                           'Greece',               'SX', 2, 'Europe', 3000,  38.1511,  21.4256),
('CHQ', 'Chania Ioannis Daskalogiannis Airport',    'Greece',               'SX', 4, 'Europe', 2688,  35.5317,  24.1497),
('CSH', 'Chios Island National Airport',            'Greece',               'SX', 2, 'Europe', 1560,  38.3433,  26.1406),
('JTR', 'Santorini Thira National Airport',         'Greece',               'SX', 3, 'Europe', 2182,  36.3992,  25.4793),
-- Portugal
('FLW', 'Flores Island Airport',                    'Portugal',             'CS', 1, 'Europe', 1200,  39.4553, -31.1314),
('FNC', 'Funchal Madeira Airport',                  'Portugal',             'CS', 4, 'Europe', 2781,  32.6979, -16.7745),
-- Switzerland / Belgium / Netherlands / Ireland already seeded (INSERT OR IGNORE skips)
('ANR', 'Antwerpen International Airport',          'Belgium',              'OO', 2, 'Europe', 2900,  51.1894,   4.4603),
('CRL', 'Brussels South Charleroi Airport',         'Belgium',              'OO', 4, 'Europe', 3211,  50.4592,   4.4538),
('EIN', 'Eindhoven Airport',                        'Netherlands',          'PH', 4, 'Europe', 3000,  51.4501,   5.3744),
('CFN', 'Donegal Airport',                          'Ireland',              'EI', 1, 'Europe', 1500,  55.0442,  -8.3408),
('GWY', 'Galway Airport',                           'Ireland',              'EI', 1, 'Europe', 1524,  53.2992,  -8.9459),
('ORK', 'Cork International Airport',               'Ireland',              'EI', 4, 'Europe', 2133,  51.8413,  -8.4911),
-- Russia
('AER', 'Adler-Sochi Airport',                      'Russia',               'RA', 4, 'Europe', 2900,  43.4499,  39.9566),
('ARH', 'Arkhangelsk Talagi Airport',               'Russia',               'RA', 3, 'Europe', 2500,  64.6003,  40.7167),
-- Romania
('BCM', 'Bacau George Enescu Airport',              'Romania',              'YR', 3, 'Europe', 2400,  46.5219,  26.9103),
('BAY', 'Baia Mare Airport',                        'Romania',              'YR', 2, 'Europe', 1700,  47.6584,  23.47),
('BBU', 'Bucharest Baneasa Airport',                'Romania',              'YR', 2, 'Europe', 1800,  44.5032,  26.1021),
('CLJ', 'Cluj-Napoca International Airport',        'Romania',              'YR', 3, 'Europe', 2900,  46.7852,  23.6862),
('CND', 'Constanta Mihail Kogalniceanu Airport',    'Romania',              'YR', 3, 'Europe', 3500,  44.3622,  28.4883),
('CRA', 'Craiova International Airport',            'Romania',              'YR', 3, 'Europe', 2500,  44.3181,  23.8886),
('DEB', 'Debrecen International Airport',           'Hungary',              'HA', 3, 'Europe', 2006,  47.4889,  21.6153),
-- Czech Republic
('BRQ', 'Brno Turany Airport',                      'Czech Republic',       'OK', 3, 'Europe', 2650,  49.1513,  16.6944),
-- Poland
('BZG', 'Bydgoszcz Ignacy Jan Paderewski Airport', 'Poland',               'SP', 3, 'Europe', 2500,  53.0968,  17.9777),
-- Croatia
('DBV', 'Dubrovnik Airport',                        'Croatia',              '9A', 4, 'Europe', 3300,  42.5614,  18.2682),
-- Bulgaria
('BOJ', 'Burgas Airport',                           'Bulgaria',             'LZ', 4, 'Europe', 3200,  42.5696,  27.5152),
-- Moldova
('KIV', 'Chisinau International Airport',           'Moldova',              'ER', 3, 'Europe', 3590,  46.9277,  28.9303),
-- Ukraine
('DNK', 'Dnepropetrovsk Airport',                   'Ukraine',              'UR', 3, 'Europe', 3100,  48.3572,  35.1006),
('DOK', 'Donetsk Airport',                          'Ukraine',              'UR', 3, 'Europe', 2500,  48.0736,  37.7397),
-- Georgia
('BUS', 'Batumi Alexander Kartveli Airport',        'Georgia',              '4L', 3, 'Europe', 2500,  41.6103,  41.5997),
-- Bosnia and Herzegovina
('BNX', 'Banja Luka Airport',                       'Bosnia and Herzegovina','T9',2, 'Europe', 2400,  44.9414,  17.2975),
-- Kosovo
('GJK', 'Gjakova Airport',                          'Kosovo',               'Z6', 1, 'Europe', 1800,  42.3667,  20.3833),
-- Already in DB (skipped by INSERT OR IGNORE): AMS, ATH, BCN, BSL, BRU, BUD, DUB, DUS, FAO, FRA, GDN, GVA, OTP
-- These are included anyway so INSERT OR IGNORE silently skips them:
('AMS', 'Amsterdam Schiphol Airport',               'Netherlands',          'PH', 7, 'Europe', 3800,  52.3105,   4.7683),
('ATH', 'Athens Eleftherios Venizelos Airport',     'Greece',               'SX', 5, 'Europe', 4000,  37.9364,  23.9445),
('BCN', 'Barcelona El Prat Airport',                'Spain',                'EC', 6, 'Europe', 3743,  41.2974,   2.0833),
('BSL', 'EuroAirport Basel-Mulhouse-Freiburg',      'Switzerland',          'HB', 4, 'Europe', 3900,  47.5896,   7.5299),
('BRU', 'Brussels Zaventem Airport',                'Belgium',              'OO', 5, 'Europe', 3638,  50.901,    4.4844),
('BUD', 'Budapest Liszt Ferenc Airport',            'Hungary',              'HA', 4, 'Europe', 3707,  47.4298,  19.2611),
('DUB', 'Dublin International Airport',             'Ireland',              'EI', 5, 'Europe', 3110,  53.4213,  -6.2701),
('DUS', 'Düsseldorf Airport',                       'Germany',              'D',  5, 'Europe', 3000,  51.2895,   6.7668),
('FAO', 'Faro Airport',                             'Portugal',             'CS', 4, 'Europe', 2880,  37.0144,  -7.9659),
('FRA', 'Frankfurt International Airport',          'Germany',              'D',  7, 'Europe', 4000,  50.0379,   8.5622),
('GDN', 'Gdansk Lech Walesa Airport',               'Poland',               'SP', 3, 'Europe', 2800,  54.3776,  18.4662),
('GVA', 'Geneva Airport',                           'Switzerland',          'HB', 5, 'Europe', 3900,  46.2381,   6.109),
('OTP', 'Bucharest Henri Coanda Airport',           'Romania',              'YR', 4, 'Europe', 3500,  44.5711,  26.085);

-- European airport expansion batch 2 (INSERT OR IGNORE — skips any IATA already present)
INSERT OR IGNORE INTO airports (iata_code, name, country, registration_prefix, category, continent, runway_length_m, latitude, longitude) VALUES
-- United Kingdom
('GLA', 'Glasgow International Airport',            'United Kingdom',       'G',  5, 'Europe', 2658,  55.8719,  -4.4331),
('HUY', 'Kingston upon Hull Humberside Airport',    'United Kingdom',       'G',  3, 'Europe', 2194,  53.5744,  -0.3508),
('INV', 'Inverness Airport',                        'United Kingdom',       'G',  2, 'Europe', 1893,  57.5425,  -4.0475),
('ILY', 'Islay Airport',                            'United Kingdom',       'G',  1, 'Europe', 1215,  55.6817,  -6.2567),
('KOI', 'Kirkwall Airport',                         'United Kingdom',       'G',  2, 'Europe', 1411,  58.9578,  -2.905),
('LBA', 'Leeds Bradford International Airport',     'United Kingdom',       'G',  4, 'Europe', 2259,  53.8659,  -1.6606),
('LPL', 'Liverpool John Lennon Airport',            'United Kingdom',       'G',  4, 'Europe', 2286,  53.3336,  -2.8497),
('LDY', 'Londonderry Eglinton Airport',             'United Kingdom',       'G',  2, 'Europe', 2094,  55.0428,  -7.1611),
('LTN', 'London Luton Airport',                     'United Kingdom',       'G',  5, 'Europe', 2162,  51.8747,  -0.3683),
('SEN', 'London Southend Airport',                  'United Kingdom',       'G',  3, 'Europe', 1855,  51.5714,   0.6956),
('STN', 'London Stansted Airport',                  'United Kingdom',       'G',  6, 'Europe', 3048,  51.885,    0.235),
-- Germany
('CGN', 'Cologne Bonn Airport',                     'Germany',              'D',  5, 'Europe', 3815,  50.8659,   7.1427),
('HAM', 'Hamburg Fuhlsbüttel Airport',              'Germany',              'D',  4, 'Europe', 3666,  53.6304,  10.0062),
('HDF', 'Heringsdorf Airport',                      'Germany',              'D',  1, 'Europe', 2200,  53.8788,  14.1522),
('HOQ', 'Hof Plauen Airport',                       'Germany',              'D',  1, 'Europe', 1600,  50.2888,  11.8567),
('IGS', 'Ingolstadt Manching Airport',              'Germany',              'D',  1, 'Europe', 3000,  48.7157,  11.534),
('FKB', 'Karlsruhe Baden-Baden Airport',            'Germany',              'D',  3, 'Europe', 3600,  48.7794,   8.0805),
('KSF', 'Kassel Calden Airport',                    'Germany',              'D',  2, 'Europe', 2990,  51.4178,   9.3775),
('KIE', 'Kiel-Holtenau Airport',                    'Germany',              'D',  1, 'Europe', 1800,  54.3794,  10.145),
('LBC', 'Lübeck Airport',                           'Germany',              'D',  2, 'Europe', 2090,  53.8053,  10.7192),
('LEJ', 'Leipzig Halle Airport',                    'Germany',              'D',  4, 'Europe', 3600,  51.4324,  12.2416),
('MHG', 'Mannheim City Airport',                    'Germany',              'D',  1, 'Europe', 1200,  49.4731,   8.5144),
('FMM', 'Memmingen Airport',                        'Germany',              'D',  3, 'Europe', 2500,  47.9888,  10.2395),
-- France
('GNB', 'Grenoble Isère Airport',                   'France',               'F',  3, 'Europe', 3000,  45.3629,   5.3294),
('LRH', 'La Rochelle Airport',                      'France',               'F',  2, 'Europe', 2100,  46.1792,  -1.1953),
('LHS', 'Le Havre Octeville Airport',               'France',               'F',  2, 'Europe', 2100,  49.5339,   0.0881),
('LIL', 'Lille Lesquin International Airport',      'France',               'F',  4, 'Europe', 3600,  50.5619,   3.0894),
('LIG', 'Limoges Bellegarde Airport',               'France',               'F',  2, 'Europe', 2900,  45.8628,   1.1794),
('LRT', 'Lorient Bretagne Sud Airport',             'France',               'F',  2, 'Europe', 2400,  47.7606,  -3.44),
('ETZ', 'Metz Nancy Lothringen Airport',            'France',               'F',  2, 'Europe', 2440,  48.9822,   6.2517),
('MPL', 'Montpellier Mediterranee Airport',         'France',               'F',  4, 'Europe', 3300,  43.5763,   3.963),
-- Sweden
('GSE', 'Göteborg City Airport',                    'Sweden',               'SE', 2, 'Europe', 1700,  57.7747,  11.8703),
('GOT', 'Göteborg Landvetter Airport',              'Sweden',               'SE', 5, 'Europe', 3300,  57.6628,  12.2798),
('HAD', 'Halmstad Airport',                         'Sweden',               'SE', 1, 'Europe', 2000,  56.6911,  12.8201),
('HMV', 'Hemavan Tärnaby Airport',                  'Sweden',               'SE', 1, 'Europe', 1400,  65.8061,  15.0828),
('JKG', 'Jonkoping Airport',                        'Sweden',               'SE', 2, 'Europe', 2200,  57.7576,  14.0687),
('KLR', 'Kalmar Airport',                           'Sweden',               'SE', 2, 'Europe', 2200,  56.6856,  16.2876),
('KSD', 'Karlstad Airport',                         'Sweden',               'SE', 2, 'Europe', 2200,  59.4447,  13.3374),
('KRN', 'Kiruna Airport',                           'Sweden',               'SE', 2, 'Europe', 2500,  67.822,   20.3368),
('LPI', 'Linköping Airport',                        'Sweden',               'SE', 2, 'Europe', 2600,  58.4062,  15.6805),
('LLA', 'Luleå Airport',                            'Sweden',               'SE', 3, 'Europe', 2800,  65.5438,  22.122),
('MMX', 'Malmö Sturup Airport',                     'Sweden',               'SE', 4, 'Europe', 2800,  55.5363,  13.3762),
-- Norway
('HAU', 'Haugesund Karmøy Airport',                 'Norway',               'LN', 3, 'Europe', 2450,  59.3453,   5.2084),
('KKN', 'Kirkenes Airport',                         'Norway',               'LN', 2, 'Europe', 2158,  69.7258,  29.8913),
('LYR', 'Longyearbyen Svalbard Airport',            'Norway',               'LN', 2, 'Europe', 2320,  78.2461,  15.4656),
('MOL', 'Molde Aro Airport',                        'Norway',               'LN', 2, 'Europe', 1981,  62.7447,   7.2625),
-- Finland
('IVL', 'Ivalo Airport',                            'Finland',              'OH', 2, 'Europe', 2500,  68.6073,  27.4053),
('JOE', 'Joensuu Airport',                          'Finland',              'OH', 2, 'Europe', 2000,  62.6629,  29.6075),
('JYV', 'Jyvaskyla Airport',                        'Finland',              'OH', 2, 'Europe', 2500,  62.3995,  25.6783),
('KAJ', 'Kajaani Airport',                          'Finland',              'OH', 2, 'Europe', 2000,  64.2855,  27.6924),
('KAU', 'Kauhava Airport',                          'Finland',              'OH', 1, 'Europe', 2500,  63.1272,  23.0514),
('KEM', 'Kemi-Tornio Airport',                      'Finland',              'OH', 2, 'Europe', 2500,  65.7787,  24.5821),
('KTT', 'Kittila Airport',                          'Finland',              'OH', 2, 'Europe', 2500,  67.701,   24.8468),
('KOK', 'Kokkola Pietarsaari Airport',              'Finland',              'OH', 2, 'Europe', 2000,  63.7212,  23.1431),
('KAO', 'Kuusamo Airport',                          'Finland',              'OH', 2, 'Europe', 2500,  65.9876,  29.2394),
('MHQ', 'Mariehamn Airport',                        'Finland',              'OH', 1, 'Europe', 1800,  60.1222,  19.8982),
-- Iceland
('KEF', 'Keflavik International Airport',           'Iceland',              'TF', 5, 'Europe', 3060,  63.985,  -22.6056),
-- Greece
('KLX', 'Kalamata International Airport',           'Greece',               'SX', 2, 'Europe', 3000,  37.0683,  22.0255),
('AOK', 'Karpathos Airport',                        'Greece',               'SX', 2, 'Europe', 1540,  35.4214,  27.146),
('KSO', 'Kastoria Aristotelis Airport',             'Greece',               'SX', 2, 'Europe', 1800,  40.4463,  21.2822),
('KVA', 'Kavala Megas Alexandros Airport',          'Greece',               'SX', 3, 'Europe', 2670,  40.9133,  24.6192),
('EFL', 'Kefalonia Island International Airport',   'Greece',               'SX', 3, 'Europe', 2340,  38.12,    20.5005),
('HER', 'Heraklion Nikos Kazantzakis Airport',      'Greece',               'SX', 5, 'Europe', 2686,  35.3397,  25.1803),
('IOA', 'Ioannina King Pyrrhus Airport',            'Greece',               'SX', 2, 'Europe', 2700,  39.6964,  20.8225),
('JIK', 'Ikaria Island National Airport',           'Greece',               'SX', 1, 'Europe', 1200,  37.6833,  26.35),
('KIT', 'Kithira Island National Airport',          'Greece',               'SX', 1, 'Europe', 1400,  36.2742,  23.017),
('KGS', 'Kos Hippocrates International Airport',    'Greece',               'SX', 4, 'Europe', 2690,  36.7933,  27.0917),
('CFU', 'Corfu Ioannis Kapodistrias Airport',       'Greece',               'SX', 4, 'Europe', 2374,  39.6019,  19.9117),
('LXS', 'Lemnos International Airport',             'Greece',               'SX', 2, 'Europe', 2450,  39.9167,  25.2364),
('LRS', 'Leros Island National Airport',            'Greece',               'SX', 1, 'Europe', 1500,  37.1847,  26.8003),
('MLO', 'Milos Island National Airport',            'Greece',               'SX', 1, 'Europe', 1200,  36.6969,  24.4769),
-- Spain
('GRX', 'Granada Jaén Federico García Lorca Airport','Spain',               'EC', 3, 'Europe', 3200,  37.1887,  -3.7775),
('HSK', 'Huesca Pirineos Airport',                  'Spain',                'EC', 1, 'Europe', 2200,  42.0762,  -0.3165),
('IBZ', 'Ibiza San José Airport',                   'Spain',                'EC', 4, 'Europe', 2800,  38.8729,   1.3731),
('LCG', 'La Coruña Alvedro Airport',                'Spain',                'EC', 3, 'Europe', 3000,  43.3021,  -8.3776),
('LPA', 'Las Palmas Gran Canaria Airport',          'Spain',                'EC', 5, 'Europe', 3100,  27.9319, -15.3866),
('LEN', 'León San Carlos Airport',                  'Spain',                'EC', 2, 'Europe', 1800,  42.589,   -5.6556),
('LLD', 'Lleida-Alguaire Airport',                  'Spain',                'EC', 1, 'Europe', 2700,  41.7281,   0.5352),
('MAH', 'Menorca Airport',                          'Spain',                'EC', 3, 'Europe', 2350,  39.8626,   4.2186),
('MLN', 'Melilla Airport',                          'Spain',                'EC', 1, 'Europe', 1400,  35.2798,  -2.9563),
-- Austria
('GRZ', 'Graz Thalerhof Airport',                   'Austria',              'OE', 4, 'Europe', 3500,  46.9911,  15.4396),
('INN', 'Innsbruck Kranebitten Airport',            'Austria',              'OE', 3, 'Europe', 2000,  47.2602,  11.344),
('KLU', 'Klagenfurt Wörthersee Airport',            'Austria',              'OE', 3, 'Europe', 3100,  46.6425,  14.3378),
('LNZ', 'Linz Airport',                             'Austria',              'OE', 3, 'Europe', 3000,  48.2332,  14.1875),
-- Italy
('LIN', 'Milano Linate Airport',                    'Italy',                'I',  4, 'Europe', 2442,  45.4455,   9.2767),
-- Portugal
('HOR', 'Horta Airport',                            'Portugal',             'CS', 1, 'Europe', 1700,  38.5199, -28.7159),
-- Netherlands
('GRQ', 'Groningen Eelde Airport',                  'Netherlands',          'PH', 2, 'Europe', 2500,  53.1197,   6.5794),
('MST', 'Maastricht Aachen Airport',                'Netherlands',          'PH', 3, 'Europe', 2750,  50.9117,   5.77),
-- Belgium
('LGG', 'Liège Bierset Airport',                    'Belgium',              'OO', 3, 'Europe', 3689,  50.6374,   5.4432),
-- Switzerland
('LUG', 'Lugano Airport',                           'Switzerland',          'HB', 2, 'Europe', 1605,  46.0043,   8.9106),
-- Ireland
('KIR', 'Kerry Airport',                            'Ireland',              'EI', 2, 'Europe', 2000,  52.1809,  -9.5237),
('NOC', 'Knock International Airport',              'Ireland',              'EI', 3, 'Europe', 2290,  53.9103,  -8.8185),
-- Estonia
('KDL', 'Kardla Airport',                           'Estonia',              'ES', 1, 'Europe', 1600,  58.9908,  22.8308),
-- Lithuania
('KUN', 'Kaunas International Airport',             'Lithuania',            'LY', 3, 'Europe', 2800,  54.9639,  24.0848),
-- Czech Republic
('KLV', 'Karlovy Vary International Airport',       'Czech Republic',       'OK', 2, 'Europe', 2500,  50.203,   12.915),
-- Slovakia
('KSC', 'Kosice International Airport',             'Slovakia',             'OM', 3, 'Europe', 2600,  48.6631,  21.2411),
-- Poland
('KTW', 'Katowice International Airport',           'Poland',               'SP', 4, 'Europe', 3200,  50.4743,  19.08),
('LCJ', 'Lodz Wladyslaw Reymont Airport',           'Poland',               'SP', 3, 'Europe', 2600,  51.7219,  19.3981),
('LUZ', 'Lublin Swidnik Airport',                   'Poland',               'SP', 3, 'Europe', 2520,  51.2403,  22.7131),
-- Romania
('IAS', 'Iasi International Airport',               'Romania',              'YR', 3, 'Europe', 2400,  47.1785,  27.6206),
-- Ukraine
('HRK', 'Kharkov Airport',                          'Ukraine',              'UR', 3, 'Europe', 3100,  49.9248,  36.29),
('KBP', 'Kiev Boryspil International Airport',      'Ukraine',              'UR', 5, 'Europe', 4000,  50.345,   30.8947),
('IEV', 'Kiev Zhuliany Airport',                    'Ukraine',              'UR', 3, 'Europe', 2310,  50.4017,  30.4497),
('LWO', 'Lviv Danylo Halytskyi Airport',            'Ukraine',              'UR', 3, 'Europe', 2600,  49.8125,  23.9561),
-- Russia
('KGD', 'Kaliningrad Airport',                      'Russia',               'RA', 3, 'Europe', 2500,  54.89,    20.5926),
('KZN', 'Kazan Airport',                            'Russia',               'RA', 4, 'Europe', 3200,  55.6063,  49.2788),
('MRV', 'Mineralnyje Wody Airport',                 'Russia',               'RA', 3, 'Europe', 2800,  44.2251,  43.0819),
('SVO', 'Moscow Sheremetyevo Airport',              'Russia',               'RA', 6, 'Europe', 3700,  55.9726,  37.4146),
-- Turkey
('IST', 'Istanbul Airport',                         'Turkey',               'TC', 8, 'Europe', 4100,  41.2608,  28.7418),
-- Belarus
('MSQ', 'Minsk International Airport',              'Belarus',              'EW', 4, 'Europe', 3500,  53.8825,  28.0307),
-- Malta
('MLA', 'Malta Luqa Airport',                       'Malta',                '9H', 4, 'Europe', 3600,  35.8575,  14.4775),
-- Luxembourg
('LUX', 'Luxembourg Findel Airport',                'Luxembourg',           'LX', 4, 'Europe', 4000,  49.6233,   6.2044),
-- Guernsey
('GUW', 'Guernsey Airport',                         'Guernsey',             'G',  2, 'Europe', 1463,  49.435,   -2.6019),
-- Isle of Man
('IOM', 'Isle of Man Airport',                      'Isle of Man',          'M',  3, 'Europe', 1988,  54.0833,  -4.6239),
-- Slovenia
('MBX', 'Maribor Edvard Rusjan Airport',            'Slovenia',             'S5', 2, 'Europe', 2500,  46.4799,  15.6861),
-- Denmark (additional)
('KRP', 'Karup Airport',                            'Denmark',              'OY', 2, 'Europe', 2600,  56.2975,   9.1247),
('RKE', 'Copenhagen Roskilde Airport',              'Denmark',              'OY', 1, 'Europe', 2100,  55.5856,  12.1314),
-- Already in DB (skipped by INSERT OR IGNORE): CPH, HAM, HEL, IST, LGW, LHR, LIS, LJU, LYS, MAD, MAN, MRS, MXP
('CPH', 'Copenhagen Kastrup Airport',               'Denmark',              'OY', 5, 'Europe', 3600,  55.618,   12.656),
('HAM', 'Hamburg Fuhlsbüttel Airport',              'Germany',              'D',  4, 'Europe', 3666,  53.6304,  10.0062),
('HEL', 'Helsinki Vantaa Airport',                  'Finland',              'OH', 5, 'Europe', 3440,  60.3172,  24.9633),
('LGW', 'London Gatwick Airport',                   'United Kingdom',       'G',  6, 'Europe', 3316,  51.1537,  -0.1821),
('LHR', 'London Heathrow Airport',                  'United Kingdom',       'G',  8, 'Europe', 3902,  51.47,    -0.4543),
('LIS', 'Lisbon Humberto Delgado Airport',          'Portugal',             'CS', 5, 'Europe', 3805,  38.7813,  -9.1359),
('LJU', 'Ljubljana Joze Pucnik Airport',            'Slovenia',             'S5', 3, 'Europe', 3300,  46.2237,  14.4576),
('LYS', 'Lyon Saint-Exupery Airport',               'France',               'F',  4, 'Europe', 4000,  45.7256,   5.0811),
('MAD', 'Madrid Barajas Airport',                   'Spain',                'EC', 7, 'Europe', 4349,  40.4936,  -3.5668),
('MAN', 'Manchester Airport',                       'United Kingdom',       'G',  5, 'Europe', 3048,  53.3537,  -2.275),
('MRS', 'Marseille Provence Airport',               'France',               'F',  4, 'Europe', 3500,  43.4393,   5.2214),
('MXP', 'Milano Malpensa Airport',                  'Italy',                'I',  5, 'Europe', 3920,  45.6306,   8.7281),
('AGP', 'Málaga Costa del Sol Airport',             'Spain',                'EC', 5, 'Europe', 3200,  36.6749,  -4.4991);

-- European airport expansion batch 3 (INSERT OR IGNORE — skips any IATA already present)
INSERT OR IGNORE INTO airports (iata_code, name, country, registration_prefix, category, continent, runway_length_m, latitude, longitude) VALUES
('DME', 'Moscow Domodedovo Airport',                      'Russia',                'RA', 6, 'Europe', 3794,  55.4088,  37.9063),
('VKO', 'Moscow Vnukovo Airport',                         'Russia',                'RA', 5, 'Europe', 3600,  55.5915,  37.2615),
('ZIA', 'Moscow Zhukovsky Airport',                       'Russia',                'RA', 3, 'Europe', 5400,  55.5533,  38.15),
('RYG', 'Moss Rygge Airport',                             'Norway',                'LN', 3, 'Europe', 2796,  59.3789,  10.7856),
('OMO', 'Mostar Airport',                                 'Bosnia and Herzegovina','T9', 2, 'Europe', 2400,  43.2829,  17.8459),
('MUC', 'Munich Airport',                                 'Germany',               'D',  6, 'Europe', 4000,  48.3537,  11.775),
('FMO', 'Münster Osnabrück International Airport',        'Germany',               'D',  3, 'Europe', 3600,  52.1346,   7.6848),
('MJV', 'Región de Murcia Airport',                       'Spain',                 'EC', 3, 'Europe', 2800,  37.875,   -1.1253),
('MMK', 'Murmansk Airport',                               'Russia',                'RA', 3, 'Europe', 2700,  68.7817,  32.7508),
('JMK', 'Mykonos Island National Airport',                'Greece',                'SX', 3, 'Europe', 1817,  37.4351,  25.3481),
('MJT', 'Mytilene Odysseas Elytis Airport',               'Greece',                'SX', 3, 'Europe', 2500,  39.0567,  26.5983),
('NTE', 'Nantes Atlantique Airport',                      'France',                'F',  4, 'Europe', 2900,  47.1532,  -1.6108),
('NAP', 'Napoli Capodichino Airport',                     'Italy',                 'I',  4, 'Europe', 2628,  40.886,   14.2908),
('NCE', 'Nice Cote d''Azur Airport',                      'France',                'F',  5, 'Europe', 3000,  43.6584,   7.2159),
('FNI', 'Nimes Arles Camargue Airport',                   'France',                'F',  2, 'Europe', 2400,  43.7574,   4.4163),
('INI', 'Nis Konstantin Veliki Airport',                  'Serbia',                'YU', 3, 'Europe', 2500,  43.3373,  21.8538),
('GOJ', 'Nizhny Novgorod Airport',                        'Russia',                'RA', 3, 'Europe', 2700,  56.2301,  43.784),
('NRK', 'Norrköping Kungsängen Airport',                  'Sweden',                'SE', 2, 'Europe', 2200,  58.5863,  16.2506),
('NWI', 'Norwich International Airport',                  'United Kingdom',        'G',  3, 'Europe', 2095,  52.6758,   1.2828),
('NUE', 'Nürnberg Airport',                               'Germany',               'D',  4, 'Europe', 2700,  49.4987,  11.0669),
('ODS', 'Odessa Airport',                                 'Ukraine',               'UR', 3, 'Europe', 2800,  46.4268,  30.6765),
('OHD', 'Ohrid St. Paul the Apostle Airport',             'North Macedonia',       'Z3', 3, 'Europe', 2550,  41.18,    20.7423),
('OLB', 'Olbia Costa Smeralda Airport',                   'Italy',                 'I',  4, 'Europe', 2868,  40.8987,   9.5176),
('SZY', 'Olsztyn-Mazury Airport',                         'Poland',                'SP', 2, 'Europe', 2000,  53.4819,  20.9378),
('OMR', 'Oradea International Airport',                   'Romania',               'YR', 2, 'Europe', 2500,  47.0253,  21.9025),
('ORB', 'Örebro Airport',                                 'Sweden',                'SE', 2, 'Europe', 2200,  59.2237,  15.038),
('OSW', 'Orenburg International Airport',                 'Russia',                'RA', 3, 'Europe', 2600,  51.7958,  55.4567),
('OER', 'Örnsköldsvik Airport',                           'Sweden',                'SE', 1, 'Europe', 1600,  63.4083,  18.99),
('OSI', 'Osijek Airport',                                 'Croatia',               '9A', 2, 'Europe', 2500,  45.4627,  18.8102),
('OSL', 'Oslo Gardermoen Airport',                        'Norway',                'LN', 5, 'Europe', 3600,  60.1939,  11.1004),
('TRF', 'Oslo Torp Airport',                              'Norway',                'LN', 3, 'Europe', 2888,  59.1867,  10.2586),
('OST', 'Ostende Brugge International Airport',           'Belgium',               'OO', 3, 'Europe', 3200,  51.1988,   2.8622),
('OSD', 'Östersund Frösön Airport',                       'Sweden',                'SE', 2, 'Europe', 2800,  63.1944,  14.5003),
('OSR', 'Ostrava Leos Janacek Airport',                   'Czech Republic',        'OK', 3, 'Europe', 3511,  49.6963,  18.1111),
('OUL', 'Oulu Airport',                                   'Finland',               'OH', 4, 'Europe', 3060,  64.9301,  25.3546),
('OVD', 'Oviedo Asturias International Airport',          'Spain',                 'EC', 3, 'Europe', 3000,  43.5636,  -6.0346),
('PAD', 'Paderborn Lippstadt Airport',                    'Germany',               'D',  3, 'Europe', 2180,  51.6142,   8.6163),
('PLQ', 'Palanga International Airport',                  'Lithuania',             'LY', 2, 'Europe', 2500,  55.9733,  21.0939),
('PMO', 'Palermo Falcone Borsellino Airport',             'Italy',                 'I',  4, 'Europe', 3323,  38.1796,  13.091),
('PMI', 'Palma de Mallorca Airport',                      'Spain',                 'EC', 5, 'Europe', 3270,  39.5517,   2.7388),
('PNA', 'Pamplona Airport',                               'Spain',                 'EC', 2, 'Europe', 2200,  42.77,    -1.6463),
('PNL', 'Pantelleria Airport',                            'Italy',                 'I',  1, 'Europe', 1600,  36.8165,  11.9689),
('PFO', 'Paphos International Airport',                   'Cyprus',                '5B', 4, 'Europe', 2686,  34.718,   32.4857),
('PEG', 'Perugia San Francesco d''Assisi Airport',        'Italy',                 'I',  2, 'Europe', 2000,  43.0959,  12.5131),
('PSR', 'Pescara Abruzzo International Airport',          'Italy',                 'I',  3, 'Europe', 2611,  42.4317,  14.1811),
('PSA', 'Pisa Galileo Galilei Airport',                   'Italy',                 'I',  4, 'Europe', 3000,  43.6839,  10.3927),
('PDV', 'Plovdiv International Airport',                  'Bulgaria',              'LZ', 3, 'Europe', 3200,  42.0678,  24.8508),
('PLH', 'Plymouth City Airport',                          'United Kingdom',        'G',  1, 'Europe', 1500,  50.4228,  -4.1058),
('TGD', 'Podgorica Airport',                              'Montenegro',            '4O', 3, 'Europe', 2500,  42.3594,  19.2519),
('PIS', 'Poitiers Biard Airport',                         'France',                'F',  2, 'Europe', 2100,  46.5877,   0.3067),
('PDL', 'Ponta Delgada Joao Paulo II Airport',            'Portugal',              'CS', 3, 'Europe', 2374,  37.7412, -25.6979),
('TAT', 'Poprad Tatry Airport',                           'Slovakia',              'OM', 2, 'Europe', 3100,  49.0714,  20.2411),
('POR', 'Pori Airport',                                   'Finland',               'OH', 2, 'Europe', 2100,  61.4617,  21.7997),
('OPO', 'Porto Dr. Francisco de Sa Carneiro Airport',     'Portugal',              'CS', 5, 'Europe', 3480,  41.2481,  -8.6814),
('PXO', 'Porto Santo Island Airport',                     'Portugal',              'CS', 2, 'Europe', 2100,  33.0734, -16.35),
('POW', 'Portoroz Airport',                               'Slovenia',              'S5', 1, 'Europe', 1200,  45.4734,  13.615),
('POZ', 'Poznan Lawica Airport',                          'Poland',                'SP', 3, 'Europe', 2504,  52.4211,  16.8263),
('PRG', 'Prague Vaclav Havel Airport',                    'Czech Republic',        'OK', 4, 'Europe', 3715,  50.1008,  14.2632),
('PVK', 'Preveza Aktio Airport',                          'Greece',                'SX', 2, 'Europe', 2378,  38.9255,  20.7653),
('PRN', 'Pristina International Airport',                 'Kosovo',                'Z6', 3, 'Europe', 2500,  42.5728,  21.0358),
('PUY', 'Pula Airport',                                   'Croatia',               '9A', 3, 'Europe', 3200,  44.8935,  13.9222),
('UIP', 'Quimper Cornouaille Airport',                    'France',                'F',  2, 'Europe', 2100,  47.9748,  -4.1678),
('REG', 'Reggio Calabria Airport',                        'Italy',                 'I',  3, 'Europe', 2498,  38.0712,  15.6516),
('RNS', 'Rennes Saint Jacques Airport',                   'France',                'F',  3, 'Europe', 3000,  48.0695,  -1.7347),
('REU', 'Reus Airport',                                   'Spain',                 'EC', 3, 'Europe', 2700,  41.1474,   1.1672),
('RKV', 'Reykjavik Airport',                              'Iceland',               'TF', 2, 'Europe', 1575,  64.1297, -21.9406),
('RHO', 'Rhodes Diagoras International Airport',          'Greece',                'SX', 5, 'Europe', 3306,  36.4054,  28.0862),
('RIX', 'Riga International Airport',                     'Latvia',                'YL', 4, 'Europe', 3200,  56.9236,  23.9711),
('RJK', 'Rijeka Airport',                                 'Croatia',               '9A', 3, 'Europe', 2500,  45.2169,  14.5703),
('RMI', 'Rimini Federico Fellini Airport',                'Italy',                 'I',  3, 'Europe', 3000,  44.0203,  12.6117),
('ROZ', 'Rodez-Marcillac Airport',                        'France',                'F',  1, 'Europe', 2100,  44.4079,   2.4826),
('CIA', 'Roma Ciampino Airport',                          'Italy',                 'I',  4, 'Europe', 2205,  41.7994,  12.5949),
('FCO', 'Roma Fiumicino Airport',                         'Italy',                 'I',  6, 'Europe', 3900,  41.8003,  12.2389),
('RNB', 'Ronneby Airport',                                'Sweden',                'SE', 2, 'Europe', 2500,  56.2667,  15.265),
('RLG', 'Rostock Laage Airport',                          'Germany',               'D',  3, 'Europe', 3000,  53.9183,  12.2783),
('ROV', 'Rostov-on-Don Airport',                          'Russia',                'RA', 3, 'Europe', 3000,  47.2582,  39.8183),
('RTM', 'Rotterdam Den Haag Airport',                     'Netherlands',           'PH', 3, 'Europe', 2438,  51.9569,   4.4372),
('RVN', 'Rovaniemi Airport',                              'Finland',               'OH', 3, 'Europe', 3000,  66.5648,  25.8304),
('RZE', 'Rzeszow Jasionka Airport',                       'Poland',                'SP', 3, 'Europe', 3200,  50.11,    22.019),
('SBZ', 'Sibiu International Airport',                    'Romania',               'YR', 3, 'Europe', 2100,  45.7856,  24.0913),
('SVX', 'Ekaterinburg Koltsovo Airport',                  'Russia',                'RA', 4, 'Europe', 3800,  56.7431,  60.8027),
('SVQ', 'Sevilla San Pablo Airport',                      'Spain',                 'EC', 4, 'Europe', 3450,  37.418,   -5.8931),
('SNN', 'Shannon Airport',                                'Ireland',               'EI', 4, 'Europe', 3199,  52.702,   -8.9248),
('SXF', 'Berlin Brandenburg Airport',                     'Germany',               'D',  5, 'Europe', 4000,  52.3667,  13.5033),
('SKG', 'Thessaloniki Macedonia Airport',                 'Greece',                'SX', 4, 'Europe', 2600,  40.5197,  22.9709),
('SKP', 'Skopje Alexander the Great Airport',             'North Macedonia',       'Z3', 3, 'Europe', 2450,  41.9614,  21.6214),
('SOF', 'Sofia International Airport',                    'Bulgaria',              'LZ', 4, 'Europe', 3600,  42.6952,  23.4114),
('SOU', 'Southampton Airport',                            'United Kingdom',        'G',  3, 'Europe', 1723,  50.9503,  -1.3567),
('SPU', 'Split Kastela Airport',                          'Croatia',               '9A', 4, 'Europe', 2550,  43.5389,  16.298),
('ACH', 'St. Gallen-Altenrhein Airport',                  'Switzerland',           'HB', 2, 'Europe', 1650,  47.485,    9.5608),
('LED', 'St. Petersburg Pulkovo Airport',                 'Russia',                'RA', 5, 'Europe', 3781,  59.8003,  30.2625),
('SVG', 'Stavanger Sola Airport',                         'Norway',                'LN', 4, 'Europe', 2950,  58.8767,   5.6378),
('SZZ', 'Szczecin Goleniow Airport',                      'Poland',                'SP', 3, 'Europe', 3100,  53.5847,  14.9022),
('ARN', 'Stockholm Arlanda Airport',                      'Sweden',                'SE', 5, 'Europe', 3301,  59.6519,  17.9186),
('BMA', 'Stockholm Bromma Airport',                       'Sweden',                'SE', 3, 'Europe', 1620,  59.3544,  17.9417),
('NYO', 'Stockholm Skavsta Airport',                      'Sweden',                'SE', 3, 'Europe', 2796,  58.7886,  16.9122),
('VST', 'Stockholm Vasteras Airport',                     'Sweden',                'SE', 2, 'Europe', 2400,  59.5894,  16.6336),
('SKN', 'Stokmarknes Skagen Airport',                     'Norway',                'LN', 1, 'Europe', 1640,  68.5788,  15.0261),
('SYY', 'Stornoway Airport',                              'United Kingdom',        'G',  2, 'Europe', 1715,  58.2156,  -6.3311),
('SXB', 'Strasbourg International Airport',               'France',                'F',  4, 'Europe', 2400,  48.5383,   7.6283),
('STR', 'Stuttgart Airport',                              'Germany',               'D',  4, 'Europe', 3345,  48.6899,   9.2219),
('SCV', 'Suceava International Airport',                  'Romania',               'YR', 2, 'Europe', 2400,  47.6875,  26.3544),
('LSI', 'Sumburgh Airport',                               'United Kingdom',        'G',  2, 'Europe', 1463,  59.8789,  -1.2956),
('SDL', 'Sundsvall Härnösand Airport',                    'Sweden',                'SE', 2, 'Europe', 2400,  62.5281,  17.4439),
('SWS', 'Swansea Airport',                                'United Kingdom',        'G',  1, 'Europe', 1500,  51.6053,  -4.0678),
('GWT', 'Sylt Airport',                                   'Germany',               'D',  2, 'Europe', 1900,  54.9133,   8.3397),
('TLL', 'Tallinn Lennart Meri Airport',                   'Estonia',               'ES', 3, 'Europe', 3070,  59.4133,  24.8328),
('TMP', 'Tampere Pirkkala Airport',                       'Finland',               'OH', 3, 'Europe', 2600,  61.4142,  23.6044),
('TAR', 'Taranto Grottaglie Airport',                     'Italy',                 'I',  2, 'Europe', 3000,  40.5178,  17.4033),
('LDE', 'Tarbes Lourdes Pyrenees Airport',                'France',                'F',  3, 'Europe', 3000,  43.1787,  -0.0064),
('TGM', 'Targu Mures Vidrasau Airport',                   'Romania',               'YR', 2, 'Europe', 2100,  46.4678,  24.4125),
('TAY', 'Tartu Airport',                                  'Estonia',               'ES', 1, 'Europe', 2400,  58.3075,  26.6903),
('MME', 'Durham Tees Valley Airport',                     'United Kingdom',        'G',  3, 'Europe', 2290,  54.5092,  -1.4294),
('TEN', 'Tenerife Norte Airport',                         'Spain',                 'EC', 4, 'Europe', 2800,  28.4827, -16.3415),
('TFS', 'Tenerife Sur Airport',                           'Spain',                 'EC', 5, 'Europe', 3200,  28.0445, -16.5725),
('TIA', 'Tirana International Airport',                   'Albania',               'ZA', 4, 'Europe', 2750,  41.4147,  19.7206),
('TIV', 'Tivat Airport',                                  'Montenegro',            '4O', 3, 'Europe', 2500,  42.4047,  18.7233),
('TLN', 'Toulon Hyeres Airport',                          'France',                'F',  3, 'Europe', 2200,  43.0973,   6.146),
('TLS', 'Toulouse Blagnac Airport',                       'France',                'F',  4, 'Europe', 3500,  43.6293,   1.3638),
('TUF', 'Tours Loire Valley Airport',                     'France',                'F',  2, 'Europe', 2600,  47.4322,   0.7278),
('TPS', 'Trapani Birgi Vincenzo Florio Airport',          'Italy',                 'I',  3, 'Europe', 3000,  37.9114,  12.4878),
('TSF', 'Treviso Sant''Angelo Antonio Canova Airport',    'Italy',                 'I',  3, 'Europe', 2650,  45.6484,  12.1944),
('TRS', 'Trieste Friuli Venezia Giulia Airport',          'Italy',                 'I',  3, 'Europe', 2500,  45.8275,  13.4722),
('TOS', 'Tromso Langnes Airport',                         'Norway',                'LN', 3, 'Europe', 2252,  69.6833,  18.9189),
('TRD', 'Trondheim Vaernes Airport',                      'Norway',                'LN', 4, 'Europe', 2810,  63.4578,  10.9258),
('TCE', 'Tulcea Airport',                                 'Romania',               'YR', 2, 'Europe', 1800,  45.0625,  28.7144),
('TRN', 'Turin International Airport',                    'Italy',                 'I',  4, 'Europe', 3300,  45.2008,   7.6497),
('TKU', 'Turku Airport',                                  'Finland',               'OH', 3, 'Europe', 2500,  60.5141,  22.2628),
('TZL', 'Tuzla Airport',                                  'Bosnia and Herzegovina','T9', 3, 'Europe', 2500,  44.4587,  18.7248),
('UFA', 'Ufa Airport',                                    'Russia',                'RA', 4, 'Europe', 3600,  54.5575,  55.8744),
('UME', 'Umea City Airport',                              'Sweden',                'SE', 3, 'Europe', 2600,  63.7918,  20.2828),
('VAA', 'Vaasa Airport',                                  'Finland',               'OH', 2, 'Europe', 2500,  63.0508,  21.7622),
('VGO', 'Vigo Peinador Airport',                          'Spain',                 'EC', 3, 'Europe', 3200,  42.2318,  -8.6268),
('VNO', 'Vilnius International Airport',                  'Lithuania',             'LY', 3, 'Europe', 2515,  54.6341,  25.2858),
('VBY', 'Visby Airport',                                  'Sweden',                'SE', 2, 'Europe', 2100,  57.6628,  18.3462),
('VIT', 'Vitoria Airport',                                'Spain',                 'EC', 3, 'Europe', 3500,  42.8828,  -2.7245),
('VOL', 'Volos Nea Anchialos Airport',                    'Greece',                'SX', 3, 'Europe', 2381,  39.2194,  22.7943),
('WAW', 'Warsaw Frederic Chopin Airport',                 'Poland',                'SP', 5, 'Europe', 3690,  52.1657,  20.9671),
('WMI', 'Warsaw Modlin Airport',                          'Poland',                'SP', 3, 'Europe', 2500,  52.4511,  20.6518),
('WEZ', 'Weeze Niederrhein Airport',                      'Germany',               'D',  3, 'Europe', 2400,  51.6022,   6.1422),
('WIC', 'Wick Airport',                                   'United Kingdom',        'G',  1, 'Europe', 1860,  58.4589,  -3.0931),
('VIE', 'Vienna Schwechat Airport',                       'Austria',               'OE', 5, 'Europe', 3600,  48.1103,  16.5697),
('WRO', 'Wroclaw Copernicus Airport',                     'Poland',                'SP', 4, 'Europe', 3200,  51.1027,  16.8858),
('ZAD', 'Zadar Airport',                                  'Croatia',               '9A', 3, 'Europe', 2500,  44.1083,  15.3467),
('ZAG', 'Zagreb Pleso Airport',                           'Croatia',               '9A', 4, 'Europe', 3252,  45.7429,  16.0688),
('ZTH', 'Zakynthos Dionysios Solomos Airport',            'Greece',                'SX', 3, 'Europe', 2200,  37.7509,  20.8843),
('ZAZ', 'Zaragoza Airport',                               'Spain',                 'EC', 3, 'Europe', 3660,  41.6663,  -1.0416),
('ZRH', 'Zurich Airport',                                 'Switzerland',           'HB', 6, 'Europe', 3700,  47.4647,   8.5492);

-- Americas & Caribbean airport expansion batch 1 (INSERT OR IGNORE — skips any IATA already present)
INSERT OR IGNORE INTO airports (iata_code, name, country, registration_prefix, category, continent, runway_length_m, latitude, longitude) VALUES
-- Caribbean
('BGI',  'Grantley Adams International Airport',                          'Barbados',           '8P',   4, 'North America',  3353,  13.0747,  -59.4925),
('SLU',  'George F.L. Charles Airport',                                   'Saint Lucia',        'J6',   2, 'North America',  2097,  14.0202,  -60.9929),
('CYB',  'Charles Kirkconnell International Airport',                     'Cayman Islands',     'VP-C', 2, 'North America',  1829,  19.687,   -79.8828),
('GCM',  'Owen Roberts International Airport',                            'Cayman Islands',     'VP-C', 3, 'North America',  2926,  19.2928,  -81.3577),
('AXA',  'Clayton J. Lloyd International Airport',                        'Anguilla',           'VP-A', 2, 'North America',  1100,  18.2048,  -63.055),
('STX',  'Henry E. Rohlsen Airport',                                      'US Virgin Islands',  'N',    3, 'North America',  2865,  17.7019,  -64.7986),
('BON',  'Bonaire International Airport',                                 'Netherlands',        'PJ',   3, 'North America',  2866,  12.131,   -68.2688),
('FDF',  'Martinique Aime Cesaire International Airport',                 'Martinique',         'F-O',  4, 'North America',  3300,  14.591,   -60.9933),
('GDT',  'JAGS McCartney International Airport',                          'Turks and Caicos',   'VQ-T', 2, 'North America',  1829,  21.4445,  -71.1423),
('FPO',  'Grand Bahama International Airport',                            'Bahamas',            'C6',   3, 'North America',  3231,  26.5587,  -78.6956),
-- Cuba
('HAV',  'Jose Marti International Airport',                              'Cuba',               'CU',   4, 'North America',  4000,  22.9892,  -82.4091),
('HOG',  'Frank Pais Airport',                                            'Cuba',               'CU',   3, 'North America',  3200,  20.7856,  -76.3151),
('CCC',  'Cayo Coco Jardines del Rey Airport',                            'Cuba',               'CU',   3, 'North America',  3000,  22.461,   -78.3284),
('BWW',  'Las Brujas Airport',                                            'Cuba',               'CU',   2, 'North America',  2200,  22.6215,  -79.144),
-- Mexico
('CUN',  'Cancun International Airport',                                  'Mexico',             'XA',   6, 'North America',  3500,  21.0365,  -86.8771),
('GDL',  'Guadalajara International Airport',                             'Mexico',             'XA',   5, 'North America',  4000,  20.5218, -103.3112),
('CZM',  'Cozumel International Airport',                                 'Mexico',             'XA',   3, 'North America',  2743,  20.5224,  -86.9256),
('CME',  'Ciudad del Carmen International Airport',                       'Mexico',             'XA',   3, 'North America',  2750,  18.6537,  -91.799),
('ZIH',  'Ixtapa-Zihuatanejo International Airport',                      'Mexico',             'XA',   3, 'North America',  3200,  17.6016, -101.4606),
('CNA',  'Ciudad Constitucion Airport',                                   'Mexico',             'XA',   1, 'North America',  1800,  25.0538, -111.615),
-- Central America
('GUA',  'La Aurora International Airport',                               'Guatemala',          'TG',   4, 'North America',  2987,  14.5833,  -90.5275),
('FRS',  'Mundo Maya International Airport',                              'Guatemala',          'TG',   2, 'North America',  1800,  16.9138,  -89.8664),
('XPL',  'Comayagua International Airport',                               'Honduras',           'HR',   3, 'North America',  2743,  14.3824,  -87.6216),
('LCE',  'Goloson International Airport',                                 'Honduras',           'HR',   2, 'North America',  2350,  15.7425,  -86.853),
('DAV',  'Enrique Malek International Airport',                           'Panama',             'HP',   2, 'North America',  2012,   8.391,   -82.435),
-- Dominican Republic
('JBQ',  'La Isabela International Airport',                              'Dominican Republic', 'HI',   3, 'North America',  2500,  18.5750,  -69.9859),
-- Venezuela
('CCS',  'Simon Bolivar International Airport',                           'Venezuela',          'YV',   4, 'South America',  3000,  10.6012,  -66.9913),
-- Colombia
('CLO',  'Alfonso Bonilla Aragon International Airport',                  'Colombia',           'HK',   4, 'South America',  3000,   3.5432,  -76.3816),
('CTG',  'Rafael Nunez International Airport',                            'Colombia',           'HK',   4, 'South America',  2560,  10.4424,  -75.513),
('BGA',  'Palonegro International Airport',                               'Colombia',           'HK',   3, 'South America',  2700,   7.1265,  -73.1848),
('CUC',  'Camilo Daza International Airport',                             'Colombia',           'HK',   3, 'South America',  2600,   7.9276,  -72.5115),
('EYP',  'El Yopal El Alcaravan Airport',                                 'Colombia',           'HK',   2, 'South America',  1800,   5.3191,  -72.384),
('IBE',  'Perales Airport',                                               'Colombia',           'HK',   2, 'South America',  1800,   4.4216,  -75.1333),
('IPL',  'San Luis International Airport',                                'Colombia',           'HK',   1, 'South America',  1600,   0.8618,  -77.6718),
-- Ecuador
('GYE',  'Jose Joaquin de Olmedo International Airport',                  'Ecuador',            'HC',   5, 'South America',  2800,  -2.1574,  -79.8836),
('OCC',  'Francisco de Orellana Airport',                                 'Ecuador',            'HC',   2, 'South America',  2100,  -0.4629,  -76.9868),
('CUE',  'Mariscal Lamar Airport',                                        'Ecuador',            'HC',   2, 'South America',  1900,  -2.8895,  -78.9843),
('GPS',  'Seymour Airport',                                               'Ecuador',            'HC',   2, 'South America',  2400,  -0.4538,  -90.2659),
-- Peru
('CUZ',  'Teniente Alejandro Velazco Astete International Airport',       'Peru',               'OB',   3, 'South America',  3400, -13.5357,  -71.9388),
('JUL',  'Inca Manco Capac International Airport',                        'Peru',               'OB',   3, 'South America',  4468, -15.4671,  -70.1578),
('IQT',  'Coronel FAP Francisco Secada Vignetta International Airport',   'Peru',               'OB',   3, 'South America',  2500,  -3.7847,  -73.3088),
('CIX',  'Cap. FAP Jose Abelardo Quinones Gonzales International Airport','Peru',               'OB',   3, 'South America',  2500,  -6.7875,  -79.8281),
('CJA',  'Coronel FAP Armando Revoredo Iglesias Airport',                 'Peru',               'OB',   2, 'South America',  2500,  -7.1392,  -78.4894),
('HUI',  'Alferez FAP David Figueroa Fernandini Airport',                 'Peru',               'OB',   2, 'South America',  2000,  -9.8781,  -76.2048),
-- Bolivia
('CBB',  'Jorge Wilstermann International Airport',                       'Bolivia',            'CP',   3, 'South America',  3800, -17.4211,  -66.1771),
('GYR',  'Guayaramerin Airport',                                          'Bolivia',            'CP',   1, 'South America',  1650, -10.8204,  -65.3457),
-- Chile
('CJC',  'El Loa International Airport',                                  'Chile',              'CC',   3, 'South America',  3830, -22.4982,  -68.9036),
('CCP',  'Carriel Sur International Airport',                             'Chile',              'CC',   3, 'South America',  2700, -36.7727,  -73.0631),
('IQQ',  'Diego Aracena International Airport',                           'Chile',              'CC',   3, 'South America',  3000, -20.5353,  -70.1813),
('IPC',  'Mataveri International Airport',                                'Chile',              'CC',   3, 'South America',  3353, -27.1648, -109.4219),
('CPO',  'Copiapo Airport',                                               'Chile',              'CC',   2, 'South America',  2430, -27.2972,  -70.7792),
('MHC',  'Mocopulli Airport',                                             'Chile',              'CC',   2, 'South America',  1800, -42.3401,  -73.7159),
-- Argentina
('EZE',  'Ministro Pistarini International Airport',                      'Argentina',          'LV',   5, 'South America',  3300, -34.8222,  -58.5358),
('AEP',  'Jorge Newbery Aeroparque',                                      'Argentina',          'LV',   4, 'South America',  2700, -34.5592,  -58.4156),
('COR',  'Ambrosio Taravella International Airport',                      'Argentina',          'LV',   4, 'South America',  3300, -31.3236,  -64.208),
('IGR',  'Cataratas del Iguazu International Airport',                    'Argentina',          'LV',   4, 'South America',  3300, -25.7373,  -54.4734),
('CTC',  'Coronel Felipe Varela International Airport',                   'Argentina',          'LV',   3, 'South America',  3000, -28.5956,  -65.7517),
('CRD',  'General Enrique Mosconi International Airport',                 'Argentina',          'LV',   3, 'South America',  2700, -45.7853,  -67.4655),
('FTE',  'El Calafate Comandante Armando Tola Airport',                   'Argentina',          'LV',   3, 'South America',  2700, -50.2803,  -72.0531),
('EQS',  'Esquel Airport',                                                'Argentina',          'LV',   2, 'South America',  2200, -42.9083,  -71.1395),
('FMA',  'El Pucu Airport',                                               'Argentina',          'LV',   2, 'South America',  2700, -26.2127,  -58.2281),
('DOO',  'Don Torcuato Airport',                                          'Argentina',          'LV',   2, 'South America',  1800, -34.4792,  -58.6161),
-- Paraguay
('AGT',  'Guarani International Airport',                                 'Paraguay',           'ZP',   3, 'South America',  3250, -25.46,    -54.8428),
('ENO',  'Encarnacion Teniente Amin Ayub Airport',                        'Paraguay',           'ZP',   1, 'South America',  1400, -27.2272,  -55.8342),
-- French Guiana
('CAY',  'Cayenne Rochambeau Airport',                                    'French Guiana',      'F-O',  3, 'South America',  3100,   4.8198,  -52.3608),
-- Guyana
('GEO',  'Cheddi Jagan International Airport',                            'Guyana',             '8R',   3, 'South America',  3048,   6.4986,  -58.2541),
-- Jamaica
('KIN',  'Norman Manley International Airport',                           'Jamaica',            '6Y',   4, 'North America',  2743,  17.9357,  -76.7875),
-- Brazil
('VCP',  'Viracopos International Airport',                               'Brazil',             'PP',   5, 'South America',  3240, -23.0074,  -47.1345),
('CWB',  'Afonso Pena International Airport',                             'Brazil',             'PP',   5, 'South America',  2218, -25.5285,  -49.1758),
('FOR',  'Pinto Martins International Airport',                           'Brazil',             'PP',   5, 'South America',  2545,  -3.7763,  -38.5326),
('CGR',  'Campo Grande International Airport',                            'Brazil',             'PP',   4, 'South America',  3300, -20.4688,  -54.6725),
('CGB',  'Marechal Rondon International Airport',                         'Brazil',             'PP',   4, 'South America',  2700, -15.653,   -56.1161),
('GYN',  'Santa Genoveva Airport',                                        'Brazil',             'PP',   4, 'South America',  2900, -16.632,   -49.2207),
('FLN',  'Hercilio Luz International Airport',                            'Brazil',             'PP',   4, 'South America',  2770, -27.6703,  -48.5525),
('IGU',  'Foz do Iguacu Cataratas International Airport',                 'Brazil',             'PP',   4, 'South America',  2785, -25.6003,  -54.4872),
('IOS',  'Jorge Amado Airport',                                           'Brazil',             'PP',   3, 'South America',  2000, -14.816,   -39.0336),
('JPA',  'Presidente Castro Pinto International Airport',                 'Brazil',             'PP',   3, 'South America',  2400,  -7.1483,  -34.9503),
('JOI',  'Lauro Carneiro de Loyola Airport',                              'Brazil',             'PP',   3, 'South America',  2280, -26.2245,  -48.7974),
('JDO',  'Orlando Bezerra de Menezes Regional Airport',                   'Brazil',             'PP',   3, 'South America',  2200,  -7.2189,  -39.2708),
('XAP',  'Serafin Enoss Bertaso Airport',                                 'Brazil',             'PP',   3, 'South America',  2100, -27.1342,  -52.6564),
('CKS',  'Carajas Airport',                                               'Brazil',             'PP',   3, 'South America',  2500,  -6.1153,  -50.0014),
('CPQ',  'Campina Grande Airport',                                        'Brazil',             'PP',   2, 'South America',  2000,  -7.2699,  -35.8964),
('CAC',  'Adalberto Mendes da Silva Airport',                             'Brazil',             'PP',   2, 'South America',  2100, -25.0003,  -53.5006),
('CMG',  'Corumba International Airport',                                 'Brazil',             'PP',   2, 'South America',  2000, -19.0119,  -57.6731),
('CZS',  'Cruzeiro do Sul International Airport',                         'Brazil',             'PP',   2, 'South America',  2000,  -7.5996,  -72.7695),
('FEN',  'Fernando de Noronha Airport',                                   'Brazil',             'PP',   2, 'South America',  2000,  -3.8549,  -32.4233),
('IMP',  'Prefeito Renato Moreira Airport',                               'Brazil',             'PP',   2, 'South America',  2000,  -5.5313,  -47.46),
('JDF',  'Presidente Itamar Franco Airport',                              'Brazil',             'PP',   2, 'South America',  2000, -21.7915,  -43.3868),
('FRC',  'Franca Airport',                                                'Brazil',             'PP',   1, 'South America',  1500, -20.5922,  -47.3829),
('GVP',  'Gaviao Peixoto Airport',                                        'Brazil',             'PP',   1, 'South America',  4572, -21.7747,  -48.4953),
('JDL',  'Jundiai Airport',                                               'Brazil',             'PP',   1, 'South America',  1300, -23.1806,  -46.9444);

-- Americas & Caribbean airport expansion batch 2 (INSERT OR IGNORE — skips any IATA already present)
INSERT OR IGNORE INTO airports (iata_code, name, country, registration_prefix, category, continent, runway_length_m, latitude, longitude) VALUES
-- Honduras
('SAP',  'Ramon Villeda Morales International Airport',                   'Honduras',           'HR',   3, 'North America',  2477,  15.4526,  -87.9236),
-- Bolivia
('LPB',  'El Alto International Airport',                                 'Bolivia',            'CP',   4, 'South America',  4000, -16.5133,  -68.1922),
-- Argentina
('IRJ',  'Capitan Vicente Almandos Almonacid Airport',                    'Argentina',          'LV',   2, 'South America',  2700, -29.3816,  -66.7958),
('LGS',  'Comodoro D. Ricardo Salomon Airport',                           'Argentina',          'LV',   2, 'South America',  3000, -35.4936,  -69.5743),
('MDZ',  'Governor Francisco Gabrielli International Airport',            'Argentina',          'LV',   4, 'South America',  3400, -32.8317,  -68.7929),
('MDQ',  'Astor Piazzola International Airport',                          'Argentina',          'LV',   3, 'South America',  2800, -37.9342,  -57.5733),
('NQN',  'Presidente Peron International Airport',                        'Argentina',          'LV',   3, 'South America',  2700, -38.949,   -68.1557),
('PRA',  'General Justo Jose de Urquiza Airport',                         'Argentina',          'LV',   2, 'South America',  2400, -31.7948,  -60.4804),
('PSS',  'Libertador General Jose de San Martin Airport',                 'Argentina',          'LV',   3, 'South America',  2600, -27.3858,  -55.9707),
('PMY',  'El Tehuelche Airport',                                          'Argentina',          'LV',   2, 'South America',  2000, -42.7592,  -65.1028),
-- Chile
('LSC',  'La Florida Airport',                                            'Chile',              'CC',   3, 'South America',  2700, -29.9162,  -71.1995),
('ZOS',  'Canal Bajo Carlos Hott Siebert Airport',                        'Chile',              'CC',   2, 'South America',  1800, -40.6112,  -73.061),
('PMC',  'El Tepual Airport',                                             'Chile',              'CC',   3, 'South America',  2570, -41.4389,  -73.094),
('PUQ',  'Carlos Ibanez del Campo International Airport',                 'Chile',              'CC',   3, 'South America',  2500, -53.0026,  -70.8545),
('PNT',  'Teniente Julio Gallardo Airport',                               'Chile',              'CC',   1, 'South America',  1400, -51.6715,  -72.5283),
-- Colombia
('LET',  'Alfredo Vasquez Cobo Airport',                                  'Colombia',           'HK',   2, 'South America',  1900,  -4.1933,  -69.9432),
('MZL',  'La Nubia Airport',                                              'Colombia',           'HK',   2, 'South America',  1800,   5.0297,  -75.4647),
('EOH',  'Enrique Olaya Herrera Airport',                                 'Colombia',           'HK',   3, 'South America',  1800,   6.2205,  -75.5906),
('MTR',  'Los Garzones Airport',                                          'Colombia',           'HK',   2, 'South America',  1885,   8.8237,  -75.8258),
('NVA',  'Benito Salas Airport',                                          'Colombia',           'HK',   2, 'South America',  1800,   2.95,    -75.294),
('PEI',  'Matecana International Airport',                                'Colombia',           'HK',   3, 'South America',  2200,   4.8127,  -75.7395),
('PSO',  'Antonio Narino Airport',                                        'Colombia',           'HK',   3, 'South America',  1800,   1.3964,  -77.2915),
('PPN',  'Guillermo Leon Valencia Airport',                               'Colombia',           'HK',   2, 'South America',  1650,   2.4544,  -76.6093),
('PUU',  'Tres de Mayo Airport',                                          'Colombia',           'HK',   1, 'South America',  1800,   0.5053,  -76.5008),
('MCJ',  'La Mina Jorge Isaacs Airport',                                  'Colombia',           'HK',   1, 'South America',  1400,  11.3833,  -72.4933),
('UIB',  'El Carano Airport',                                             'Colombia',           'HK',   1, 'South America',  1600,   5.6958,  -76.6412),
-- Ecuador
('LOH',  'Ciudad de Catamayo Airport',                                    'Ecuador',            'HC',   2, 'South America',  2100,  -3.9959,  -79.3719),
('MEC',  'Eloy Alfaro International Airport',                             'Ecuador',            'HC',   3, 'South America',  2800,  -0.9461,  -80.6788),
('PVO',  'Reales Tamarindos Airport',                                     'Ecuador',            'HC',   2, 'South America',  2000,  -1.0416,  -80.4761),
-- Peru
('LIM',  'Jorge Chavez International Airport',                            'Peru',               'OB',   6, 'South America',  3507, -12.0219,  -77.1143),
('PCL',  'Cap. FAP David Abensur Rengifo International Airport',          'Peru',               'OB',   3, 'South America',  2500,  -8.3779,  -74.5743),
('PIU',  'Cap. Fap. Guillermo Concha Iberico Airport',                    'Peru',               'OB',   3, 'South America',  2500,  -5.2075,  -80.6164),
('PEM',  'Puerto Maldonado International Airport',                        'Peru',               'OB',   3, 'South America',  2600, -12.6136,  -69.2286),
-- Venezuela
('MAR',  'La Chinita International Airport',                              'Venezuela',          'YV',   3, 'South America',  2800,  10.5582,  -71.7279),
('PZO',  'Manuel Carlos Piar Guayana Airport',                            'Venezuela',          'YV',   3, 'South America',  2900,   8.2885,  -62.7604),
('PMV',  'Santiago Marino Caribbean International Airport',               'Venezuela',          'YV',   3, 'South America',  2400,  10.9126,  -63.9666),
-- Uruguay
('MDO',  'Capitan Corbeta C.A. Curbelo International Airport',            'Uruguay',            'CX',   2, 'South America',  1800, -34.9115,  -54.9167),
('MVD',  'Carrasco General Cesareo L. Berisso International Airport',     'Uruguay',            'CX',   4, 'South America',  3200, -34.8384,  -56.0308),
-- Suriname
('PBM',  'Johan Adolf Pengel International Airport',                      'Suriname',           'PZ',   3, 'South America',  3432,   5.4528,  -55.1878),
-- Falkland Islands
('MPN',  'Mount Pleasant Airport',                                        'Falkland Islands',   'VP-F', 2, 'South America',  2591, -51.8228,  -58.4472),
-- Mexico
('BJX',  'Del Bajio International Airport',                               'Mexico',             'XA',   4, 'North America',  3900,  20.9935, -101.4809),
('MEX',  'Benito Juarez International Airport',                           'Mexico',             'XA',   6, 'North America',  3900,  19.4363,  -99.0721),
('MID',  'Manuel Crescencio Rejon International Airport',                 'Mexico',             'XA',   4, 'North America',  3200,  20.937,   -89.6577),
('MLM',  'General Francisco J. Mujica International Airport',             'Mexico',             'XA',   3, 'North America',  3500,  19.8499, -101.0254),
('OAX',  'Xoxocotlan International Airport',                              'Mexico',             'XA',   3, 'North America',  2600,  16.9999,  -96.7266),
('ZLO',  'Playa de Oro International Airport',                            'Mexico',             'XA',   3, 'North America',  2500,  19.1448, -104.5588),
('MTT',  'Minatitlan-Coatzacoalcos National Airport',                     'Mexico',             'XA',   2, 'North America',  2400,  18.1034,  -94.5807),
('PBC',  'Hermanos Serdan International Airport',                         'Mexico',             'XA',   3, 'North America',  3500,  19.1581,  -98.3714),
('PVR',  'Licenciado Gustavo Diaz Ordaz International Airport',           'Mexico',             'XA',   4, 'North America',  3600,  20.6801, -105.2541),
('QRO',  'Queretaro Intercontinental Airport',                            'Mexico',             'XA',   3, 'North America',  3900,  20.6173, -100.1857),
('PXM',  'Puerto Escondido International Airport',                        'Mexico',             'XA',   2, 'North America',  2100,  15.8769,  -97.0891),
-- Costa Rica
('LIR',  'Daniel Oduber Quiros International Airport',                    'Costa Rica',         'TI',   3, 'North America',  2700,  10.5933,  -85.5444),
-- Panama
('PTY',  'Tocumen International Airport',                                 'Panama',             'HP',   5, 'North America',  3400,   9.0714,  -79.3835),
-- Nicaragua
('MGA',  'Augusto C. Sandino International Airport',                      'Nicaragua',          'YN',   3, 'North America',  2963,  12.1415,  -86.1681),
-- Jamaica
('MBJ',  'Sir Donald Sangster International Airport',                     'Jamaica',            '6Y',   4, 'North America',  2865,  18.5037,  -77.9133),
('OCJ',  'Ian Fleming International Airport',                             'Jamaica',            '6Y',   2, 'North America',  1800,  18.4042,  -77.1066),
-- Dominican Republic
('LRM',  'La Romana International Airport',                               'Dominican Republic', 'HI',   3, 'North America',  2895,  18.4507,  -68.9118),
('POP',  'Gregorio Luperon International Airport',                        'Dominican Republic', 'HI',   3, 'North America',  3100,  19.7579,  -70.57),
('PUJ',  'Punta Cana International Airport',                              'Dominican Republic', 'HI',   5, 'North America',  3100,  18.5674,  -68.3634),
('JBQ',  'La Isabela International Airport',                              'Dominican Republic', 'HI',   3, 'North America',  2500,  18.5750,  -69.9859),
-- Bahamas
('NAS',  'Lynden Pindling International Airport',                         'Bahamas',            'C6',   4, 'North America',  3353,  25.039,   -77.4662),
('MHH',  'Marsh Harbour International Airport',                           'Bahamas',            'C6',   2, 'North America',  1524,  26.5114,  -77.0835),
-- Trinidad and Tobago
('POS',  'Piarco International Airport',                                  'Trinidad and Tobago','9Y',   4, 'North America',  3200,  10.5954,  -61.3372),
-- Aruba
('AUA',  'Queen Beatrix International Airport',                           'Aruba',              'P4',   4, 'North America',  2980,  12.5014,  -70.0152),
-- Sint Maarten
('SXM',  'Princess Juliana International Airport',                        'Sint Maarten',       'PJ',   4, 'North America',  2180,  18.041,   -63.1089),
-- Guadeloupe
('PTP',  'Pointe-a-Pitre Le Raizet Airport',                              'Guadeloupe',         'F-O',  4, 'North America',  3480,  16.2653,  -61.5318),
-- Dominica
('DOM',  'Douglas-Charles Airport',                                       'Dominica',           'J7',   2, 'North America',  1463,  15.547,   -61.2997),
-- Saint Kitts and Nevis
('NEV',  'Vance W. Amory International Airport',                          'Saint Kitts and Nevis','V4', 2, 'North America',  1463,  17.2057,  -62.5898),
-- Puerto Rico
('PSE',  'Mercedita Airport',                                             'Puerto Rico',        'N',    3, 'North America',  2896,  18.0083,  -66.563),
-- Turks and Caicos
('PLS',  'Providenciales International Airport',                          'Turks and Caicos',   'VQ-T', 3, 'North America',  2590,  21.7733,  -72.2659),
-- Brazil
('POA',  'Salgado Filho International Airport',                           'Brazil',             'PP',   5, 'South America',  3000, -29.9944,  -51.1714),
('MAO',  'Eduardo Gomes International Airport',                           'Brazil',             'PP',   4, 'South America',  2700,  -3.0386,  -60.0497),
('NAT',  'Aluizio Alves International Airport',                           'Brazil',             'PP',   4, 'South America',  3000,  -5.7682,  -35.3763),
('MCZ',  'Zumbi dos Palmares Airport',                                    'Brazil',             'PP',   4, 'South America',  2400,  -9.5108,  -35.7917),
('LDB',  'Gov. Jose Richa Airport',                                       'Brazil',             'PP',   3, 'South America',  2500, -23.3336,  -51.1301),
('MCP',  'Alberto Alcolumbre International Airport',                      'Brazil',             'PP',   3, 'South America',  2400,   0.0507,  -51.0722),
('MOC',  'Montes Claros Airport',                                         'Brazil',             'PP',   3, 'South America',  2400, -16.7069,  -43.8189),
('MGF',  'Silvio Name Junior Regional Airport',                           'Brazil',             'PP',   3, 'South America',  2180, -23.4761,  -52.0122),
('MAB',  'Joao Correa da Rocha Airport',                                  'Brazil',             'PP',   3, 'South America',  2500,  -5.3686,  -49.1381),
('NVT',  'Ministro Victor Konder International Airport',                  'Brazil',             'PP',   3, 'South America',  2180, -26.8799,  -48.6514),
('PET',  'Pelotas International Airport',                                 'Brazil',             'PP',   3, 'South America',  2300, -31.7184,  -52.3277),
('PMW',  'Brigadeiro Lysias Rodrigues Airport',                           'Brazil',             'PP',   3, 'South America',  2300, -10.2919,  -48.3569),
('BPS',  'Porto Seguro Airport',                                          'Brazil',             'PP',   3, 'South America',  2100, -16.4386,  -39.0808),
('PVH',  'Governador Jorge Teixeira de Oliveira Airport',                 'Brazil',             'PP',   3, 'South America',  2300,  -8.7093,  -63.9023),
('PNZ',  'Senador Nilo Coelho Airport',                                   'Brazil',             'PP',   3, 'South America',  2400,  -9.3624,  -40.5691),
('PHB',  'Prefeito Dr. Joao Silva Filho International Airport',           'Brazil',             'PP',   2, 'South America',  2300,  -2.8938,  -41.732),
('PMG',  'Ponta Pora International Airport',                              'Brazil',             'PP',   2, 'South America',  2000, -22.5496,  -55.7026),
('PPB',  'Presidente Prudente Airport',                                   'Brazil',             'PP',   2, 'South America',  1980, -22.1751,  -51.4246),
('MII',  'Marilia Airport',                                               'Brazil',             'PP',   2, 'South America',  2000, -22.1968,  -49.9264),
('IMP',  'Prefeito Renato Moreira Airport',                               'Brazil',             'PP',   2, 'South America',  2000,  -5.5313,  -47.46),
('OUI',  'Ourinhos Airport',                                              'Brazil',             'PP',   1, 'South America',  1400, -22.9667,  -49.9133),
('LNS',  'Lins Airport',                                                  'Brazil',             'PP',   1, 'South America',  1600, -21.6639,  -49.7306),
('QHB',  'Pedro Morganti Airport',                                         'Brazil',             'PP',   1, 'South America',  1200, -22.7115,  -47.6182);

-- Americas & Caribbean airport expansion batch 3 (INSERT OR IGNORE — skips any IATA already present)
INSERT OR IGNORE INTO airports (iata_code, name, country, registration_prefix, category, continent, runway_length_m, latitude, longitude) VALUES
-- Ecuador
('UIO',  'Mariscal Sucre International Airport',                          'Ecuador',            'HC',   5, 'South America',  4100,  -0.1292,  -78.3575),
('GPS',  'Seymour Baltra Airport',                                          'Ecuador',            'HC',   2, 'South America',  2400,  -0.4538,  -90.2659),
('SCY',  'San Cristobal Airport',                                          'Ecuador',            'HC',   1, 'South America',  1905,  -0.9102,  -89.6174),
-- Peru
('TRU',  'Cap. Carlos Martinez De Pinillos International Airport',        'Peru',               'OB',   3, 'South America',  3000,  -8.0814,  -79.1088),
('TPP',  'Tarapoto Airport',                                              'Peru',               'OB',   2, 'South America',  2500,  -6.5088,  -76.3728),
('TCQ',  'Coronel FAP Carlos Ciriani Santa Rosa Airport',                 'Peru',               'OB',   2, 'South America',  2500, -18.0533,  -70.2758),
('TBP',  'Cap. FAP Pedro Canga Rodriguez Airport',                        'Peru',               'OB',   2, 'South America',  2000,  -3.5525,  -80.3814),
-- Bolivia
('LPB',  'El Alto International Airport',                                 'Bolivia',            'CP',   4, 'South America',  4000, -16.5133,  -68.1922),
('VVI',  'Viru Viru International Airport',                               'Bolivia',            'CP',   4, 'South America',  3500, -17.6448,  -63.1354),
('SRZ',  'El Trompillo Airport',                                          'Bolivia',            'CP',   3, 'South America',  2700, -17.8116,  -63.1715),
('SRE',  'Juana Azurduy de Padilla International Airport',                'Bolivia',            'CP',   2, 'South America',  3800, -19.0071,  -65.2876),
('TJA',  'Capitan Oriel Lea Plaza Airport',                               'Bolivia',            'CP',   2, 'South America',  2800, -21.5557,  -64.7013),
('TDD',  'Teniente Jorge Henrich Arauz Airport',                          'Bolivia',            'CP',   2, 'South America',  2100, -14.8186,  -64.918),
('RIB',  'Gen Buech Airport',                                             'Bolivia',            'CP',   1, 'South America',  1500, -10.9833,  -66.0),
('GYR',  'Guayaramerin Airport',                                          'Bolivia',            'CP',   1, 'South America',  1650, -10.8204,  -65.3457),
('BYC',  'Yacuiba Airport',                                               'Bolivia',            'CP',   1, 'South America',  2000, -21.9608,  -63.6517),
-- Chile
('SCL',  'Arturo Merino Benitez International Airport',                   'Chile',              'CC',   6, 'South America',  3800, -33.3929,  -70.7854),
('ZCO',  'Maquehue Airport',                                              'Chile',              'CC',   3, 'South America',  2400, -38.7668,  -72.6371),
('ZAL',  'Pichoy Airport',                                                'Chile',              'CC',   2, 'South America',  2200, -39.65,    -73.0861),
-- Argentina
('ROS',  'Islas Malvinas International Airport',                          'Argentina',          'LV',   4, 'South America',  3400, -32.9036,  -60.7856),
('TUC',  'Teniente Gral Benjamin Matienzo International Airport',         'Argentina',          'LV',   3, 'South America',  3400, -26.8409,  -65.1049),
('SLA',  'Martin Miguel de Gueemes International Airport',                'Argentina',          'LV',   3, 'South America',  2700, -24.856,   -65.4862),
('UAQ',  'Domingo Faustino Sarmiento Airport',                            'Argentina',          'LV',   3, 'South America',  3000, -31.5715,  -68.4182),
('RES',  'Resistencia International Airport',                             'Argentina',          'LV',   3, 'South America',  2700, -27.45,    -59.0561),
('RGL',  'Rio Gallegos International Airport',                            'Argentina',          'LV',   3, 'South America',  2700, -51.6089,  -69.3126),
('RSA',  'Santa Rosa Airport',                                            'Argentina',          'LV',   3, 'South America',  2700, -36.5883,  -64.2758),
('PSS',  'Libertador General Jose de San Martin Airport',                 'Argentina',          'LV',   3, 'South America',  2600, -27.3858,  -55.9707),
('USH',  'Malvinas Argentinas International Airport',                     'Argentina',          'LV',   3, 'South America',  3000, -54.8433,  -68.2958),
('BRC',  'Teniente Luis Candelaria Airport',                              'Argentina',          'LV',   3, 'South America',  2348, -41.1511,  -71.1578),
('RCU',  'Las Higueras Airport',                                          'Argentina',          'LV',   2, 'South America',  2700, -33.0853,  -64.2614),
('REL',  'Almirante Zar Airport',                                         'Argentina',          'LV',   2, 'South America',  2700, -43.2105,  -65.2703),
('RGA',  'Hermes Quijada International Airport',                          'Argentina',          'LV',   2, 'South America',  2400, -53.7777,  -67.7494),
('SDE',  'Vicecomodoro Angel de la Paz Aragones Airport',                 'Argentina',          'LV',   2, 'South America',  2700, -27.7656,  -64.31),
('LUQ',  'Brigadier Mayor Cesar Raul Ojeda Airport',                      'Argentina',          'LV',   2, 'South America',  3500, -33.2733,  -66.3564),
('AFA',  'San Rafael Airport',                                            'Argentina',          'LV',   2, 'South America',  2700, -34.5883,  -68.4039),
('VDM',  'Gobernador Edgardo Castello Airport',                           'Argentina',          'LV',   2, 'South America',  2700, -40.8692,  -63.0004),
('IRJ',  'Capitan Vicente Almandos Almonacid Airport',                    'Argentina',          'LV',   2, 'South America',  2700, -29.3816,  -66.7958),
('PMY',  'El Tehuelche Airport',                                          'Argentina',          'LV',   2, 'South America',  2000, -42.7592,  -65.1028),
('PRA',  'General Justo Jose de Urquiza Airport',                         'Argentina',          'LV',   2, 'South America',  2400, -31.7948,  -60.4804),
('LGS',  'Comodoro D. Ricardo Salomon Airport',                           'Argentina',          'LV',   2, 'South America',  3000, -35.4936,  -69.5743),
('RCQ',  'Daniel Jurkic Airport',                                         'Argentina',          'LV',   1, 'South America',  1600, -29.2103,  -59.6864),
('FDO',  'San Fernando Airport',                                          'Argentina',          'LV',   1, 'South America',  1600, -34.4533,  -58.5897),
-- Colombia
('MDE',  'Jose Maria Cordova International Airport',                      'Colombia',           'HK',   4, 'South America',  3000,   6.1645,  -75.4231),
('SMR',  'Simon Bolivar International Airport',                           'Colombia',           'HK',   3, 'South America',  2600,  11.1196,  -74.2306),
('ADZ',  'Sesquicentenario Airport',                                      'Colombia',           'HK',   3, 'South America',  2560,  12.5836,  -81.7112),
('VUP',  'Alfonso Lopez Pumarejo Airport',                                'Colombia',           'HK',   3, 'South America',  2100,  10.435,   -73.2495),
('RCH',  'Almirante Padilla Airport',                                     'Colombia',           'HK',   2, 'South America',  1500,  11.5262,  -72.926),
('TME',  'Gustavo Vargas Airport',                                        'Colombia',           'HK',   1, 'South America',  1600,   6.4511,  -71.7603),
('TCO',  'La Florida Airport',                                            'Colombia',           'HK',   1, 'South America',  1400,   1.8144,  -78.7493),
('SJE',  'Jorge Enrique Gonzalez Torres Airport',                         'Colombia',           'HK',   1, 'South America',  1400,   2.5797,  -72.6394),
('VVC',  'La Vanguardia Airport',                                         'Colombia',           'HK',   2, 'South America',  1800,   4.1679,  -73.6138),
-- Venezuela
('MAR',  'La Chinita International Airport',                              'Venezuela',          'YV',   3, 'South America',  2800,  10.5582,  -71.7279),
('PZO',  'Manuel Carlos Piar Guayana Airport',                            'Venezuela',          'YV',   3, 'South America',  2900,   8.2885,  -62.7604),
('PMV',  'Santiago Marino Caribbean International Airport',               'Venezuela',          'YV',   3, 'South America',  2400,  10.9126,  -63.9666),
-- Brazil
('GRU',  'Sao Paulo Guarulhos International Airport',                     'Brazil',             'PP',   6, 'South America',  3700, -23.4356,  -46.4731),
('REC',  'Guararapes International Airport',                              'Brazil',             'PP',   5, 'South America',  3241,  -8.1265,  -34.9239),
('SSA',  'Deputado Luis Eduardo Magalhaes International Airport',         'Brazil',             'PP',   5, 'South America',  3005, -12.9086,  -38.3225),
('GIG',  'Rio de Janeiro Galeao International Airport',                   'Brazil',             'PP',   5, 'South America',  4000, -22.81,    -43.2506),
('POA',  'Salgado Filho International Airport',                           'Brazil',             'PP',   5, 'South America',  3000, -29.9944,  -51.1714),
('SDU',  'Rio de Janeiro Santos Dumont Airport',                          'Brazil',             'PP',   4, 'South America',  1323, -22.9105,  -43.1631),
('SLZ',  'Marechal Cunha Machado International Airport',                  'Brazil',             'PP',   4, 'South America',  2400,  -2.5853,  -44.2341),
('CGH',  'Sao Paulo Congonhas Airport',                                   'Brazil',             'PP',   4, 'South America',  1940, -23.6261,  -46.6564),
('VIX',  'Eurico de Aguiar Salles Airport',                               'Brazil',             'PP',   4, 'South America',  2360, -20.2581,  -40.2864),
('RAO',  'Leite Lopes Airport',                                           'Brazil',             'PP',   3, 'South America',  2195, -21.1364,  -47.7766),
('RBR',  'Placido de Castro International Airport',                       'Brazil',             'PP',   3, 'South America',  2300,  -9.8669,  -67.8981),
('STM',  'Maestro Wilson Fonseca Airport',                                'Brazil',             'PP',   3, 'South America',  2500,  -2.4242,  -54.7858),
('THE',  'Senador Petronio Portella Airport',                             'Brazil',             'PP',   3, 'South America',  2400,  -5.0597,  -42.8235),
('UDI',  'Ten. Cel. Av. Cesar Bombonato Airport',                         'Brazil',             'PP',   3, 'South America',  2400, -18.8836,  -48.2253),
('URG',  'Ruben Berta International Airport',                             'Brazil',             'PP',   3, 'South America',  2450, -29.7822,  -57.0382),
('SJP',  'Prof. Eribelto Manoel Reino Airport',                           'Brazil',             'PP',   2, 'South America',  2100, -20.8166,  -49.4065),
('OPS',  'Presidente Joao Figueiredo Airport',                            'Brazil',             'PP',   2, 'South America',  1700, -11.885,   -55.5864),
('TBT',  'Tabatinga International Airport',                               'Brazil',             'PP',   2, 'South America',  2000,  -4.2557,  -69.9358),
('TFF',  'Tefe Airport',                                                  'Brazil',             'PP',   2, 'South America',  1900,  -3.3829,  -64.7241),
('VDC',  'Glauber Rocha Airport',                                         'Brazil',             'PP',   2, 'South America',  2100, -14.8626,  -40.8631),
('PMG',  'Ponta Pora International Airport',                              'Brazil',             'PP',   2, 'South America',  2000, -22.5496,  -55.7026),
('PHB',  'Prefeito Dr. Joao Silva Filho International Airport',           'Brazil',             'PP',   2, 'South America',  2300,  -2.8938,  -41.732),
('QSC',  'Sao Carlos Airport',                                            'Brazil',             'PP',   1, 'South America',  1400, -21.8756,  -47.9033),
('SOD',  'Sorocaba Airport',                                              'Brazil',             'PP',   1, 'South America',  1500, -23.48,    -47.49),
('UBT',  'Ubatuba Airport',                                               'Brazil',             'PP',   1, 'South America',  1200, -23.4411,  -45.0756),
('VOT',  'Votuporanga Airport',                                           'Brazil',             'PP',   1, 'South America',  1400, -20.4783,  -49.9878),
-- Mexico
('TAM',  'General Francisco Javier Mina International Airport',           'Mexico',             'XA',   3, 'North America',  2700,  22.2964,  -97.8659),
('TAP',  'Tapachula International Airport',                               'Mexico',             'XA',   3, 'North America',  2800,  14.7943,  -92.3701),
('TLC',  'Licenciado Adolfo Lopez Mateos International Airport',          'Mexico',             'XA',   3, 'North America',  4200,  19.3371,  -99.5661),
('TGZ',  'Llano San Juan International Airport',                          'Mexico',             'XA',   3, 'North America',  2800,  16.5636,  -93.0225),
('TQO',  'Felipe Carrillo Puerto International Airport',                  'Mexico',             'XA',   3, 'North America',  2500,  20.2263,  -87.4734),
('VER',  'General Heriberto Jara International Airport',                  'Mexico',             'XA',   3, 'North America',  3200,  19.1459,  -96.1873),
('VSA',  'Carlos Rovirosa Perez International Airport',                   'Mexico',             'XA',   3, 'North America',  2700,  17.997,   -92.8174),
-- Central America & Caribbean
('SJO',  'Juan Santamaria International Airport',                         'Costa Rica',         'TI',   5, 'North America',  3012,   9.9939,  -84.2088),
('TGU',  'Toncontin International Airport',                               'Honduras',           'HR',   3, 'North America',  2012,  14.0609,  -87.2172),
('SAL',  'El Salvador International Airport',                             'El Salvador',        'YS',   3, 'North America',  3200,  13.4409,  -89.0557),
('ILS',  'San Salvador Ilopango Airport',                                  'El Salvador',        'YS',   2, 'North America',  1800,  13.6994,  -89.1194),
('PAP',  'Toussaint Louverture International Airport',                    'Haiti',              'HH',   3, 'North America',  3048,  18.5799,  -72.2925),
-- Dominican Republic
('SDQ',  'Las Americas International Airport',                            'Dominican Republic', 'HI',   4, 'North America',  3200,  18.4297,  -69.6689),
('STI',  'Cibao International Airport',                                   'Dominican Republic', 'HI',   3, 'North America',  3000,  19.4062,  -70.6047),
('AZS',  'Samana El Catey International Airport',                         'Dominican Republic', 'HI',   3, 'North America',  2400,  19.267,   -69.742),
-- Cuba
('VRA',  'Juan Gualberto Gomez Airport',                                  'Cuba',               'CU',   3, 'North America',  3000,  23.0344,  -81.4353),
('SCU',  'Antonio Maceo International Airport',                           'Cuba',               'CU',   3, 'North America',  3000,  19.9698,  -75.8354),
-- Trinidad and Tobago
('TAB',  'Crown Point International Airport',                             'Trinidad and Tobago','9Y',   3, 'North America',  2744,  11.1497,  -60.8322),
-- Caribbean islands
('CUR',  'Curacao International Airport',                                 'Curacao',            'PJ',   4, 'North America',  3410,  12.1889,  -68.9598),
('ANU',  'V.C. Bird International Airport',                               'Antigua and Barbuda','V2',   3, 'North America',  2743,  17.1368,  -61.7927),
('RTB',  'Juan Manuel Galvez International Airport',                      'Honduras',           'HR',   2, 'North America',  1526,  16.3168,  -86.523),
('SBH',  'Saint Barthelemy Airport',                                      'Saint Barthelemy',   'F-O',  1, 'North America',   643,  17.9044,  -62.8436),
-- Puerto Rico
('SJU',  'Luis Munoz Marin International Airport',                        'Puerto Rico',        'N',    4, 'North America',  3490,  18.4394,  -66.0018),
('VQS',  'Antonio Rivera Rodriguez Airport',                              'Puerto Rico',        'N',    1, 'North America',  1371,  18.1148,  -65.4936),
-- Saint Lucia
('UVF',  'Hewanorra International Airport',                               'Saint Lucia',        'J6',   3, 'North America',  2987,  13.7332,  -60.9526);

-- Oceania airport expansion batch 1 (INSERT OR IGNORE — skips any IATA already present)
INSERT OR IGNORE INTO airports (iata_code, name, country, registration_prefix, category, continent, runway_length_m, latitude, longitude) VALUES
-- Australia (major hubs)
('BNE',  'Brisbane International Airport',                                'Australia',          'VH',   6, 'Oceania',  3560, -27.3842,  153.1175),
('ADL',  'Adelaide International Airport',                                'Australia',          'VH',   4, 'Oceania',  3100, -34.9475,  138.5334),
('CNS',  'Cairns International Airport',                                  'Australia',          'VH',   4, 'Oceania',  3158, -16.8858,  145.7555),
('CBR',  'Canberra Airport',                                              'Australia',          'VH',   4, 'Oceania',  2956, -35.3069,  149.195),
('DRW',  'Darwin International Airport',                                  'Australia',          'VH',   4, 'Oceania',  3354, -12.4147,  130.8767),
('HBA',  'Hobart International Airport',                                  'Australia',          'VH',   4, 'Oceania',  2590, -42.8361,  147.5106),
('OOL',  'Gold Coast Airport',                                            'Australia',          'VH',   4, 'Oceania',  2770, -28.1644,  153.505),
-- Australia (regional)
('ASP',  'Alice Springs Airport',                                         'Australia',          'VH',   3, 'Oceania',  2438, -23.8067,  133.9022),
('AVV',  'Avalon Airport',                                                'Australia',          'VH',   3, 'Oceania',  3048, -38.0394,  144.4694),
('BNK',  'Ballina Byron Gateway Airport',                                 'Australia',          'VH',   3, 'Oceania',  1752, -28.8339,  153.5622),
('BME',  'Broome International Airport',                                  'Australia',          'VH',   3, 'Oceania',  2034, -17.9447,  122.2322),
('CFS',  'Coffs Harbour Airport',                                         'Australia',          'VH',   3, 'Oceania',  1988, -30.3206,  153.1158),
('KGI',  'Kalgoorlie-Boulder Airport',                                    'Australia',          'VH',   3, 'Oceania',  2520, -30.7894,  121.4617),
('KTA',  'Karratha Airport',                                              'Australia',          'VH',   3, 'Oceania',  2530, -20.7122,  116.7736),
('LEA',  'Learmonth Airport',                                             'Australia',          'VH',   3, 'Oceania',  3048, -22.2356,  114.0881),
('LST',  'Launceston Airport',                                            'Australia',          'VH',   3, 'Oceania',  2430, -41.5453,  147.2142),
('MKY',  'Mackay Airport',                                                'Australia',          'VH',   3, 'Oceania',  2438, -21.1717,  149.1797),
-- Australia (small)
('ABX',  'Albury Airport',                                                'Australia',          'VH',   2, 'Oceania',  1829, -36.0678,  146.9581),
('ACF',  'Brisbane Archerfield Airport',                                  'Australia',          'VH',   2, 'Oceania',  1524, -27.5703,  153.0078),
('ARM',  'Armidale Regional Airport',                                     'Australia',          'VH',   2, 'Oceania',  1530, -30.5281,  151.6172),
('AYQ',  'Ayers Rock Connellan Airport',                                  'Australia',          'VH',   2, 'Oceania',  2044, -25.1861,  130.9756),
('BDB',  'Bundaberg Airport',                                             'Australia',          'VH',   2, 'Oceania',  1682, -24.9039,  152.3194),
('BHQ',  'Broken Hill Airport',                                           'Australia',          'VH',   2, 'Oceania',  1830, -31.9917,  141.4722),
('BQB',  'Busselton Margaret River Airport',                              'Australia',          'VH',   2, 'Oceania',  1800, -33.6844,  115.4017),
('EMD',  'Emerald Airport',                                               'Australia',          'VH',   2, 'Oceania',  1810, -23.5675,  148.1786),
('GET',  'Geraldton Airport',                                             'Australia',          'VH',   2, 'Oceania',  1800, -28.7961,  114.7072),
('GLT',  'Gladstone Airport',                                             'Australia',          'VH',   2, 'Oceania',  1889, -23.8697,  151.2233),
('GOV',  'Gove Airport',                                                  'Australia',          'VH',   2, 'Oceania',  2012, -12.2694,  136.8181),
('HTI',  'Hamilton Island Airport',                                       'Australia',          'VH',   2, 'Oceania',  1800, -20.3581,  148.9517),
('HVB',  'Hervey Bay Airport',                                            'Australia',          'VH',   2, 'Oceania',  1800, -25.3189,  152.8803),
('OOM',  'Cooma Snowy Mountains Airport',                                 'Australia',          'VH',   2, 'Oceania',  1600, -36.3006,  148.9742),
('XCH',  'Christmas Island Airport',                                      'Christmas Island',   'VH',   2, 'Oceania',  1974, -10.4506,  105.6906),
('CCK',  'Cocos Islands Airport',                                         'Cocos Islands',      'VH',   2, 'Oceania',  2440, -12.1883,   96.834),
('LDH',  'Lord Howe Island Airport',                                      'Australia',          'VH',   1, 'Oceania',   797, -31.5383,  159.0764),
-- New Zealand
('AKL',  'Auckland Airport',                                              'New Zealand',        'ZK',   5, 'Oceania',  3635, -37.0082,  174.7917),
('CHC',  'Christchurch International Airport',                            'New Zealand',        'ZK',   5, 'Oceania',  3288, -43.4894,  172.5322),
('DUD',  'Dunedin International Airport',                                 'New Zealand',        'ZK',   3, 'Oceania',  1713, -45.9281,  170.1983),
('HLZ',  'Hamilton Airport',                                              'New Zealand',        'ZK',   3, 'Oceania',  1829, -37.8667,  175.3322),
('BHE',  'Marlborough Airport',                                           'New Zealand',        'ZK',   2, 'Oceania',  1350, -41.5183,  173.8703),
('CHT',  'Chatham Islands Tuuta Airport',                                 'New Zealand',        'ZK',   2, 'Oceania',  1372, -43.81,   -176.457),
('GIS',  'Gisborne Airport',                                              'New Zealand',        'ZK',   2, 'Oceania',  1357, -38.6633,  177.9778),
('HKK',  'Hokitika Airport',                                              'New Zealand',        'ZK',   2, 'Oceania',  1359, -42.7136,  170.9853),
('IVC',  'Invercargill Airport',                                          'New Zealand',        'ZK',   2, 'Oceania',  1884, -46.4124,  168.3131),
('KKE',  'Bay of Islands Airport',                                        'New Zealand',        'ZK',   2, 'Oceania',  1372, -35.2628,  173.9122),
-- French Polynesia
('BOB',  'Bora Bora Motu Mute Airport',                                   'French Polynesia',   'F-OH', 2, 'Oceania',  1601, -16.4444, -151.7513),
('HOI',  'Hao Airport',                                                   'French Polynesia',   'F-OH', 2, 'Oceania',  2500, -18.0748, -140.9458),
('FAV',  'Fakarava Airport',                                              'French Polynesia',   'F-OH', 1, 'Oceania',  1190, -16.0541, -145.6567),
('HIX',  'Hiva Oa Atuona Airport',                                        'French Polynesia',   'F-OH', 1, 'Oceania',  1209,  -9.7679, -139.0113),
-- New Caledonia
('LIF',  'Lifou Ouanaham Airport',                                        'New Caledonia',      'F-ON', 2, 'Oceania',  1972, -20.7748,  167.2397),
('KNQ',  'Ile des Pins Airport',                                          'New Caledonia',      'F-ON', 1, 'Oceania',  1020, -22.5889,  167.4558),
-- Pacific Islands
('APW',  'Faleolo International Airport',                                 'Samoa',              '5W',   3, 'Oceania',  2940, -13.833,  -172.008),
('RAR',  'Rarotonga International Airport',                               'Cook Islands',       'E5',   3, 'Oceania',  2595, -21.2026, -159.8057),
('HIR',  'Honiara International Airport',                                 'Solomon Islands',    'H4',   3, 'Oceania',  2073,  -9.428,   160.0547),
('GUM',  'Antonio B. Won Pat International Airport',                      'Guam',               'N',    4, 'Oceania',  3543,  13.4834,  144.7958),
('AIT',  'Aitutaki Airport',                                              'Cook Islands',       'E5',   2, 'Oceania',  1524, -18.8309, -159.7642),
('CIS',  'Cassidy International Airport',                                 'Kiribati',           'T3',   2, 'Oceania',  1981,   1.9862, -157.3453),
('FUN',  'Funafuti International Airport',                                'Tuvalu',             'T2',   2, 'Oceania',  1524,  -8.525,   179.1961),
('INU',  'Nauru International Airport',                                   'Nauru',              'C2',   2, 'Oceania',  2584,  -0.5469,  166.9191),
('KSA',  'Kosrae International Airport',                                  'Micronesia',         'V6',   2, 'Oceania',  1981,   5.357,   162.9589),
('LBS',  'Labasa Airport',                                                'Fiji',               'DQ',   2, 'Oceania',  1524, -16.4669,  179.3397),
('SON',  'Luganville Santo-Pekoa International Airport',                  'Vanuatu',            'YJ',   2, 'Oceania',  2250, -15.505,   167.2197),
('TKK',  'Chuuk International Airport',                                   'Micronesia',         'V6',   2, 'Oceania',  1828,   7.4618,  151.843);

-- Oceania airport expansion batch 2 (INSERT OR IGNORE — skips any IATA already present)
INSERT OR IGNORE INTO airports (iata_code, name, country, registration_prefix, category, continent, runway_length_m, latitude, longitude) VALUES
-- Australia (major hubs)
('MEL',  'Melbourne Tullamarine Airport',                                 'Australia',          'VH',   6, 'Oceania',  3657, -37.6733,  144.8433),
('SYD',  'Sydney Kingsford Smith Airport',                                'Australia',          'VH',   6, 'Oceania',  3962, -33.9461,  151.1772),
('PER',  'Perth Airport',                                                 'Australia',          'VH',   5, 'Oceania',  3444, -31.9403,  115.9669),
('TSV',  'Townsville Airport',                                            'Australia',          'VH',   4, 'Oceania',  2286, -19.2525,  146.7653),
-- Australia (regional)
('ISA',  'Mount Isa Airport',                                             'Australia',          'VH',   3, 'Oceania',  2438, -20.6639,  139.4886),
('NTL',  'Newcastle Williamtown Airport',                                 'Australia',          'VH',   3, 'Oceania',  2438, -32.795,   151.8342),
('PHE',  'Port Hedland International Airport',                            'Australia',          'VH',   3, 'Oceania',  2400, -20.3778,  118.6267),
('ROK',  'Rockhampton Airport',                                           'Australia',          'VH',   3, 'Oceania',  2438, -23.3819,  150.4753),
('MCY',  'Sunshine Coast Airport',                                        'Australia',          'VH',   3, 'Oceania',  1800, -26.6033,  153.0883),
('TMW',  'Tamworth Regional Airport',                                     'Australia',          'VH',   3, 'Oceania',  1682, -31.0839,  150.8469),
('WGA',  'Wagga Wagga Airport',                                           'Australia',          'VH',   3, 'Oceania',  1796, -35.1653,  147.4658),
('WTB',  'Toowoomba Wellcamp Airport',                                    'Australia',          'VH',   3, 'Oceania',  2870, -27.5583,  151.7933),
-- Australia (small)
('MIM',  'Merimbula Airport',                                             'Australia',          'VH',   2, 'Oceania',  1480, -36.9081,  149.9008),
('MQL',  'Mildura Airport',                                               'Australia',          'VH',   2, 'Oceania',  1524, -34.2292,  142.0861),
('MRZ',  'Moree Airport',                                                 'Australia',          'VH',   2, 'Oceania',  1580, -29.4989,  149.8453),
('OAG',  'Orange Airport',                                                'Australia',          'VH',   2, 'Oceania',  1530, -33.3817,  149.1328),
('PBO',  'Paraburdoo Airport',                                            'Australia',          'VH',   2, 'Oceania',  2440, -23.1711,  117.745),
('PQQ',  'Port Macquarie Airport',                                        'Australia',          'VH',   2, 'Oceania',  1798, -31.4358,  152.8628),
('PPP',  'Proserpine Airport',                                            'Australia',          'VH',   2, 'Oceania',  2596, -20.495,   148.5522),
('RMA',  'Roma Airport',                                                  'Australia',          'VH',   2, 'Oceania',  1524, -26.545,   148.775),
('ZNE',  'Newman Airport',                                                'Australia',          'VH',   2, 'Oceania',  1924, -23.4178,  119.8033),
-- New Zealand
('WLG',  'Wellington Airport',                                            'New Zealand',        'ZK',   4, 'Oceania',  1936, -41.3272,  174.805),
('PMR',  'Palmerston North Airport',                                      'New Zealand',        'ZK',   3, 'Oceania',  1716, -40.3206,  175.6169),
('ROT',  'Rotorua Airport',                                               'New Zealand',        'ZK',   3, 'Oceania',  1783, -38.1092,  176.3172),
('ZQN',  'Queenstown Airport',                                            'New Zealand',        'ZK',   3, 'Oceania',  1800, -45.0211,  168.7392),
('NPE',  'Hawke''s Bay Airport',                                          'New Zealand',        'ZK',   2, 'Oceania',  1372, -39.4658,  176.87),
('NSN',  'Nelson Airport',                                                'New Zealand',        'ZK',   2, 'Oceania',  1353, -41.2983,  173.2211),
('NPL',  'New Plymouth Airport',                                          'New Zealand',        'ZK',   2, 'Oceania',  1814, -39.0086,  174.1792),
('PPQ',  'Paraparaumu Airport',                                           'New Zealand',        'ZK',   2, 'Oceania',  1097, -40.9047,  174.9897),
('TRG',  'Tauranga Airport',                                              'New Zealand',        'ZK',   2, 'Oceania',  1830, -37.6719,  176.1961),
('TUO',  'Taupo Airport',                                                 'New Zealand',        'ZK',   2, 'Oceania',  1585, -38.7397,  176.0842),
('TIU',  'Timaru Airport',                                                'New Zealand',        'ZK',   2, 'Oceania',  1335, -44.3028,  171.2253),
('WAG',  'Whanganui Airport',                                             'New Zealand',        'ZK',   2, 'Oceania',  1350, -39.9622,  175.0256),
('WRE',  'Whangarei Airport',                                             'New Zealand',        'ZK',   2, 'Oceania',  1232, -35.7683,  174.365),
('IUE',  'Niue International Airport',                                    'Niue',               'ZK',   2, 'Oceania',  1829, -19.0797, -169.9256),
-- French Polynesia
('PPT',  'Tahiti Faaa International Airport',                             'French Polynesia',   'F-OH', 4, 'Oceania',  3420, -17.5536, -149.6067),
('NHV',  'Nuku Hiva Airport',                                             'French Polynesia',   'F-OH', 2, 'Oceania',  1600,  -8.7956, -140.2288),
('RFP',  'Raiatea Airport',                                               'French Polynesia',   'F-OH', 2, 'Oceania',  1649, -16.7228, -151.4661),
('RGI',  'Rangiroa Airport',                                              'French Polynesia',   'F-OH', 2, 'Oceania',  2370, -14.9542, -147.6608),
('MKP',  'Makemo Airport',                                                'French Polynesia',   'F-OH', 1, 'Oceania',  1200, -16.5839, -143.6564),
('MOZ',  'Moorea Temae Airport',                                          'French Polynesia',   'F-OH', 1, 'Oceania',  1540, -17.4897, -149.7619),
('GMR',  'Totegegie Airport',                                             'French Polynesia',   'F-OH', 1, 'Oceania',  3380, -23.0797, -134.89),
-- New Caledonia
('NOU',  'La Tontouta International Airport',                             'New Caledonia',      'F-ON', 3, 'Oceania',  3200, -22.0146,  166.213),
('MEE',  'Mare Airport',                                                  'New Caledonia',      'F-ON', 2, 'Oceania',  1685, -21.4817,  168.0378),
('GEA',  'Noumea Magenta Airport',                                        'New Caledonia',      'F-ON', 2, 'Oceania',  1330, -22.2583,  166.4728),
('UVE',  'Ouvea Airport',                                                 'New Caledonia',      'F-ON', 1, 'Oceania',  1840, -20.6406,  166.5728),
-- Fiji
('NAN',  'Nadi International Airport',                                    'Fiji',               'DQ',   4, 'Oceania',  3297, -17.7553,  177.4431),
('SUV',  'Nausori Airport',                                               'Fiji',               'DQ',   3, 'Oceania',  1829, -18.0433,  178.5592),
('SVU',  'Savusavu Airport',                                              'Fiji',               'DQ',   2, 'Oceania',  1100, -16.8028,  179.3411),
-- Papua New Guinea
('POM',  'Jacksons International Airport',                                'Papua New Guinea',   'P2',   3, 'Oceania',  2750,  -9.4434,  147.22),
-- Vanuatu
('VLI',  'Bauerfield International Airport',                              'Vanuatu',            'YJ',   3, 'Oceania',  2831, -17.6994,  168.3197),
-- Pacific Islands
('TBU',  'Fua''amotu International Airport',                              'Tonga',              'A3',   3, 'Oceania',  2779, -21.2411, -175.1497),
('PPG',  'Pago Pago International Airport',                               'American Samoa',     'N',    3, 'Oceania',  2942, -14.331,  -170.7103),
('SPN',  'Saipan International Airport',                                  'Northern Mariana Islands','N',3, 'Oceania',  2896,  15.119,   145.7289),
('PNI',  'Pohnpei International Airport',                                 'Micronesia',         'V6',   3, 'Oceania',  2073,   6.9851,  158.209),
('ROR',  'Roman Tmetuchl International Airport',                          'Palau',              'T8A',  3, 'Oceania',  2012,   7.368,   134.5443),
('MAJ',  'Marshall Islands International Airport',                        'Marshall Islands',   'V7',   2, 'Oceania',  1936,   7.0647,  171.2722),
('NLK',  'Norfolk Island Airport',                                        'Norfolk Island',     'VH',   2, 'Oceania',  1939, -29.0414,  167.9389),
('ROP',  'Rota International Airport',                                    'Northern Mariana Islands','N',2, 'Oceania',  1890,  14.1743,  145.2428),
('TIQ',  'Tinian International Airport',                                  'Northern Mariana Islands','N',2, 'Oceania',  2560,  14.9992,  145.619),
('TRW',  'Tarawa Bonriki International Airport',                          'Kiribati',           'T3',   2, 'Oceania',  1835,   1.3816,  173.1477),
('WLS',  'Wallis Hihifo Airport',                                         'Wallis and Futuna',  'F-WF', 2, 'Oceania',  1764, -13.2383, -176.1992),
('YAP',  'Yap Island Airport',                                            'Micronesia',         'V6',   2, 'Oceania',  1829,   9.4989,  138.0826);

-- Asia airports (batch 1: ABD–GAY)
INSERT OR IGNORE INTO airports (iata_code, name, country, registration_prefix, category, continent, runway_length_m, latitude, longitude) VALUES
('ABD',  'Abadan Airport',                                                    'Iran',                      'EP',   3, 'Asia',  3200,  30.3711,  48.2283),
('ACP',  'Sahand Airport',                                                    'Iran',                      'EP',   2, 'Asia',  2700,  37.3478,  46.1278),
('ADE',  'Aden International Airport',                                        'Yemen',                     '7O',   3, 'Asia',  3200,  12.8295,  45.0288),
('ADJ',  'Amman Civil Airport',                                               'Jordan',                    'JY',   2, 'Asia',  3000,  31.9722,  35.9911),
('ADU',  'Ardabil Airport',                                                   'Iran',                      'EP',   2, 'Asia',  2800,  38.3257,  48.4244),
('AGR',  'Agra Airport',                                                      'India',                     'VT',   2, 'Asia',  2750,  27.1558,  77.9609),
('AHB',  'Abha Regional Airport',                                             'Saudi Arabia',               'HZ',   3, 'Asia',  3600,  18.2404,  42.6566),
('AJF',  'Al Jawf Domestic Airport',                                          'Saudi Arabia',               'HZ',   2, 'Asia',  3000,  29.7851,  40.0996),
('AKU',  'Aksu Airport',                                                      'China',                     'B',    2, 'Asia',  3800,  41.2625,  80.2917),
('ALA',  'Almaty International Airport',                                      'Kazakhstan',                'UP',   5, 'Asia',  4600,  43.3521,  77.0405),
('AMM',  'Queen Alia International Airport',                                  'Jordan',                    'JY',   5, 'Asia',  3660,  31.7226,  35.9933),
('AMQ',  'Pattimura Airport',                                                 'Indonesia',                 'PK',   3, 'Asia',  2500,  -3.7106, 128.0883),
('AOR',  'Sultan Abdul Halim Airport',                                        'Malaysia',                  '9M',   3, 'Asia',  2740,   6.1897, 100.4008),
('AQJ',  'King Hussein International Airport',                                'Jordan',                    'JY',   3, 'Asia',  3000,  29.6112,  35.0181),
('ARH',  'Talagi Airport',                                                    'Russia',                    'RA',   3, 'Asia',  2600,  64.6003,  40.7167),
('ASB',  'Ashgabat International Airport',                                    'Turkmenistan',              'EZ',   4, 'Asia',  3800,  37.9868,  58.3610),
('ASJ',  'Amami Airport',                                                     'Japan',                     'JA',   3, 'Asia',  2000,  28.4306, 129.7125),
('ATQ',  'Sri Guru Ram Dass Jee International Airport',                       'India',                     'VT',   4, 'Asia',  3200,  31.7096,  74.7973),
('AUH',  'Abu Dhabi International Airport',                                   'United Arab Emirates',      'A6',   6, 'Asia',  4100,  24.4328,  54.6511),
('AUT',  'Atauro Airport',                                                    'Timor-Leste',               '4W',   1, 'Asia',   900,  -8.2431, 125.9986),
('AYT',  'Antalya Airport',                                                   'Turkey',                    'TC',   6, 'Asia',  3400,  36.8987,  30.8005),
('BAH',  'Bahrain International Airport',                                     'Bahrain',                   'A9C',  5, 'Asia',  4000,  26.2708,  50.6336),
('BAV',  'Baotou Airport',                                                    'China',                     'B',    3, 'Asia',  3200,  40.5600, 109.9975),
('BBN',  'Bario Airport',                                                     'Malaysia',                  '9M',   1, 'Asia',   900,   3.7339, 115.4789),
('BDJ',  'Syamsudin Noor Airport',                                            'Indonesia',                 'PK',   3, 'Asia',  2500,  -3.4424, 114.7628),
('BDO',  'Husein Sastranegara Airport',                                       'Indonesia',                 'PK',   4, 'Asia',  2240,  -6.9006, 107.5762),
('BDQ',  'Vadodara Airport',                                                  'India',                     'VT',   3, 'Asia',  2743,  22.3362,  73.2263),
('BEY',  'Beirut Rafic Hariri International Airport',                         'Lebanon',                   'OD',   5, 'Asia',  3400,  33.8209,  35.4886),
('BFJ',  'Bijie Feixiong Airport',                                            'China',                     'B',    2, 'Asia',  2800,  27.2675, 105.4722),
('BGW',  'Baghdad International Airport',                                     'Iraq',                      'YI',   5, 'Asia',  4000,  33.2625,  44.2346),
('BHO',  'Raja Bhoj Airport',                                                 'India',                     'VT',   3, 'Asia',  2750,  23.2875,  77.3374),
('BHU',  'Bhavnagar Airport',                                                 'India',                     'VT',   2, 'Asia',  2400,  21.7522,  72.1852),
('BIK',  'Frans Kaisiepo Airport',                                            'Indonesia',                 'PK',   3, 'Asia',  2500,  -1.1901, 136.1081),
('BJV',  'Milas-Bodrum Airport',                                              'Turkey',                    'TC',   4, 'Asia',  3000,  37.2506,  27.6643),
('BJS',  'Beijing Capital International Airport',                             'China',                     'B',    8, 'Asia',  3800,  40.0801, 116.5846),
('BKI',  'Kota Kinabalu International Airport',                               'Malaysia',                  '9M',   5, 'Asia',  3780,   5.9372, 116.0508),
('BKK',  'Suvarnabhumi Airport',                                              'Thailand',                  'HS',   8, 'Asia',  4000,  13.6900, 100.7501),
('BKN',  'Balkanabat Airport',                                                'Turkmenistan',              'EZ',   2, 'Asia',  3800,  39.4633,  54.3650),
('BLE2', 'Bole Alashankou Airport',                                           'China',                     'B',    2, 'Asia',  3800,  44.8950,  82.3000),
('BLR',  'Kempegowda International Airport',                                  'India',                     'VT',   7, 'Asia',  4000,  13.1986,  77.7066),
('BND',  'Bandar Abbas International Airport',                                'Iran',                      'EP',   4, 'Asia',  3500,  27.2183,  56.3778),
('BNX',  'Banja Luka International Airport',                                  'Bosnia and Herzegovina',    'E7',   2, 'Asia',  2400,  44.9413,  17.2975),
('BOM',  'Chhatrapati Shivaji Maharaj International Airport',                 'India',                     'VT',   8, 'Asia',  3660,  19.0887,  72.8679),
('BPN',  'Sultan Aji Muhammad Sulaiman Airport',                              'Indonesia',                 'PK',   4, 'Asia',  2500,  -1.2683, 116.8942),
('BPX',  'Qamdo Bangda Airport',                                              'China',                     'B',    2, 'Asia',  5500,  30.5536,  97.1083),
('BQS',  'Ignatyevo Airport',                                                 'Russia',                    'RA',   3, 'Asia',  3200,  50.4253, 127.4122),
('BSK',  'Biskra Airport',                                                    'Algeria',                   '7T',   2, 'Asia',  3100,  34.7933,   5.7383),
('BTH',  'Hang Nadim Airport',                                                'Indonesia',                 'PK',   4, 'Asia',  4025,   1.1211, 104.1192),
('BTJ',  'Sultan Iskandar Muda International Airport',                        'Indonesia',                 'PK',   3, 'Asia',  2750,   5.5237,  95.4206),
('BTK',  'Bratsk Airport',                                                    'Russia',                    'RA',   3, 'Asia',  3500,  56.3706, 101.6983),
('BUA',  'Buka Airport',                                                      'Papua New Guinea',           'P2',   2, 'Oceania', 2010,  -5.4223, 154.6733),
('BUZ',  'Bushehr Airport',                                                   'Iran',                      'EP',   3, 'Asia',  3360,  28.9448,  50.8346),
('BXU',  'Bancasi Airport',                                                   'Philippines',               'RP',   2, 'Asia',  1830,   8.9515, 125.4788),
('BYN',  'Bayankhongor Airport',                                              'Mongolia',                  'JU',   2, 'Asia',  2800,  46.1633, 100.7044),
('CAN',  'Guangzhou Baiyun International Airport',                            'China',                     'B',    8, 'Asia',  3800,  23.3924, 113.2990),
('CCJ',  'Calicut International Airport',                                     'India',                     'VT',   4, 'Asia',  2860,  11.1368,  75.9553),
('CCU',  'Netaji Subhas Chandra Bose International Airport',                  'India',                     'VT',   7, 'Asia',  3627,  22.6547,  88.4467),
('CDE',  'Chengde Puning Airport',                                            'China',                     'B',    2, 'Asia',  2800,  41.1225, 118.0736),
('CEE',  'Cherepovets Airport',                                               'Russia',                    'RA',   2, 'Asia',  2500,  59.2736,  38.0158),
('CGK',  'Soekarno-Hatta International Airport',                              'Indonesia',                 'PK',   8, 'Asia',  3660,  -6.1256, 106.6559),
('CGO',  'Zhengzhou Xinzheng International Airport',                          'China',                     'B',    6, 'Asia',  3600,  34.5197, 113.8408),
('CGP',  'Shah Amanat International Airport',                                 'Bangladesh',                'S2',   4, 'Asia',  3048,  22.2496,  91.8133),
('CGQ',  'Longjia Airport',                                                   'China',                     'B',    5, 'Asia',  3200,  43.9962, 125.6846),
('CHG',  'Chaoyang Airport',                                                  'China',                     'B',    2, 'Asia',  2500,  41.5381, 120.4344),
('CIF',  'Chifeng Airport',                                                   'China',                     'B',    2, 'Asia',  2500,  42.2350, 118.9081),
('CJB',  'Coimbatore International Airport',                                  'India',                     'VT',   4, 'Asia',  2810,  11.0300,  77.0435),
('CJU',  'Jeju International Airport',                                        'South Korea',               'HL',   6, 'Asia',  3180,  33.5113, 126.4930),
('CKG',  'Chongqing Jiangbei International Airport',                          'China',                     'B',    7, 'Asia',  3200,  29.7192, 106.6417),
('CKH',  'Chokurdakh Airport',                                                'Russia',                    'RA',   1, 'Asia',  2400,  70.6231, 147.9017),
('CMB',  'Bandaranaike International Airport',                                'Sri Lanka',                 '4R',   5, 'Asia',  3350,   7.1808,  79.8841),
('CNX',  'Chiang Mai International Airport',                                  'Thailand',                  'HS',   5, 'Asia',  3000,  18.7669,  98.9625),
('COK',  'Cochin International Airport',                                      'India',                     'VT',   5, 'Asia',  3400,  10.1520,  76.3919),
('CRK',  'Clark International Airport',                                       'Philippines',               'RP',   4, 'Asia',  3200,  15.1858, 120.5596),
('CSX',  'Changsha Huanghua International Airport',                           'China',                     'B',    6, 'Asia',  3200,  28.1892, 113.2197),
('CTU',  'Chengdu Shuangliu International Airport',                           'China',                     'B',    8, 'Asia',  4000,  30.5786, 103.9471),
('CXR',  'Cam Ranh Airport',                                                  'Vietnam',                   'VN',   4, 'Asia',  3048,  11.9982, 109.2194),
('CYI',  'Chiayi Airport',                                                    'Taiwan',                    'B',    2, 'Asia',  2300,  23.4618, 120.3933),
('CZX',  'Changzhou Benniu Airport',                                          'China',                     'B',    3, 'Asia',  2800,  31.9197, 119.7789),
('DAC',  'Hazrat Shahjalal International Airport',                            'Bangladesh',                'S2',   6, 'Asia',  3200,  23.8433,  90.3978),
('DAM',  'Damascus International Airport',                                    'Syria',                     'YK',   5, 'Asia',  3000,  33.4110,  36.5156),
('DAP',  'Darchula Airport',                                                  'Nepal',                     '9N',   1, 'Asia',   540,  29.6700,  80.5500),
('DAU',  'Daru Airport',                                                      'Papua New Guinea',           'P2',   2, 'Oceania', 1830,  -9.0876, 143.2078),
('DBD',  'Dhanbad Airport',                                                   'India',                     'VT',   1, 'Asia',  1830,  23.8342,  86.4253),
('DEL',  'Indira Gandhi International Airport',                               'India',                     'VT',   8, 'Asia',  4430,  28.5665,  77.1031),
('DEZ',  'Deir ez-Zor Airport',                                               'Syria',                     'YK',   2, 'Asia',  2800,  35.2854,  40.1760),
('DHA',  'King Abdulaziz Air Base',                                           'Saudi Arabia',               'HZ',   3, 'Asia',  3350,  26.2654,  50.1522),
('DHM',  'Gaggal Airport',                                                    'India',                     'VT',   2, 'Asia',  1372,  32.1651,  76.2634),
('DIB',  'Dibrugarh Airport',                                                 'India',                     'VT',   2, 'Asia',  2440,  27.4839,  95.0169),
('DIU',  'Diu Airport',                                                       'India',                     'VT',   1, 'Asia',  1200,  20.7131,  70.9211),
('DLC',  'Dalian Zhoushuizi International Airport',                           'China',                     'B',    6, 'Asia',  3300,  38.9657, 121.5386),
('DLM',  'Dalaman Airport',                                                   'Turkey',                    'TC',   4, 'Asia',  3200,  36.7131,  28.7925),
('DMM',  'King Fahd International Airport',                                   'Saudi Arabia',               'HZ',   6, 'Asia',  4000,  26.4712,  49.7979),
('DOH',  'Hamad International Airport',                                       'Qatar',                     'A7',   7, 'Asia',  4850,  25.2731,  51.6080),
('DPS',  'Ngurah Rai International Airport',                                  'Indonesia',                 'PK',   6, 'Asia',  3000,  -8.7482, 115.1670),
('DVO',  'Francisco Bangoy International Airport',                            'Philippines',               'RP',   5, 'Asia',  3000,   7.1255, 125.6458),
('DWC',  'Al Maktoum International Airport',                                  'United Arab Emirates',      'A6',   7, 'Asia',  4500,  24.8963,  55.1614),
('DXB',  'Dubai International Airport',                                       'United Arab Emirates',      'A6',   8, 'Asia',  4000,  25.2528,  55.3644),
('DYG',  'Dayong Airport',                                                    'China',                     'B',    3, 'Asia',  2200,  29.1028, 110.4436),
('DYR',  'Ugolny Airport',                                                    'Russia',                    'RA',   2, 'Asia',  2500,  64.7350, 177.7417),
('EGO',  'Belgorod International Airport',                                    'Russia',                    'RA',   2, 'Asia',  2500,  50.6438,  36.5901),
('ELQ',  'Gassim Airport',                                                    'Saudi Arabia',               'HZ',   3, 'Asia',  4000,  26.3028,  43.7742),
('ENH',  'Enshi Airport',                                                     'China',                     'B',    2, 'Asia',  2200,  30.3203, 109.4853),
('ESB',  'Ankara Esenboğa International Airport',                             'Turkey',                    'TC',   6, 'Asia',  3750,  40.1281,  32.9951),
('ETH',  'Eilat Airport',                                                     'Israel',                    '4X',   2, 'Asia',  1880,  29.5613,  34.9600),
('EVN',  'Zvartnots International Airport',                                   'Armenia',                   'EK',   4, 'Asia',  3850,  40.1473,  44.3959),
('EZS',  'Elazığ Airport',                                                    'Turkey',                    'TC',   3, 'Asia',  2750,  38.6069,  39.2914),
('FKS',  'Fukushima Airport',                                                 'Japan',                     'JA',   3, 'Asia',  2000,  37.2274, 140.4311),
('FNJ',  'Sunan International Airport',                                       'North Korea',               'P',    3, 'Asia',  3500,  39.2241, 125.6700),
('FOC',  'Fuzhou Changle International Airport',                              'China',                     'B',    5, 'Asia',  3400,  25.9353, 119.6631),
('FSZ',  'Shizuoka Airport',                                                  'Japan',                     'JA',   3, 'Asia',  2500,  34.7961, 138.1894),
('FUK',  'Fukuoka Airport',                                                   'Japan',                     'JA',   6, 'Asia',  2800,  33.5853, 130.4511),
('FUO',  'Foshan Shadi Airport',                                              'China',                     'B',    3, 'Asia',  2600,  23.0833, 113.0697),
('FYN',  'Fuyun Koktokay Airport',                                            'China',                     'B',    2, 'Asia',  3600,  46.8044,  89.5122),
('GAY',  'Gaya Airport',                                                      'India',                     'VT',   3, 'Asia',  2286,  24.7443,  84.9512);

-- Seed aircraft types
-- (id, manufacturer, model, full_name, max_passengers, range_km, cruise_speed_kmh,
--  min_runway_takeoff_m, min_runway_landing_m, fuel_consumption_empty_per_km,
--  fuel_consumption_full_per_km, wake_turbulence_category, new_price_usd,
--  required_level, required_pilots, image_filename)
INSERT OR IGNORE INTO aircraft_types (id, manufacturer, model, full_name, max_passengers, range_km, cruise_speed_kmh, min_runway_takeoff_m, min_runway_landing_m, fuel_consumption_empty_per_km, fuel_consumption_full_per_km, wake_turbulence_category, new_price_usd, required_level, required_pilots, image_filename) VALUES
-- Regional Jets (Level 1)
(1,  'Embraer', 'E175',     'Embraer E175',     88,  3704,  829, 1644, 1280, 0.018, 0.023, 'M', 46800000,  4, 2, 'Aircraft_Embrear_175.png'),
(2,  'Embraer', 'E175-E2',  'Embraer E175-E2',  90,  3815,  833, 1600, 1250, 0.016, 0.020, 'M', 56700000,  4, 2, 'Aircraft_Embrear_175-E2.png'),
(3,  'Embraer', 'E190-E2',  'Embraer E190-E2',  114, 5278,  833, 1693, 1350, 0.018, 0.023, 'M', 67300000,  5, 2, 'Aircraft_Embrear_190-E2.png'),
(4,  'Embraer', 'E195-E2',  'Embraer E195-E2',  146, 4815,  833, 1788, 1400, 0.019, 0.024, 'M', 72900000,  6, 2, 'Aircraft_Embrear_195-E2.png'),
-- Narrow-body (Level 7-10)
(5,  'Airbus',  'A220-100', 'Airbus A220-100',  135, 6390,  871, 1463, 1372, 0.019, 0.024, 'M', 81000000,  7, 2, 'Aircraft_Airbus_220-100.png'),
(6,  'Airbus',  'A220-300', 'Airbus A220-300',  160, 6297,  871, 1707, 1463, 0.021, 0.026, 'M', 91500000,  8, 2, 'Aircraft_Airbus_220-300.png'),
(7,  'Airbus',  'A318',     'Airbus A318',      132, 5750,  828, 1780, 1510, 0.022, 0.028, 'M', 77400000,  7, 2, 'Aircraft_Airbus_318.png'),
(8,  'Airbus',  'A319',     'Airbus A319',      160, 6850,  829, 1850, 1400, 0.023, 0.029, 'M', 89500000,  8, 2, 'Aircraft_Airbus_319.png'),
(9,  'Airbus',  'A320',     'Airbus A320',      180, 6150,  828, 2090, 1480, 0.024, 0.030, 'M', 101000000, 9, 2, 'Aircraft_Airbus_320.png'),
(10, 'Airbus',  'A321',     'Airbus A321',      220, 5950,  828, 2180, 1530, 0.026, 0.033, 'M', 118300000, 9, 2, 'Aircraft_Airbus_321.png'),
(11, 'Airbus',  'A321 Neo', 'Airbus A321 Neo',  244, 7400,  828, 2180, 1530, 0.023, 0.029, 'M', 129500000, 10, 2, 'Aircraft_Airbus_321_Neo.png'),
-- Wide-body (Level 12-14)
(12, 'Boeing',  '787-8',    'Boeing 787-8',     330, 13530, 903, 2500, 1600, 0.027, 0.035, 'H', 248300000, 12, 2, 'Aircraft_Boeing_787-800.png'),
(13, 'Boeing',  '777-300',  'Boeing 777-300',   550, 11135, 905, 3380, 1890, 0.032, 0.042, 'H', 375500000, 14, 2, 'Aircraft_Boeing_777-300.png'),
-- Flagship (Level 15)
(14, 'Airbus',  'A380',     'Airbus A380',      853, 14800, 903, 2900, 2000, 0.036, 0.048, 'H', 445600000, 15, 2, 'Aircraft_Airbus_380.png');

-- Additional aircraft types
INSERT OR IGNORE INTO aircraft_types (id, manufacturer, model, full_name, max_passengers, range_km, cruise_speed_kmh, min_runway_takeoff_m, min_runway_landing_m, fuel_consumption_empty_per_km, fuel_consumption_full_per_km, wake_turbulence_category, new_price_usd, required_level, required_pilots, image_filename) VALUES
-- Airbus narrow-body Neo (Level 3)
(15, 'Airbus',            'A319 Neo',      'Airbus A319 Neo',                        160,  6850,  833, 1850, 1400, 0.020, 0.025, 'M',  101500000, 3, 2, 'Aircraft_Airbus_319_Neo.png'),
-- Airbus wide-body classics (Level 4)
(16, 'Airbus',            'A330-200',      'Airbus A330-200',                         406, 13450,  871, 2770, 1830, 0.031, 0.040, 'H',  238500000, 4, 2, 'Aircraft_Airbus_330-200.png'),
(17, 'Airbus',            'A330-300',      'Airbus A330-300',                         440, 11750,  871, 2770, 1830, 0.033, 0.042, 'H',  264200000, 4, 2, 'Aircraft_Airbus_330-300.png'),
(18, 'Airbus',            'A330-800 Neo',  'Airbus A330-800 Neo',                     406, 15094,  871, 2500, 1830, 0.028, 0.036, 'H',  259900000, 4, 2, 'Aircraft_Airbus_330-800_Neo.png'),
(19, 'Airbus',            'A330-900 Neo',  'Airbus A330-900 Neo',                     440, 13334,  871, 2770, 1830, 0.029, 0.037, 'H',  296400000, 4, 2, 'Aircraft_Airbus_330-900_Neo.png'),
(20, 'Airbus',            'A340-300',      'Airbus A340-300',                         440, 13500,  871, 3000, 2000, 0.038, 0.048, 'H',  238000000, 4, 2, 'Aircraft_Airbus_340-300.png'),
(21, 'Airbus',            'A340-500',      'Airbus A340-500',                         375, 16670,  871, 3050, 2100, 0.040, 0.050, 'H',  275400000, 4, 2, 'Aircraft_Airbus_340-500.png'),
(22, 'Airbus',            'A340-600',      'Airbus A340-600',                         475, 14630,  871, 3100, 2100, 0.042, 0.052, 'H',  283000000, 4, 2, 'Aircraft_Airbus_340-600.png'),
-- Airbus A350 (Level 4-5)
(23, 'Airbus',            'A350-900',      'Airbus A350-900',                         440, 15372,  903, 2600, 1800, 0.026, 0.034, 'H',  317400000, 4, 2, 'Aircraft_Airbus_350-900.png'),
(24, 'Airbus',            'A350-1000',     'Airbus A350-1000',                        480, 16112,  903, 2750, 1900, 0.028, 0.036, 'H',  366500000, 5, 2, 'Aircraft_Airbus_350-1000.png'),
-- Turboprops (Level 1)
(25, 'ATR',               '42',            'ATR 42',                                   48,  1302,  556, 1165, 1107, 0.015, 0.019, 'M',   18400000, 1, 2, 'Aircraft_ATR_ATR-42.png'),
(26, 'ATR',               '72',            'ATR 72',                                   72,  1403,  510, 1333, 1279, 0.016, 0.020, 'M',   26500000, 1, 2, 'Aircraft_ATR_ATR-72.png'),
-- Regional jet (Level 1)
(27, 'Avro',              'RJ85',          'Avro RJ85',                               112,  3335,  764, 1677, 1372, 0.025, 0.031, 'M',   35000000, 1, 2, 'Aircraft_Avro_RJ85.png'),
-- Boeing 737 Max (Level 3)
(28, 'Boeing',            '737-8 Max',     'Boeing 737-8 Max',                        210,  6570,  839, 2286, 1524, 0.022, 0.028, 'M',  121600000, 3, 2, 'Aircraft_Boeing_737-8-Max.png'),
(29, 'Boeing',            '737-10 Max',    'Boeing 737-10 Max',                       230,  5740,  839, 2438, 1585, 0.024, 0.030, 'M',  134900000, 3, 2, 'Aircraft_Boeing_737-10-Max.png'),
-- Boeing 737 Classics (Level 1-3)
(30, 'Boeing',            '737-300',       'Boeing 737-300',                          149,  4204,  794, 2316, 1524, 0.026, 0.033, 'M',   55000000, 1, 2, 'Aircraft_Boeing_737-300.png'),
(31, 'Boeing',            '737-400',       'Boeing 737-400',                          188,  4005,  794, 2438, 1585, 0.027, 0.034, 'M',   60000000, 1, 2, 'Aircraft_Boeing_737-400.png'),
(32, 'Boeing',            '737-500',       'Boeing 737-500',                          132,  4444,  794, 2286, 1524, 0.025, 0.032, 'M',   54500000, 1, 2, 'Aircraft_Boeing_737-500.png'),
-- Boeing 737 Next Gen (Level 1-3)
(33, 'Boeing',            '737-600',       'Boeing 737-600',                          132,  5648,  828, 1981, 1463, 0.023, 0.029, 'M',   74000000, 1, 2, 'Aircraft_Boeing_737-600.png'),
(34, 'Boeing',            '737-800',       'Boeing 737-800',                          189,  5436,  828, 2438, 1524, 0.024, 0.030, 'M',  106100000, 3, 2, 'Aircraft_Boeing_737-800.png'),
-- Boeing 747 (Level 4-5)
(35, 'Boeing',            '747-300',       'Boeing 747-300',                          660, 12400,  907, 3200, 2100, 0.044, 0.055, 'H',  280000000, 4, 2, 'Aircraft_Boeing_747-300.png'),
(36, 'Boeing',            '747-400',       'Boeing 747-400',                          660, 13450,  907, 3018, 2134, 0.042, 0.053, 'H',  418400000, 5, 2, 'Aircraft_Boeing_747-400.png'),
-- Boeing 757 (Level 3)
(37, 'Boeing',            '757-200',       'Boeing 757-200',                          239,  7222,  850, 1981, 1524, 0.025, 0.032, 'H',  125000000, 3, 2, 'Aircraft_Boeing_757-200.png'),
(38, 'Boeing',            '757-300',       'Boeing 757-300',                          289,  6287,  850, 2438, 1676, 0.027, 0.034, 'H',  135000000, 3, 2, 'Aircraft_Boeing_757-300.png'),
-- Boeing 777 (Level 4)
(39, 'Boeing',            '777-200',       'Boeing 777-200',                          440,  9704,  905, 3139, 1829, 0.030, 0.039, 'H',  306600000, 4, 2, 'Aircraft_Boeing_777-200.png'),
-- Boeing 787 variants (Level 4)
(40, 'Boeing',            '787-9',         'Boeing 787-9',                            406, 14140,  903, 2750, 1676, 0.028, 0.036, 'H',  292500000, 4, 2, 'Aircraft_Boeing_787-9.png'),
(41, 'Boeing',            '787-10',        'Boeing 787-10',                           440, 11910,  903, 2900, 1750, 0.029, 0.037, 'H',  338400000, 5, 2, 'Aircraft_Boeing_787-10.png'),
-- Bombardier CRJ (Level 1)
(42, 'Bombardier',        'CRJ-200',       'Bombardier CRJ-200',                       50,  3148,  786, 1876, 1463, 0.020, 0.025, 'M',   27000000, 1, 2, 'Aircraft_Bombardier_CRJ-200.png'),
(43, 'Bombardier',        'CRJ-700',       'Bombardier CRJ-700',                       78,  3620,  828, 1905, 1524, 0.021, 0.026, 'M',   36200000, 1, 2, 'Aircraft_Bombardier_CRJ-700.png'),
(44, 'Bombardier',        'CRJ-900',       'Bombardier CRJ-900',                       90,  2956,  828, 2042, 1585, 0.022, 0.027, 'M',   46300000, 1, 2, 'Aircraft_Bombardier_CRJ-900.png'),
-- British Aerospace (Level 1)
(45, 'British Aerospace', 'Jetstream 41',  'British Aerospace Jetstream 41',           29,  1482,  547, 1372, 1097, 0.018, 0.023, 'L',    8500000, 1, 2, 'Aircraft_British-Aerospace_Jetstream-41_.png'),
-- COMAC (Level 1-2)
(46, 'COMAC',             'C909',          'COMAC C909 (ARJ21)',                        95,  3704,  828, 1850, 1600, 0.023, 0.029, 'M',   38000000, 1, 2, 'Aircraft_Comac_909.png'),
(47, 'COMAC',             'C919',          'COMAC C919',                              174,  5555,  834, 2200, 1700, 0.024, 0.030, 'M',   99000000, 2, 2, 'Aircraft_Comac_919.png'),
-- De Havilland Dash 8 (Level 1)
(48, 'De Havilland',      'DHC-8-300',     'De Havilland DHC-8-300',                   56,  1558,  528, 1372, 1128, 0.016, 0.020, 'M',   17500000, 1, 2, 'Aircraft_DeHavilland_DHC-8-300.png'),
(49, 'De Havilland',      'DHC-8-400',     'De Havilland DHC-8-400',                   90,  2040,  667, 1425, 1189, 0.017, 0.021, 'M',   32700000, 1, 2, 'Aircraft_DeHavilland_DHC-8-400.png'),
-- Dornier (Level 1)
(50, 'Dornier',           '328-100',       'Dornier 328-100',                          33,  1667,  620, 1280, 1036, 0.017, 0.021, 'L',   10800000, 1, 2, 'Aircraft_Dornier_328-100.png'),
(51, 'Dornier',           '328 JET',       'Dornier 328 JET',                          34,  1852,  750, 1372, 1128, 0.018, 0.022, 'M',   14000000, 1, 2, 'Aircraft_Dornier_328-JET.png'),
-- Embraer piston/turboprop & regional jets (Level 1)
(52, 'Embraer',           'EMB 120',       'Embraer EMB 120 Brasilia',                 30,  1482,  555, 1280, 1036, 0.016, 0.020, 'L',    8000000, 1, 2, 'Aircraft_Embrear_120.png'),
(53, 'Embraer',           'ERJ 135',       'Embraer ERJ 135',                          37,  3241,  834, 1905, 1372, 0.019, 0.024, 'M',   18500000, 1, 2, 'Aircraft_Embrear_135.png'),
(54, 'Embraer',           'ERJ 140',       'Embraer ERJ 140',                          44,  2963,  834, 2012, 1402, 0.020, 0.025, 'M',   21500000, 1, 2, 'Aircraft_Embrear_140.png'),
(55, 'Embraer',           'ERJ 145',       'Embraer ERJ 145',                          50,  2871,  834, 2042, 1433, 0.021, 0.026, 'M',   29900000, 1, 2, 'Aircraft_Embrear_145.png'),
-- Embraer E-Jets (Level 1)
(56, 'Embraer',           'E190',          'Embraer E190',                            114,  4537,  829, 1693, 1350, 0.023, 0.029, 'M',   51300000, 1, 2, 'Aircraft_Embrear_190.png'),
(57, 'Embraer',           'E195',          'Embraer E195',                            124,  4074,  829, 1788, 1400, 0.024, 0.030, 'M',   53000000, 1, 2, 'Aircraft_Embrear_195.png'),
-- Saab (Level 1)
(58, 'Saab',              '340',           'Saab 340',                                 36,  1735,  522, 1200,  975, 0.015, 0.019, 'L',    7500000, 1, 2, 'Aircraft_Saab_Saab-340.png'),
-- Sukhoi (Level 1)
(59, 'Sukhoi',            'Superjet 100',  'Sukhoi Superjet 100',                     108,  4578,  828, 2052, 1680, 0.022, 0.028, 'M',   36000000, 1, 2, 'Aircraft_Suchoi_Superjet-100.png');

-- Seed service profiles
INSERT OR IGNORE INTO service_profiles (id, name, description, meal_quality, beverage_quality, entertainment_quality, comfort_level, price_multiplier) VALUES
(1, 'Economy', 'Basic service with standard amenities', 2, 2, 2, 2, 0.85),
(2, 'Standard', 'Comfortable service with good amenities', 3, 3, 3, 3, 1.0),
(3, 'Premium', 'Premium service with high-quality amenities', 5, 5, 5, 5, 1.3);

-- Seed cabin profiles (aircraft_type_id references aircraft_types)
-- Regional Jets (types 1-4)
INSERT OR IGNORE INTO cabin_profiles (id, name, aircraft_type_id, economy_seats, business_seats, first_seats) VALUES
(1,  'All Economy', 1,  88,  0,  0),
(2,  'Mixed',       1,  76,  12, 0),
(3,  'All Economy', 2,  90,  0,  0),
(4,  'Mixed',       2,  78,  12, 0),
(5,  'All Economy', 3,  114, 0,  0),
(6,  'Mixed',       3,  98,  16, 0),
(7,  'All Economy', 4,  146, 0,  0),
(8,  'Mixed',       4,  126, 20, 0),
-- Narrow-body (types 5-11)
(9,  'All Economy', 5,  135, 0,  0),
(10, 'Mixed',       5,  115, 20, 0),
(11, 'All Economy', 6,  160, 0,  0),
(12, 'Mixed',       6,  136, 24, 0),
(13, 'All Economy', 7,  132, 0,  0),
(14, 'Mixed',       7,  112, 20, 0),
(15, 'All Economy', 8,  160, 0,  0),
(16, 'Mixed',       8,  136, 24, 0),
(17, 'Two Class',   8,  120, 28, 12),
(18, 'All Economy', 9,  180, 0,  0),
(19, 'Mixed',       9,  150, 30, 0),
(20, 'Two Class',   9,  140, 32, 8),
(21, 'All Economy', 10, 220, 0,  0),
(22, 'Mixed',       10, 185, 35, 0),
(23, 'Two Class',   10, 170, 40, 10),
(24, 'All Economy', 11, 244, 0,  0),
(25, 'Mixed',       11, 200, 44, 0),
(26, 'Two Class',   11, 185, 47, 12),
-- Wide-body (types 12-13)
(27, 'All Economy', 12, 330, 0,  0),
(28, 'Two Class',   12, 260, 56, 14),
(29, 'Three Class', 12, 220, 72, 38),
(30, 'All Economy', 13, 550, 0,  0),
(31, 'Two Class',   13, 400, 110, 40),
(32, 'Three Class', 13, 350, 130, 70),
-- Flagship (type 14)
(33, 'All Economy', 14, 853, 0,   0),
(34, 'Two Class',   14, 580, 180, 93),
(35, 'Three Class', 14, 450, 220, 183);

-- Additional cabin profiles for new aircraft types
INSERT OR IGNORE INTO cabin_profiles (id, name, aircraft_type_id, economy_seats, business_seats, first_seats) VALUES
-- A319 Neo (type 15)
(36,  'All Economy', 15, 160, 0,  0),
(37,  'Mixed',       15, 136, 24, 0),
(38,  'Two Class',   15, 120, 28, 12),
-- A330-200 (type 16)
(39,  'All Economy', 16, 406, 0,  0),
(40,  'Two Class',   16, 300, 70, 36),
(41,  'Three Class', 16, 250, 90, 66),
-- A330-300 (type 17)
(42,  'All Economy', 17, 440, 0,  0),
(43,  'Two Class',   17, 320, 80, 40),
(44,  'Three Class', 17, 270, 100, 70),
-- A330-800 Neo (type 18)
(45,  'All Economy', 18, 406, 0,  0),
(46,  'Two Class',   18, 300, 70, 36),
(47,  'Three Class', 18, 250, 90, 66),
-- A330-900 Neo (type 19)
(48,  'All Economy', 19, 440, 0,  0),
(49,  'Two Class',   19, 320, 80, 40),
(50,  'Three Class', 19, 270, 100, 70),
-- A340-300 (type 20)
(51,  'All Economy', 20, 440, 0,  0),
(52,  'Two Class',   20, 320, 80, 40),
(53,  'Three Class', 20, 270, 100, 70),
-- A340-500 (type 21)
(54,  'All Economy', 21, 375, 0,  0),
(55,  'Two Class',   21, 275, 65, 35),
(56,  'Three Class', 21, 225, 85, 65),
-- A340-600 (type 22)
(57,  'All Economy', 22, 475, 0,  0),
(58,  'Two Class',   22, 350, 85, 40),
(59,  'Three Class', 22, 290, 110, 75),
-- A350-900 (type 23)
(60,  'All Economy', 23, 440, 0,  0),
(61,  'Two Class',   23, 320, 80, 40),
(62,  'Three Class', 23, 265, 100, 75),
-- A350-1000 (type 24)
(63,  'All Economy', 24, 480, 0,  0),
(64,  'Two Class',   24, 350, 90, 40),
(65,  'Three Class', 24, 290, 110, 80),
-- ATR 42 (type 25)
(66,  'All Economy', 25, 50,  0,  0),
(67,  'Mixed',       25, 42,  8,  0),
-- ATR 72 (type 26)
(68,  'All Economy', 26, 78,  0,  0),
(69,  'Mixed',       26, 66,  12, 0),
-- Avro RJ85 (type 27)
(70,  'All Economy', 27, 112, 0,  0),
(71,  'Mixed',       27, 94,  18, 0),
(72,  'Two Class',   27, 84,  22, 6),
-- Boeing 737-8 Max (type 28)
(73,  'All Economy', 28, 210, 0,  0),
(74,  'Mixed',       28, 174, 36, 0),
(75,  'Two Class',   28, 160, 38, 12),
-- Boeing 737-10 Max (type 29)
(76,  'All Economy', 29, 230, 0,  0),
(77,  'Mixed',       29, 190, 40, 0),
(78,  'Two Class',   29, 175, 43, 12),
-- Boeing 737-300 (type 30)
(79,  'All Economy', 30, 149, 0,  0),
(80,  'Mixed',       30, 125, 24, 0),
(81,  'Two Class',   30, 110, 27, 12),
-- Boeing 737-400 (type 31)
(82,  'All Economy', 31, 188, 0,  0),
(83,  'Mixed',       31, 158, 30, 0),
(84,  'Two Class',   31, 145, 33, 10),
-- Boeing 737-500 (type 32)
(85,  'All Economy', 32, 132, 0,  0),
(86,  'Mixed',       32, 110, 22, 0),
-- Boeing 737-600 (type 33)
(87,  'All Economy', 33, 132, 0,  0),
(88,  'Mixed',       33, 110, 22, 0),
-- Boeing 737-800 (type 34)
(89,  'All Economy', 34, 189, 0,  0),
(90,  'Mixed',       34, 159, 30, 0),
(91,  'Two Class',   34, 148, 33, 8),
-- Boeing 747-300 (type 35)
(92,  'All Economy', 35, 660, 0,   0),
(93,  'Two Class',   35, 480, 140, 40),
(94,  'Three Class', 35, 400, 160, 100),
-- Boeing 747-400 (type 36)
(95,  'All Economy', 36, 660, 0,   0),
(96,  'Two Class',   36, 480, 140, 40),
(97,  'Three Class', 36, 400, 160, 100),
-- Boeing 757-200 (type 37)
(98,  'All Economy', 37, 239, 0,  0),
(99,  'Mixed',       37, 195, 44, 0),
(100, 'Two Class',   37, 178, 49, 12),
-- Boeing 757-300 (type 38)
(101, 'All Economy', 38, 289, 0,  0),
(102, 'Mixed',       38, 235, 54, 0),
(103, 'Two Class',   38, 220, 57, 12),
-- Boeing 777-200 (type 39)
(104, 'All Economy', 39, 440, 0,   0),
(105, 'Two Class',   39, 320, 80,  40),
(106, 'Three Class', 39, 270, 100, 70),
-- Boeing 787-9 (type 40)
(107, 'All Economy', 40, 406, 0,  0),
(108, 'Two Class',   40, 300, 70, 36),
(109, 'Three Class', 40, 250, 90, 66),
-- Boeing 787-10 (type 41)
(110, 'All Economy', 41, 440, 0,   0),
(111, 'Two Class',   41, 320, 80,  40),
(112, 'Three Class', 41, 270, 100, 70),
-- Bombardier CRJ-200 (type 42)
(113, 'All Economy', 42, 50, 0, 0),
(114, 'Mixed',       42, 44, 6, 0),
-- Bombardier CRJ-700 (type 43)
(115, 'All Economy', 43, 78, 0,  0),
(116, 'Mixed',       43, 64, 14, 0),
-- Bombardier CRJ-900 (type 44)
(117, 'All Economy', 44, 90, 0,  0),
(118, 'Mixed',       44, 74, 16, 0),
-- British Aerospace Jetstream 41 (type 45)
(119, 'All Economy', 45, 29, 0, 0),
-- COMAC C909 (type 46)
(120, 'All Economy', 46, 95, 0,  0),
(121, 'Mixed',       46, 79, 16, 0),
-- COMAC C919 (type 47)
(122, 'All Economy', 47, 174, 0,  0),
(123, 'Mixed',       47, 148, 26, 0),
(124, 'Two Class',   47, 134, 28, 12),
-- De Havilland DHC-8-300 (type 48)
(125, 'All Economy', 48, 56, 0, 0),
(126, 'Mixed',       48, 48, 8, 0),
-- De Havilland DHC-8-400 (type 49)
(127, 'All Economy', 49, 90, 0,  0),
(128, 'Mixed',       49, 76, 14, 0),
-- Dornier 328-100 (type 50)
(129, 'All Economy', 50, 33, 0, 0),
-- Dornier 328 JET (type 51)
(130, 'All Economy', 51, 34, 0, 0),
-- Embraer EMB 120 Brasilia (type 52)
(131, 'All Economy', 52, 30, 0, 0),
-- Embraer ERJ 135 (type 53)
(132, 'All Economy', 53, 37, 0, 0),
-- Embraer ERJ 140 (type 54)
(133, 'All Economy', 54, 44, 0, 0),
(134, 'Mixed',       54, 38, 6, 0),
-- Embraer ERJ 145 (type 55)
(135, 'All Economy', 55, 50, 0, 0),
(136, 'Mixed',       55, 44, 6, 0),
-- Embraer E190 (type 56)
(137, 'All Economy', 56, 114, 0,  0),
(138, 'Mixed',       56, 96,  18, 0),
(139, 'Two Class',   56, 86,  22, 6),
-- Embraer E195 (type 57)
(140, 'All Economy', 57, 124, 0,  0),
(141, 'Mixed',       57, 104, 20, 0),
(142, 'Two Class',   57, 94,  24, 6),
-- Saab 340 (type 58)
(143, 'All Economy', 58, 36, 0, 0),
-- Sukhoi Superjet 100 (type 59)
(144, 'All Economy', 59, 108, 0,  0),
(145, 'Mixed',       59, 90,  18, 0),
(146, 'Two Class',   59, 80,  22, 6);