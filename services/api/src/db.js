const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const connectionString = process.env.DATABASE_URL || `postgresql://${process.env.POSTGRES_USER || 'jg'}:${process.env.POSTGRES_PASSWORD || 'jg123'}@${process.env.POSTGRES_HOST || 'db'}:${process.env.POSTGRES_PORT || '5432'}/${process.env.POSTGRES_DB || 'jg_motos'}`;

const pool = new Pool({
  connectionString,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const schemaSql = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS company_settings (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'JG MOTOS',
  cnpj TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  address TEXT DEFAULT '',
  city TEXT DEFAULT '',
  state TEXT DEFAULT '',
  responsible TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  document TEXT DEFAULT '',
  email TEXT DEFAULT '',
  address TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS motorcycles (
  id SERIAL PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  year TEXT DEFAULT '',
  plate TEXT DEFAULT '',
  chassis TEXT DEFAULT '',
  color TEXT DEFAULT '',
  km INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT DEFAULT '',
  supplier TEXT DEFAULT '',
  category TEXT DEFAULT '',
  cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  price NUMERIC(12,2) NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 0,
  min_quantity INTEGER NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS budgets (
  id SERIAL PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  motorcycle_id INTEGER REFERENCES motorcycles(id) ON DELETE SET NULL,
  budget_date DATE NOT NULL,
  valid_until DATE,
  status TEXT NOT NULL DEFAULT 'Aberto',
  notes TEXT DEFAULT '',
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS budget_items (
  id SERIAL PRIMARY KEY,
  budget_id INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity NUMERIC(12,2) NOT NULL DEFAULT 1,
  unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS service_orders (
  id SERIAL PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  motorcycle_id INTEGER REFERENCES motorcycles(id) ON DELETE SET NULL,
  budget_id INTEGER REFERENCES budgets(id) ON DELETE SET NULL,
  service_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'Aberta',
  complaint TEXT DEFAULT '',
  diagnosis TEXT DEFAULT '',
  services_performed TEXT DEFAULT '',
  labor_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  parts_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  sale_date DATE NOT NULL,
  payment_method TEXT DEFAULT 'Pix',
  notes TEXT DEFAULT '',
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sale_items (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  quantity NUMERIC(12,2) NOT NULL DEFAULT 1,
  unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS receipts (
  id SERIAL PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  reference_type TEXT DEFAULT 'manual',
  reference_id INTEGER,
  receipt_date DATE NOT NULL,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_method TEXT DEFAULT 'Pix',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS finance_entries (
  id SERIAL PRIMARY KEY,
  entry_type TEXT NOT NULL,
  category TEXT DEFAULT '',
  description TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  due_date DATE,
  paid_at DATE,
  status TEXT NOT NULL DEFAULT 'Pendente',
  reference_type TEXT DEFAULT '',
  reference_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fiscal_documents (
  id SERIAL PRIMARY KEY,
  doc_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pendente de integração',
  reference_type TEXT DEFAULT '',
  reference_id INTEGER,
  notes TEXT DEFAULT '',
  nfse_number TEXT DEFAULT '',
  access_key TEXT DEFAULT '',
  protocol TEXT DEFAULT '',
  xml_content TEXT DEFAULT '',
  pdf_url TEXT DEFAULT '',
  provider_response TEXT DEFAULT '',
  emitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fiscal_certificate_settings (
  id SERIAL PRIMARY KEY,
  provider_name TEXT DEFAULT '',
  environment TEXT NOT NULL DEFAULT 'homologacao',
  certificate_filename TEXT DEFAULT '',
  certificate_path TEXT DEFAULT '',
  certificate_password_encrypted TEXT DEFAULT '',
  subject_name TEXT DEFAULT '',
  issuer_name TEXT DEFAULT '',
  document_number TEXT DEFAULT '',
  valid_from DATE,
  valid_until DATE,
  last_tested_at TIMESTAMPTZ,
  is_configured BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

async function waitForDb(retries = 20, delayMs = 3000) {
  for (let i = 1; i <= retries; i += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      if (i === retries) throw error;
      console.log(`[db] Tentativa ${i}/${retries} falhou. Aguardando banco...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function bootstrap() {
  await waitForDb();
  await pool.query(schemaSql);

  await pool.query(`ALTER TABLE fiscal_documents ADD COLUMN IF NOT EXISTS nfse_number TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE fiscal_documents ADD COLUMN IF NOT EXISTS access_key TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE fiscal_documents ADD COLUMN IF NOT EXISTS protocol TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE fiscal_documents ADD COLUMN IF NOT EXISTS xml_content TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE fiscal_documents ADD COLUMN IF NOT EXISTS pdf_url TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE fiscal_documents ADD COLUMN IF NOT EXISTS provider_response TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE fiscal_documents ADD COLUMN IF NOT EXISTS emitted_at TIMESTAMPTZ`);

  const companyCheck = await pool.query('SELECT id FROM company_settings LIMIT 1');
  if (companyCheck.rowCount === 0) {
    await pool.query(
      `INSERT INTO company_settings (name, notes, responsible) VALUES ($1, $2, $3)`,
      ['JG MOTOS', 'Sistema V2 com API e banco PostgreSQL.', 'JG MOTOS']
    );
  }

  const fiscalCertCheck = await pool.query('SELECT id FROM fiscal_certificate_settings LIMIT 1');
  if (fiscalCertCheck.rowCount === 0) {
    await pool.query(
      `INSERT INTO fiscal_certificate_settings (provider_name, environment, is_configured) VALUES ($1, $2, $3)`,
      ['', 'homologacao', false]
    );
  }

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@jgmotos.local';
  const adminPassword = process.env.ADMIN_PASSWORD || '123456';
  const adminName = process.env.ADMIN_NAME || 'Administrador JG';
  const userCheck = await pool.query('SELECT id FROM users WHERE email = $1 LIMIT 1', [adminEmail]);
  if (userCheck.rowCount === 0) {
    const hash = await bcrypt.hash(adminPassword, 10);
    await pool.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)',
      [adminName, adminEmail, hash, 'admin']
    );
    console.log(`[db] Usuário administrador inicial criado: ${adminEmail}`);
  }
}

module.exports = { pool, bootstrap };
