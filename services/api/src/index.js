require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const morgan = require('morgan');
const { pool, bootstrap } = require('./db');
const { authRequired } = require('./auth');

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));

function toMoney(value) {
  return Number.parseFloat(value || 0).toFixed(2);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function nextNumber(table, prefix) {
  const { rows } = await pool.query(`SELECT COALESCE(MAX(id), 0)::int AS total FROM ${table}`);
  const count = rows[0]?.total || 0;
  return `${prefix}-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`;
}

function normalizeItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      product_id: item.product_id ? Number(item.product_id) : null,
      description: String(item.description || '').trim(),
      quantity: Number(item.quantity || 0),
      unit_price: Number(item.unit_price || 0),
      total: Number(item.total || (Number(item.quantity || 0) * Number(item.unit_price || 0))),
    }))
    .filter((item) => item.description && item.quantity > 0);
}

async function getFullBudget(id) {
  const budgetQuery = await pool.query(
    `SELECT b.*, c.name AS client_name, m.brand, m.model, m.plate
     FROM budgets b
     LEFT JOIN clients c ON c.id = b.client_id
     LEFT JOIN motorcycles m ON m.id = b.motorcycle_id
     WHERE b.id = $1`,
    [id]
  );
  if (budgetQuery.rowCount === 0) return null;
  const itemsQuery = await pool.query('SELECT * FROM budget_items WHERE budget_id = $1 ORDER BY id ASC', [id]);
  return { ...budgetQuery.rows[0], items: itemsQuery.rows };
}

app.get('/api/health', async (_req, res) => {
  const db = await pool.query('SELECT NOW() as now');
  res.json({ ok: true, serverTime: db.rows[0].now });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const result = await pool.query('SELECT id, name, email, password_hash, role FROM users WHERE email = $1 LIMIT 1', [email]);
  if (result.rowCount === 0) return res.status(401).json({ message: 'Usuário não encontrado.' });

  const user = result.rows[0];
  const valid = await bcrypt.compare(password || '', user.password_hash);
  if (!valid) return res.status(401).json({ message: 'Senha incorreta.' });

  const token = jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role },
    process.env.JWT_SECRET || 'jg_motos_super_secret',
    { expiresIn: '12h' }
  );

  return res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.get('/api/auth/me', authRequired, async (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/dashboard', authRequired, async (_req, res) => {
  const [clients, motorcycles, products, budgets, orders, sales, finance, lowStock] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS total FROM clients'),
    pool.query('SELECT COUNT(*)::int AS total FROM motorcycles'),
    pool.query('SELECT COUNT(*)::int AS total FROM products'),
    pool.query("SELECT COUNT(*)::int AS total FROM budgets WHERE status IN ('Aberto','Aprovado')"),
    pool.query("SELECT COUNT(*)::int AS total FROM service_orders WHERE status IN ('Aberta','Em andamento')"),
    pool.query('SELECT COALESCE(SUM(total),0)::numeric(12,2) AS total FROM sales WHERE sale_date = CURRENT_DATE'),
    pool.query("SELECT COALESCE(SUM(amount),0)::numeric(12,2) AS total FROM finance_entries WHERE entry_type = 'entrada' AND status = 'Pago' AND paid_at = CURRENT_DATE"),
    pool.query('SELECT id, name, quantity, min_quantity FROM products WHERE quantity <= min_quantity ORDER BY quantity ASC, name ASC LIMIT 8'),
  ]);

  const recentOrders = await pool.query(
    `SELECT so.id, so.number, so.status, so.total, c.name AS client_name, m.brand, m.model
     FROM service_orders so
     LEFT JOIN clients c ON c.id = so.client_id
     LEFT JOIN motorcycles m ON m.id = so.motorcycle_id
     ORDER BY so.created_at DESC LIMIT 6`
  );

  const recentSales = await pool.query(
    `SELECT s.id, s.number, s.total, s.sale_date, c.name AS client_name
     FROM sales s
     LEFT JOIN clients c ON c.id = s.client_id
     ORDER BY s.created_at DESC LIMIT 6`
  );

  res.json({
    metrics: {
      clients: clients.rows[0].total,
      motorcycles: motorcycles.rows[0].total,
      products: products.rows[0].total,
      openBudgets: budgets.rows[0].total,
      openOrders: orders.rows[0].total,
      salesToday: sales.rows[0].total,
      cashInToday: finance.rows[0].total,
    },
    lowStock: lowStock.rows,
    recentOrders: recentOrders.rows,
    recentSales: recentSales.rows,
  });
});

app.get('/api/company', authRequired, async (_req, res) => {
  const result = await pool.query('SELECT * FROM company_settings ORDER BY id ASC LIMIT 1');
  res.json(result.rows[0]);
});

app.put('/api/company', authRequired, async (req, res) => {
  const { name, cnpj, phone, email, address, city, state, responsible, notes } = req.body || {};
  const result = await pool.query(
    `UPDATE company_settings
     SET name = $1, cnpj = $2, phone = $3, email = $4, address = $5, city = $6, state = $7, responsible = $8, notes = $9, updated_at = NOW()
     WHERE id = (SELECT id FROM company_settings ORDER BY id ASC LIMIT 1)
     RETURNING *`,
    [name || 'JG MOTOS', cnpj || '', phone || '', email || '', address || '', city || '', state || '', responsible || '', notes || '']
  );
  res.json(result.rows[0]);
});

app.get('/api/clients', authRequired, async (_req, res) => {
  const result = await pool.query('SELECT * FROM clients ORDER BY id DESC');
  res.json(result.rows);
});

app.post('/api/clients', authRequired, async (req, res) => {
  const { name, phone, document, email, address, notes } = req.body || {};
  const result = await pool.query(
    `INSERT INTO clients (name, phone, document, email, address, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [name, phone || '', document || '', email || '', address || '', notes || '']
  );
  res.json(result.rows[0]);
});

app.put('/api/clients/:id', authRequired, async (req, res) => {
  const { id } = req.params;
  const { name, phone, document, email, address, notes } = req.body || {};
  const result = await pool.query(
    `UPDATE clients SET name=$1, phone=$2, document=$3, email=$4, address=$5, notes=$6
     WHERE id=$7 RETURNING *`,
    [name, phone || '', document || '', email || '', address || '', notes || '', id]
  );
  res.json(result.rows[0]);
});

app.delete('/api/clients/:id', authRequired, async (req, res) => {
  await pool.query('DELETE FROM clients WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/motorcycles', authRequired, async (_req, res) => {
  const result = await pool.query(
    `SELECT m.*, c.name AS client_name
     FROM motorcycles m
     LEFT JOIN clients c ON c.id = m.client_id
     ORDER BY m.id DESC`
  );
  res.json(result.rows);
});

app.post('/api/motorcycles', authRequired, async (req, res) => {
  const { client_id, brand, model, year, plate, chassis, color, km, notes } = req.body || {};
  const result = await pool.query(
    `INSERT INTO motorcycles (client_id, brand, model, year, plate, chassis, color, km, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [client_id || null, brand, model, year || '', plate || '', chassis || '', color || '', Number(km || 0), notes || '']
  );
  res.json(result.rows[0]);
});

app.put('/api/motorcycles/:id', authRequired, async (req, res) => {
  const { client_id, brand, model, year, plate, chassis, color, km, notes } = req.body || {};
  const result = await pool.query(
    `UPDATE motorcycles
     SET client_id=$1, brand=$2, model=$3, year=$4, plate=$5, chassis=$6, color=$7, km=$8, notes=$9
     WHERE id=$10 RETURNING *`,
    [client_id || null, brand, model, year || '', plate || '', chassis || '', color || '', Number(km || 0), notes || '', req.params.id]
  );
  res.json(result.rows[0]);
});

app.delete('/api/motorcycles/:id', authRequired, async (req, res) => {
  await pool.query('DELETE FROM motorcycles WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/products', authRequired, async (_req, res) => {
  const result = await pool.query('SELECT * FROM products ORDER BY id DESC');
  res.json(result.rows);
});

app.post('/api/products', authRequired, async (req, res) => {
  const { name, code, supplier, category, cost, price, quantity, min_quantity, notes } = req.body || {};
  const result = await pool.query(
    `INSERT INTO products (name, code, supplier, category, cost, price, quantity, min_quantity, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [name, code || '', supplier || '', category || '', toMoney(cost), toMoney(price), Number(quantity || 0), Number(min_quantity || 0), notes || '']
  );
  res.json(result.rows[0]);
});

app.put('/api/products/:id', authRequired, async (req, res) => {
  const { name, code, supplier, category, cost, price, quantity, min_quantity, notes } = req.body || {};
  const result = await pool.query(
    `UPDATE products
     SET name=$1, code=$2, supplier=$3, category=$4, cost=$5, price=$6, quantity=$7, min_quantity=$8, notes=$9
     WHERE id=$10 RETURNING *`,
    [name, code || '', supplier || '', category || '', toMoney(cost), toMoney(price), Number(quantity || 0), Number(min_quantity || 0), notes || '', req.params.id]
  );
  res.json(result.rows[0]);
});

app.delete('/api/products/:id', authRequired, async (req, res) => {
  await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/budgets', authRequired, async (_req, res) => {
  const result = await pool.query(
    `SELECT b.*, c.name AS client_name, m.brand, m.model, m.plate
     FROM budgets b
     LEFT JOIN clients c ON c.id = b.client_id
     LEFT JOIN motorcycles m ON m.id = b.motorcycle_id
     ORDER BY b.id DESC`
  );
  const items = await pool.query('SELECT * FROM budget_items ORDER BY id ASC');
  const byBudget = items.rows.reduce((acc, item) => {
    acc[item.budget_id] = acc[item.budget_id] || [];
    acc[item.budget_id].push(item);
    return acc;
  }, {});
  res.json(result.rows.map((row) => ({ ...row, items: byBudget[row.id] || [] })));
});

app.post('/api/budgets', authRequired, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { client_id, motorcycle_id, budget_date, valid_until, status, notes, items } = req.body || {};
    const normalizedItems = normalizeItems(items);
    const total = normalizedItems.reduce((sum, item) => sum + item.total, 0);
    const number = await nextNumber('budgets', 'ORC');
    const insertBudget = await client.query(
      `INSERT INTO budgets (number, client_id, motorcycle_id, budget_date, valid_until, status, notes, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [number, client_id || null, motorcycle_id || null, budget_date || today(), valid_until || null, status || 'Aberto', notes || '', toMoney(total)]
    );
    for (const item of normalizedItems) {
      await client.query(
        `INSERT INTO budget_items (budget_id, description, quantity, unit_price, total)
         VALUES ($1,$2,$3,$4,$5)`,
        [insertBudget.rows[0].id, item.description, item.quantity, toMoney(item.unit_price), toMoney(item.total)]
      );
    }
    await client.query('COMMIT');
    res.json(await getFullBudget(insertBudget.rows[0].id));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.put('/api/budgets/:id', authRequired, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { client_id, motorcycle_id, budget_date, valid_until, status, notes, items } = req.body || {};
    const normalizedItems = normalizeItems(items);
    const total = normalizedItems.reduce((sum, item) => sum + item.total, 0);
    await client.query(
      `UPDATE budgets SET client_id=$1, motorcycle_id=$2, budget_date=$3, valid_until=$4, status=$5, notes=$6, total=$7 WHERE id=$8`,
      [client_id || null, motorcycle_id || null, budget_date || today(), valid_until || null, status || 'Aberto', notes || '', toMoney(total), req.params.id]
    );
    await client.query('DELETE FROM budget_items WHERE budget_id = $1', [req.params.id]);
    for (const item of normalizedItems) {
      await client.query(
        `INSERT INTO budget_items (budget_id, description, quantity, unit_price, total)
         VALUES ($1,$2,$3,$4,$5)`,
        [req.params.id, item.description, item.quantity, toMoney(item.unit_price), toMoney(item.total)]
      );
    }
    await client.query('COMMIT');
    res.json(await getFullBudget(req.params.id));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.delete('/api/budgets/:id', authRequired, async (req, res) => {
  await pool.query('DELETE FROM budgets WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/budgets/:id/convert-service-order', authRequired, async (req, res) => {
  const budget = await getFullBudget(req.params.id);
  if (!budget) return res.status(404).json({ message: 'Orçamento não encontrado.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const number = await nextNumber('service_orders', 'OS');
    const order = await client.query(
      `INSERT INTO service_orders
       (number, client_id, motorcycle_id, budget_id, service_date, status, complaint, diagnosis, services_performed, labor_price, parts_total, total, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        number,
        budget.client_id,
        budget.motorcycle_id,
        budget.id,
        today(),
        'Aberta',
        budget.notes || 'Gerada a partir do orçamento.',
        '',
        budget.items.map((item) => item.description).join(' | '),
        '0.00',
        toMoney(budget.total),
        toMoney(budget.total),
        'Convertida automaticamente do orçamento.'
      ]
    );
    await client.query(`UPDATE budgets SET status = 'Convertido em OS' WHERE id = $1`, [budget.id]);
    await client.query('COMMIT');
    res.json(order.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.get('/api/service-orders', authRequired, async (_req, res) => {
  const result = await pool.query(
    `SELECT so.*, c.name AS client_name, m.brand, m.model, m.plate
     FROM service_orders so
     LEFT JOIN clients c ON c.id = so.client_id
     LEFT JOIN motorcycles m ON m.id = so.motorcycle_id
     ORDER BY so.id DESC`
  );
  res.json(result.rows);
});

app.post('/api/service-orders', authRequired, async (req, res) => {
  const { client_id, motorcycle_id, budget_id, service_date, status, complaint, diagnosis, services_performed, labor_price, parts_total, notes } = req.body || {};
  const number = await nextNumber('service_orders', 'OS');
  const total = Number(labor_price || 0) + Number(parts_total || 0);
  const result = await pool.query(
    `INSERT INTO service_orders
     (number, client_id, motorcycle_id, budget_id, service_date, status, complaint, diagnosis, services_performed, labor_price, parts_total, total, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [number, client_id || null, motorcycle_id || null, budget_id || null, service_date || today(), status || 'Aberta', complaint || '', diagnosis || '', services_performed || '', toMoney(labor_price), toMoney(parts_total), toMoney(total), notes || '']
  );
  res.json(result.rows[0]);
});

app.put('/api/service-orders/:id', authRequired, async (req, res) => {
  const { client_id, motorcycle_id, budget_id, service_date, status, complaint, diagnosis, services_performed, labor_price, parts_total, notes } = req.body || {};
  const total = Number(labor_price || 0) + Number(parts_total || 0);
  const result = await pool.query(
    `UPDATE service_orders
     SET client_id=$1, motorcycle_id=$2, budget_id=$3, service_date=$4, status=$5, complaint=$6, diagnosis=$7, services_performed=$8, labor_price=$9, parts_total=$10, total=$11, notes=$12
     WHERE id=$13 RETURNING *`,
    [client_id || null, motorcycle_id || null, budget_id || null, service_date || today(), status || 'Aberta', complaint || '', diagnosis || '', services_performed || '', toMoney(labor_price), toMoney(parts_total), toMoney(total), notes || '', req.params.id]
  );
  res.json(result.rows[0]);
});

app.delete('/api/service-orders/:id', authRequired, async (req, res) => {
  await pool.query('DELETE FROM service_orders WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/sales', authRequired, async (_req, res) => {
  const sales = await pool.query(
    `SELECT s.*, c.name AS client_name
     FROM sales s
     LEFT JOIN clients c ON c.id = s.client_id
     ORDER BY s.id DESC`
  );
  const items = await pool.query('SELECT * FROM sale_items ORDER BY id ASC');
  const bySale = items.rows.reduce((acc, item) => {
    acc[item.sale_id] = acc[item.sale_id] || [];
    acc[item.sale_id].push(item);
    return acc;
  }, {});
  res.json(sales.rows.map((row) => ({ ...row, items: bySale[row.id] || [] })));
});

app.post('/api/sales', authRequired, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { client_id, sale_date, payment_method, notes, items } = req.body || {};
    const normalizedItems = normalizeItems(items);
    const total = normalizedItems.reduce((sum, item) => sum + item.total, 0);
    const number = await nextNumber('sales', 'VEN');
    const sale = await client.query(
      `INSERT INTO sales (number, client_id, sale_date, payment_method, notes, total)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [number, client_id || null, sale_date || today(), payment_method || 'Pix', notes || '', toMoney(total)]
    );
    for (const item of normalizedItems) {
      await client.query(
        `INSERT INTO sale_items (sale_id, product_id, description, quantity, unit_price, total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [sale.rows[0].id, item.product_id, item.description, item.quantity, toMoney(item.unit_price), toMoney(item.total)]
      );
      if (item.product_id) {
        await client.query('UPDATE products SET quantity = GREATEST(quantity - $1, 0) WHERE id = $2', [item.quantity, item.product_id]);
      }
    }
    await client.query(
      `INSERT INTO finance_entries (entry_type, category, description, amount, due_date, paid_at, status, reference_type, reference_id)
       VALUES ('entrada','Venda balcão',$1,$2,$3,$3,'Pago','sale',$4)`,
      [`Venda ${number}`, toMoney(total), sale_date || today(), sale.rows[0].id]
    );
    await client.query('COMMIT');
    res.json({ ...sale.rows[0], items: normalizedItems });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.delete('/api/sales/:id', authRequired, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const items = await client.query('SELECT product_id, quantity FROM sale_items WHERE sale_id = $1', [req.params.id]);
    for (const item of items.rows) {
      if (item.product_id) {
        await client.query('UPDATE products SET quantity = quantity + $1 WHERE id = $2', [item.quantity, item.product_id]);
      }
    }
    await client.query("DELETE FROM finance_entries WHERE reference_type = 'sale' AND reference_id = $1", [req.params.id]);
    await client.query('DELETE FROM sales WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.get('/api/receipts', authRequired, async (_req, res) => {
  const result = await pool.query(
    `SELECT r.*, c.name AS client_name
     FROM receipts r
     LEFT JOIN clients c ON c.id = r.client_id
     ORDER BY r.id DESC`
  );
  res.json(result.rows);
});

app.post('/api/receipts', authRequired, async (req, res) => {
  const { client_id, reference_type, reference_id, receipt_date, amount, payment_method, notes } = req.body || {};
  const number = await nextNumber('receipts', 'REC');
  const result = await pool.query(
    `INSERT INTO receipts (number, client_id, reference_type, reference_id, receipt_date, amount, payment_method, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [number, client_id || null, reference_type || 'manual', reference_id || null, receipt_date || today(), toMoney(amount), payment_method || 'Pix', notes || '']
  );
  res.json(result.rows[0]);
});

app.delete('/api/receipts/:id', authRequired, async (req, res) => {
  await pool.query('DELETE FROM receipts WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/finance', authRequired, async (_req, res) => {
  const result = await pool.query('SELECT * FROM finance_entries ORDER BY id DESC');
  res.json(result.rows);
});

app.post('/api/finance', authRequired, async (req, res) => {
  const { entry_type, category, description, amount, due_date, paid_at, status, reference_type, reference_id } = req.body || {};
  const result = await pool.query(
    `INSERT INTO finance_entries (entry_type, category, description, amount, due_date, paid_at, status, reference_type, reference_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [entry_type || 'entrada', category || '', description || '', toMoney(amount), due_date || null, paid_at || null, status || 'Pendente', reference_type || '', reference_id || null]
  );
  res.json(result.rows[0]);
});

app.put('/api/finance/:id', authRequired, async (req, res) => {
  const { entry_type, category, description, amount, due_date, paid_at, status, reference_type, reference_id } = req.body || {};
  const result = await pool.query(
    `UPDATE finance_entries
     SET entry_type=$1, category=$2, description=$3, amount=$4, due_date=$5, paid_at=$6, status=$7, reference_type=$8, reference_id=$9
     WHERE id=$10 RETURNING *`,
    [entry_type || 'entrada', category || '', description || '', toMoney(amount), due_date || null, paid_at || null, status || 'Pendente', reference_type || '', reference_id || null, req.params.id]
  );
  res.json(result.rows[0]);
});

app.delete('/api/finance/:id', authRequired, async (req, res) => {
  await pool.query('DELETE FROM finance_entries WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/fiscal-documents', authRequired, async (_req, res) => {
  const result = await pool.query('SELECT * FROM fiscal_documents ORDER BY id DESC');
  res.json(result.rows);
});

app.post('/api/fiscal-documents', authRequired, async (req, res) => {
  const { doc_type, status, reference_type, reference_id, notes } = req.body || {};
  const result = await pool.query(
    `INSERT INTO fiscal_documents (doc_type, status, reference_type, reference_id, notes)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [doc_type || 'NFS-e', status || 'Pendente de integração', reference_type || '', reference_id || null, notes || '']
  );
  res.json(result.rows[0]);
});

app.get('/api/backup/export', authRequired, async (_req, res) => {
  const tables = ['company_settings', 'users', 'clients', 'motorcycles', 'products', 'budgets', 'budget_items', 'service_orders', 'sales', 'sale_items', 'receipts', 'finance_entries', 'fiscal_documents'];
  const payload = {};
  for (const table of tables) {
    const result = await pool.query(`SELECT * FROM ${table} ORDER BY id ASC`);
    payload[table] = result.rows;
  }
  res.json({ exported_at: new Date().toISOString(), data: payload });
});

app.post('/api/backup/import', authRequired, async (req, res) => {
  const payload = req.body?.data;
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ message: 'Backup inválido.' });
  }

  const restoreOrder = ['company_settings', 'users', 'clients', 'motorcycles', 'products', 'budgets', 'budget_items', 'service_orders', 'sales', 'sale_items', 'receipts', 'finance_entries', 'fiscal_documents'];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE sale_items, sales, budget_items, budgets, service_orders, receipts, finance_entries, fiscal_documents, motorcycles, products, clients, users, company_settings RESTART IDENTITY CASCADE');
    for (const table of restoreOrder) {
      const rows = Array.isArray(payload[table]) ? payload[table] : [];
      for (const row of rows) {
        const entries = Object.entries(row);
        if (entries.length === 0) continue;
        const columns = entries.map(([column]) => column);
        const values = entries.map(([, value]) => value);
        const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
        await client.query(
          `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
          values
        );
      }
    }
    for (const table of restoreOrder) {
      await client.query(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), true)`
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.post('/api/setup/demo', authRequired, async (_req, res) => {
  const existing = await pool.query('SELECT COUNT(*)::int AS total FROM clients');
  if (existing.rows[0].total > 0) {
    return res.json({ ok: true, message: 'Dados já existentes. Nenhum demo inserido.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c1 = await client.query(
      `INSERT INTO clients (name, phone, document, email, address, notes)
       VALUES ('Lucas Andrade','32999990001','111.222.333-44','lucas@cliente.com','Espera Feliz - MG','Cliente demo') RETURNING *`
    );
    const c2 = await client.query(
      `INSERT INTO clients (name, phone, document, email, address, notes)
       VALUES ('Marina Souza','32999990002','555.666.777-88','marina@cliente.com','Pedra Bonita - MG','Cliente demo') RETURNING *`
    );
    const m1 = await client.query(
      `INSERT INTO motorcycles (client_id, brand, model, year, plate, color, km, notes)
       VALUES ($1,'Honda','CG 160','2022','QWE1A23','Vermelha',18450,'Troca de relação') RETURNING *`,
      [c1.rows[0].id]
    );
    await client.query(
      `INSERT INTO motorcycles (client_id, brand, model, year, plate, color, km, notes)
       VALUES ($1,'Yamaha','Factor 150','2021','RTY4B56','Preta',26300,'Revisão geral')`,
      [c2.rows[0].id]
    );
    const p1 = await client.query(
      `INSERT INTO products (name, code, supplier, category, cost, price, quantity, min_quantity, notes)
       VALUES ('Óleo 20W50','OL20W50','Distribuidora Minas','Lubrificantes',24.50,39.90,12,5,'') RETURNING *`
    );
    const p2 = await client.query(
      `INSERT INTO products (name, code, supplier, category, cost, price, quantity, min_quantity, notes)
       VALUES ('Kit relação CG 160','REL-CG160','Moto Peças BR','Transmissão',145.00,229.90,3,2,'') RETURNING *`
    );
    const budget = await client.query(
      `INSERT INTO budgets (number, client_id, motorcycle_id, budget_date, valid_until, status, notes, total)
       VALUES ($1,$2,$3,$4,$5,'Aprovado','Orçamento demo',269.80) RETURNING *`,
      [await nextNumber('budgets', 'ORC'), c1.rows[0].id, m1.rows[0].id, today(), today()]
    );
    await client.query(
      `INSERT INTO budget_items (budget_id, description, quantity, unit_price, total)
       VALUES ($1,'Troca de óleo',1,39.90,39.90), ($1,'Kit relação CG 160',1,229.90,229.90)`,
      [budget.rows[0].id]
    );
    await client.query(
      `INSERT INTO service_orders (number, client_id, motorcycle_id, budget_id, service_date, status, complaint, diagnosis, services_performed, labor_price, parts_total, total, notes)
       VALUES ($1,$2,$3,$4,$5,'Em andamento','Barulho na transmissão','Desgaste no kit','Troca completa do conjunto',80.00,229.90,309.90,'OS demo')`,
      [await nextNumber('service_orders', 'OS'), c1.rows[0].id, m1.rows[0].id, budget.rows[0].id, today()]
    );
    await client.query(
      `INSERT INTO sales (number, client_id, sale_date, payment_method, notes, total)
       VALUES ($1,$2,$3,'Pix','Venda demo',39.90) RETURNING *`,
      [await nextNumber('sales', 'VEN'), c1.rows[0].id, today()]
    );
    await client.query(
      `INSERT INTO receipts (number, client_id, reference_type, receipt_date, amount, payment_method, notes)
       VALUES ($1,$2,'sale',$3,39.90,'Pix','Recibo demo')`,
      [await nextNumber('receipts', 'REC'), c1.rows[0].id, today()]
    );
    await client.query(
      `INSERT INTO finance_entries (entry_type, category, description, amount, due_date, paid_at, status, reference_type)
       VALUES ('entrada','Venda','Entrada demo',39.90,$1,$1,'Pago','manual')`,
      [today()]
    );
    await client.query(
      `INSERT INTO finance_entries (entry_type, category, description, amount, due_date, status, reference_type)
       VALUES ('saida','Compra de estoque','Reposição de lubrificantes',120.00,$1,'Pendente','manual')`,
      [today()]
    );
    await client.query(
      `INSERT INTO fiscal_documents (doc_type, status, reference_type, notes)
       VALUES ('NFS-e','Pendente de integração','service_order','Conectar prefeitura/SEFAZ na próxima etapa')`
    );
    await client.query('COMMIT');
    res.json({ ok: true, message: 'Dados demo inseridos com sucesso.' });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.get('/api/reports/summary', authRequired, async (_req, res) => {
  const [salesByMonth, topProducts, financeSummary] = await Promise.all([
    pool.query(
      `SELECT TO_CHAR(sale_date, 'YYYY-MM') AS month, COALESCE(SUM(total),0)::numeric(12,2) AS total
       FROM sales GROUP BY month ORDER BY month DESC LIMIT 12`
    ),
    pool.query(
      `SELECT description, COALESCE(SUM(quantity),0)::numeric(12,2) AS quantity, COALESCE(SUM(total),0)::numeric(12,2) AS total
       FROM sale_items GROUP BY description ORDER BY total DESC LIMIT 8`
    ),
    pool.query(
      `SELECT entry_type, COALESCE(SUM(amount),0)::numeric(12,2) AS total
       FROM finance_entries GROUP BY entry_type`
    )
  ]);
  res.json({ salesByMonth: salesByMonth.rows, topProducts: topProducts.rows, financeSummary: financeSummary.rows });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ message: 'Erro interno no servidor.', detail: error.message });
});

bootstrap()
  .then(() => {
    app.listen(port, () => {
      console.log(`JG MOTOS API rodando na porta ${port}`);
    });
  })
  .catch((error) => {
    console.error('Falha ao iniciar a API:', error);
    process.exit(1);
  });
