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
  max_seats INTEGER NOT NULL,
  range_km INTEGER NOT NULL,
  new_price REAL NOT NULL,
  required_level INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS airports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  iata_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  registration_prefix TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS aircraft (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  airline_id INTEGER NOT NULL,
  aircraft_type_id INTEGER NOT NULL,
  registration TEXT UNIQUE NOT NULL,
  name TEXT,
  purchased_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (airline_id) REFERENCES airlines(id) ON DELETE CASCADE,
  FOREIGN KEY (aircraft_type_id) REFERENCES aircraft_types(id)
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

CREATE INDEX IF NOT EXISTS idx_airlines_user ON airlines(user_id);
CREATE INDEX IF NOT EXISTS idx_aircraft_airline ON aircraft(airline_id);
CREATE INDEX IF NOT EXISTS idx_routes_airline ON routes(airline_id);
CREATE INDEX IF NOT EXISTS idx_flights_airline ON flights(airline_id);
CREATE INDEX IF NOT EXISTS idx_flights_status ON flights(status);
CREATE INDEX IF NOT EXISTS idx_transactions_airline ON transactions(airline_id);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(created_at);

-- Seed airport data
INSERT OR IGNORE INTO airports (iata_code, name, country, registration_prefix) VALUES
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
('DXB', 'Dubai International Airport', 'UAE', 'A6'),
-- Singapore
('SIN', 'Singapore Changi Airport', 'Singapore', '9V'),
-- Japan
('NRT', 'Tokyo Narita Airport', 'Japan', 'JA'),
('HND', 'Tokyo Haneda Airport', 'Japan', 'JA'),
-- Australia
('SYD', 'Sydney Kingsford Smith Airport', 'Australia', 'VH');

-- Seed aircraft types (manufacturer, model, full_name, max_seats, range_km, new_price, required_level)
INSERT OR IGNORE INTO aircraft_types (manufacturer, model, full_name, max_seats, range_km, new_price, required_level) VALUES
-- Regional Jets (Level 1)
('Embraer', 'E175', 'Embraer E175', 88, 3700, 35000000, 1),
('Embraer', 'E190', 'Embraer E190', 114, 4500, 42000000, 1),
('Bombardier', 'CRJ900', 'Bombardier CRJ900', 90, 2900, 38000000, 1),
-- Narrow-body (Level 2-3)
('Airbus', 'A220-300', 'Airbus A220-300', 160, 6300, 81000000, 2),
('Airbus', 'A320neo', 'Airbus A320neo', 194, 6500, 110000000, 2),
('Airbus', 'A321neo', 'Airbus A321neo', 244, 7400, 130000000, 3),
('Boeing', '737 MAX 8', 'Boeing 737 MAX 8', 189, 6500, 121000000, 2),
('Boeing', '737 MAX 10', 'Boeing 737 MAX 10', 230, 6100, 135000000, 3),
-- Wide-body (Level 4-5)
('Airbus', 'A330-900neo', 'Airbus A330-900neo', 310, 13300, 296000000, 4),
('Boeing', '787-9', 'Boeing 787-9 Dreamliner', 296, 14100, 292000000, 4),
('Boeing', '787-10', 'Boeing 787-10 Dreamliner', 336, 11900, 338000000, 4),
('Airbus', 'A350-900', 'Airbus A350-900', 366, 15000, 317000000, 5),
('Airbus', 'A350-1000', 'Airbus A350-1000', 410, 16100, 366000000, 5),
-- Flagships (Level 6+)
('Boeing', '777-300ER', 'Boeing 777-300ER', 396, 13600, 375000000, 6),
('Airbus', 'A380', 'Airbus A380', 555, 14800, 445000000, 7);