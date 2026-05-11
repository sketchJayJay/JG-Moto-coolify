require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const morgan = require('morgan');
const https = require('https');
const axios = require('axios');
const { pool, bootstrap } = require('./db');
const { authRequired } = require('./auth');
const {
  ensureCertStorage,
  normalizeBase64,
  parsePfxBuffer,
  saveCertificateBuffer,
  readStoredCertificate,
  deleteStoredCertificate,
  encryptSecret,
  decryptSecret,
} = require('./fiscalCert');

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

async function getFullServiceOrder(id) {
  const orderQuery = await pool.query(
    `SELECT so.*, c.name AS client_name, c.document AS client_document, c.phone AS client_phone, c.email AS client_email, c.address AS client_address,
            m.brand, m.model, m.plate
     FROM service_orders so
     LEFT JOIN clients c ON c.id = so.client_id
     LEFT JOIN motorcycles m ON m.id = so.motorcycle_id
     WHERE so.id = $1`,
    [id]
  );
  if (orderQuery.rowCount === 0) return null;
  const itemsQuery = await pool.query('SELECT * FROM service_order_items WHERE order_id = $1 ORDER BY id ASC', [id]);
  return { ...orderQuery.rows[0], items: itemsQuery.rows };
}

function sanitizeFiscalCertificate(row) {
  if (!row) {
    return {
      provider_name: '',
      environment: 'homologacao',
      is_configured: false,
      certificate_filename: '',
      subject_name: '',
      issuer_name: '',
      document_number: '',
      valid_from: null,
      valid_until: null,
      last_tested_at: null,
      has_password: false,
    };
  }

  return {
    id: row.id,
    provider_name: row.provider_name || '',
    environment: row.environment || 'homologacao',
    is_configured: Boolean(row.is_configured),
    certificate_filename: row.certificate_filename || '',
    certificate_path: row.certificate_path || '',
    subject_name: row.subject_name || '',
    issuer_name: row.issuer_name || '',
    document_number: row.document_number || '',
    valid_from: row.valid_from || null,
    valid_until: row.valid_until || null,
    last_tested_at: row.last_tested_at || null,
    has_password: Boolean(row.certificate_password_encrypted),
  };
}

async function getFiscalCertificateRow() {
  const result = await pool.query('SELECT * FROM fiscal_certificate_settings ORDER BY id ASC LIMIT 1');
  return result.rows[0] || null;
}

function safeJsonParse(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (_error) {
    return fallback;
  }
}

function buildFiscalPreviewText(payload = {}) {
  return [
    'NFS-e | Pré-nota de serviço',
    `Cliente: ${payload.customer_name || '-'}`,
    `CPF/CNPJ: ${payload.customer_document || '-'}`,
    `Endereço: ${payload.customer_address || '-'}`,
    `E-mail: ${payload.customer_email || '-'}`,
    `Data do serviço: ${payload.service_date || '-'}`,
    `Município da prestação: ${payload.service_city || '-'}`,
    `Código do serviço: ${payload.service_code || '-'}`,
    `Valor do serviço: R$ ${Number(payload.service_value || 0).toFixed(2)}`,
    `Descrição do serviço: ${payload.service_description || '-'}`,
    `Observações: ${payload.notes || '-'}`,
  ].join('\n');
}

function validateFiscalPayload(payload = {}) {
  const required = [
    ['service_date', 'Data do serviço'],
    ['service_code', 'Código do serviço'],
    ['service_city', 'Município da prestação'],
    ['service_description', 'Descrição do serviço'],
    ['customer_name', 'Tomador / cliente'],
    ['customer_document', 'CPF/CNPJ do cliente'],
  ];
  const missing = required.filter(([key]) => !String(payload[key] || '').trim()).map(([, label]) => label);
  if (Number(payload.service_value || 0) <= 0) missing.push('Valor do serviço');
  return missing;
}

async function markFiscalDocumentStatus(id, fields = {}) {
  const current = await pool.query('SELECT * FROM fiscal_documents WHERE id = $1', [id]);
  if (current.rowCount === 0) return null;
  const row = current.rows[0];
  const merged = {
    status: fields.status ?? row.status,
    notes: fields.notes ?? row.notes,
    nfse_number: fields.nfse_number ?? row.nfse_number,
    access_key: fields.access_key ?? row.access_key,
    protocol: fields.protocol ?? row.protocol,
    xml_content: fields.xml_content ?? row.xml_content,
    pdf_url: fields.pdf_url ?? row.pdf_url,
    provider_response: fields.provider_response ?? row.provider_response,
    emitted_at: fields.emitted_at ?? row.emitted_at,
  };
  const result = await pool.query(
    `UPDATE fiscal_documents
     SET status=$1, notes=$2, nfse_number=$3, access_key=$4, protocol=$5, xml_content=$6, pdf_url=$7, provider_response=$8, emitted_at=$9
     WHERE id=$10 RETURNING *`,
    [merged.status, merged.notes, merged.nfse_number, merged.access_key, merged.protocol, merged.xml_content, merged.pdf_url, merged.provider_response, merged.emitted_at, id]
  );
  return result.rows[0];
}


function cleanDigits(value = '') {
  return String(value || '').replace(/\D/g, '');
}

function moneyNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const normalized = String(value || '')
    .replace(/\s/g, '')
    .replace(/R\$/gi, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function serviceCodeToNational(value = '') {
  const digits = cleanDigits(value);
  if (digits.length >= 6) return digits.slice(0, 6);
  return digits.padEnd(6, '0');
}

function normalizeNuvemAmbiente(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (['sandbox', 'homologacao', 'homologação', 'teste'].includes(normalized)) return 'homologacao';
  return 'producao';
}

function nuvemApiBaseUrl() {
  const explicit = process.env.NUVEMFISCAL_BASE_URL || process.env.NUVEMFISCAL_API_BASE_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  const env = String(process.env.NUVEMFISCAL_AMBIENTE || process.env.NUVEMFISCAL_API_ENV || 'producao').toLowerCase();
  return env === 'sandbox' || env === 'homologacao' || env === 'homologação'
    ? 'https://api.sandbox.nuvemfiscal.com.br'
    : 'https://api.nuvemfiscal.com.br';
}

let nuvemTokenCache = { token: '', expiresAt: 0, scope: '' };

async function getNuvemFiscalToken(scope = 'nfse') {
  const clientId = process.env.NUVEMFISCAL_CLIENT_ID || process.env.NUVEMFISCAL_CLIENTID;
  const clientSecret = process.env.NUVEMFISCAL_CLIENT_SECRET || process.env.NUVEMFISCAL_CLIENTSECRET;
  if (!clientId || !clientSecret) {
    const error = new Error('Credenciais da Nuvem Fiscal não configuradas. Defina NUVEMFISCAL_CLIENT_ID e NUVEMFISCAL_CLIENT_SECRET no Coolify.');
    error.statusCode = 501;
    throw error;
  }

  const now = Date.now();
  if (nuvemTokenCache.token && nuvemTokenCache.scope === scope && nuvemTokenCache.expiresAt > now + 60_000) {
    return nuvemTokenCache.token;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  });

  const response = await axios.post('https://auth.nuvemfiscal.com.br/oauth/token', body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300 || !response.data?.access_token) {
    const msg = extractProviderMessage(response.data) || `Falha ao autenticar na Nuvem Fiscal (${response.status}).`;
    const error = new Error(msg);
    error.statusCode = response.status || 500;
    error.providerResponse = response.data;
    throw error;
  }

  nuvemTokenCache = {
    token: response.data.access_token,
    scope,
    expiresAt: now + (Number(response.data.expires_in || 3600) * 1000),
  };
  return nuvemTokenCache.token;
}

function extractProviderMessage(data) {
  if (!data) return '';
  if (typeof data === 'string') return data.trim();
  const candidates = [data.message, data.mensagem, data.error_description, data.error?.message, data.error?.descricao, data.error?.code, data.descricao];
  const found = candidates.find((item) => String(item || '').trim());
  if (found) return String(found).trim();
  const errors = data.errors || data.erros || data.error?.errors || data.mensagens;
  if (Array.isArray(errors) && errors.length) {
    return errors
      .map((err) => [err.codigo || err.code, err.descricao || err.description || err.message, err.correcao || err.correction].filter(Boolean).join(' - '))
      .filter(Boolean)
      .join(' | ');
  }
  return '';
}

function mapNuvemFiscalStatus(data = {}) {
  const raw = String(data.status || data.situacao || data.estado || '').toLowerCase();
  if (raw.includes('autoriz') || raw === 'concluido' || raw === 'processado') return 'Autorizada';
  if (raw.includes('cancel')) return 'Cancelada';
  if (raw.includes('negad') || raw.includes('rejeit') || raw.includes('erro')) return 'Rejeitada';
  if (raw.includes('process') || raw.includes('pendente') || raw.includes('aguard')) return 'Enviada';
  return raw ? data.status : 'Enviada';
}

function extractNuvemFields(data = {}) {
  const nfse = data.nfse || data.NFSe || data;
  return {
    status: mapNuvemFiscalStatus(data),
    nfse_number: data.numero || data.numero_nfse || data.nfse_number || nfse.numero || nfse.nNFSe || '',
    access_key: data.chave || data.chave_acesso || data.codigo_verificacao || data.access_key || nfse.chave || nfse.chave_acesso || '',
    protocol: data.protocolo || data.id || data.id_nuvem || data.idNuvem || '',
    xml_content: data.xml || data.xml_content || '',
    pdf_url: data.pdf || data.pdf_url || '',
    emitted_at: data.emitida_em || data.data_emissao || data.created_at || new Date().toISOString(),
  };
}

function getServiceMunicipalityCode(payload = {}) {
  return cleanDigits(payload.service_city_code || process.env.NUVEMFISCAL_MUNICIPIO_CODIGO || process.env.NUVEMFISCAL_CITY_CODE || '3143906');
}

function buildNuvemFiscalDpsPayload(docRow, payload = {}, certRow = {}) {
  const document = cleanDigits(process.env.NUVEMFISCAL_COMPANY_CNPJ || certRow.document_number || process.env.COMPANY_CNPJ || '40193367000193');
  const customerDocument = cleanDigits(payload.customer_document);
  const serviceValue = Number(moneyNumber(payload.service_value).toFixed(2));
  const ambiente = normalizeNuvemAmbiente(process.env.NUVEMFISCAL_NFSE_AMBIENTE || process.env.NUVEMFISCAL_AMBIENTE || certRow.environment || 'producao');
  const municipalityCode = getServiceMunicipalityCode(payload);
  const serviceCode = serviceCodeToNational(payload.service_code || process.env.NUVEMFISCAL_SERVICE_CODE || '140301');
  const now = new Date().toISOString();

  const toma = {
    xNome: String(payload.customer_name || '').trim(),
  };
  if (customerDocument.length === 14) toma.CNPJ = customerDocument;
  else if (customerDocument.length === 11) toma.CPF = customerDocument;
  else toma.NIF = customerDocument || '00000000000';
  if (payload.customer_email) toma.email = String(payload.customer_email).trim();

  return {
    provedor: process.env.NUVEMFISCAL_PROVEDOR || 'nacional',
    ambiente,
    referencia: `jg-nfse-${docRow.id}`.slice(0, 50),
    infDPS: {
      tpAmb: ambiente === 'producao' ? 1 : 2,
      dhEmi: now,
      verAplic: 'JG MOTOS V2',
      dCompet: payload.service_date || today(),
      prest: {
        CNPJ: document,
      },
      toma,
      serv: {
        locPrest: {
          cLocPrestacao: municipalityCode,
        },
        cServ: {
          cTribNac: serviceCode,
          CNAE: cleanDigits(process.env.NUVEMFISCAL_CNAE || '4543900'),
          xDescServ: String(payload.service_description || '').trim(),
        },
      },
      valores: {
        vServPrest: {
          vServ: serviceValue,
        },
        trib: {
          tribMun: {
            tribISSQN: Number(process.env.NUVEMFISCAL_TRIB_ISSQN || 1),
            tpRetISSQN: Number(process.env.NUVEMFISCAL_RETENCAO_ISSQN || 1),
            cLocIncid: municipalityCode,
          },
          // Obrigatório no layout nacional da NFS-e.
          // Para MEI, informe somente UMA opção dentro de totTrib.
          // indTotTrib: 0 = não informar valor aproximado total de tributos.
          totTrib: {
            indTotTrib: 0,
          },
        },
      },
    },
  };
}

async function emitFiscalDocumentWithNuvem(docRow, certRow) {
  const payload = safeJsonParse(docRow.notes, {});
  const missing = validateFiscalPayload(payload);
  if (missing.length) {
    const error = new Error(`Preencha antes de emitir: ${missing.join(', ')}.`);
    error.statusCode = 400;
    throw error;
  }

  const token = await getNuvemFiscalToken(process.env.NUVEMFISCAL_SCOPE || 'nfse');
  const requestPayload = buildNuvemFiscalDpsPayload(docRow, payload, certRow || {});
  const url = `${nuvemApiBaseUrl()}${process.env.NUVEMFISCAL_NFSE_EMIT_PATH || '/nfse/dps'}`;

  let response;
  try {
    response = await axios.post(url, requestPayload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 60000,
      validateStatus: () => true,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
  } catch (err) {
    const providerRecord = {
      provider: 'nuvem_fiscal',
      transport_error: true,
      request_url: url,
      request_payload: requestPayload,
      status_code: err.response?.status || null,
      response: err.response?.data || null,
      message: err.message || 'Erro de comunicação com a Nuvem Fiscal.',
    };
    const error = new Error(providerRecord.message);
    error.statusCode = providerRecord.status_code || 502;
    error.providerResponse = providerRecord;
    throw error;
  }

  const parsed = typeof response.data === 'string' ? safeJsonParse(response.data, { raw: response.data }) : (response.data || {});
  const providerRecord = {
    provider: 'nuvem_fiscal',
    request_url: url,
    status_code: response.status,
    request_payload: requestPayload,
    response: parsed,
  };
  console.log('[nuvem_fiscal_emit]', JSON.stringify({ status_code: response.status, request_url: url, response: parsed }));

  if (response.status < 200 || response.status >= 300) {
    const msg = extractProviderMessage(parsed) || `Falha ao emitir NFS-e pela Nuvem Fiscal (${response.status}).`;
    const error = new Error(msg);
    error.statusCode = response.status;
    error.providerResponse = providerRecord;
    throw error;
  }

  const fields = extractNuvemFields(parsed);
  return {
    ...fields,
    provider_response: JSON.stringify(providerRecord),
    emitted_at: fields.status === 'Autorizada' ? (fields.emitted_at || new Date().toISOString()) : null,
  };
}

async function consultFiscalDocumentWithNuvem(docRow) {
  const providerData = safeJsonParse(docRow.provider_response, {});
  const nuvemId = providerData?.response?.id || providerData?.response?.id_nuvem || providerData?.response?.idNuvem || docRow.protocol;
  if (!nuvemId) return docRow;

  const token = await getNuvemFiscalToken(process.env.NUVEMFISCAL_SCOPE || 'nfse');
  const url = `${nuvemApiBaseUrl()}/nfse/${encodeURIComponent(nuvemId)}`;
  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeout: 30000,
    validateStatus: () => true,
  });

  const parsed = typeof response.data === 'string' ? safeJsonParse(response.data, { raw: response.data }) : (response.data || {});
  const providerRecord = {
    provider: 'nuvem_fiscal',
    status_code: response.status,
    previous: providerData,
    response: parsed,
  };

  if (response.status < 200 || response.status >= 300) {
    const msg = extractProviderMessage(parsed) || `Falha ao consultar NFS-e pela Nuvem Fiscal (${response.status}).`;
    const error = new Error(msg);
    error.statusCode = response.status;
    error.providerResponse = providerRecord;
    throw error;
  }

  const fields = extractNuvemFields(parsed);
  return markFiscalDocumentStatus(docRow.id, {
    ...fields,
    provider_response: JSON.stringify(providerRecord),
    emitted_at: fields.status === 'Autorizada' ? (fields.emitted_at || new Date().toISOString()) : docRow.emitted_at,
  });
}

async function emitFiscalDocument(docRow, certRow) {
  if (process.env.NUVEMFISCAL_CLIENT_ID || process.env.NUVEMFISCAL_CLIENTID) {
    return emitFiscalDocumentWithNuvem(docRow, certRow);
  }

  const payload = safeJsonParse(docRow.notes, {});
  const missing = validateFiscalPayload(payload);
  if (missing.length) {
    const error = new Error(`Preencha antes de emitir: ${missing.join(', ')}.`);
    error.statusCode = 400;
    throw error;
  }

  requireConfiguredCertificate(certRow);

  const apiBaseUrl = certRow.environment === 'producao'
    ? (process.env.NFSE_API_BASE_URL_PRODUCAO || process.env.NFSE_API_BASE_URL || '')
    : (process.env.NFSE_API_BASE_URL_HOMOLOGACAO || process.env.NFSE_API_BASE_URL || '');

  if (!apiBaseUrl) {
    const error = new Error('Integração da NFS-e ainda não está configurada no servidor. Defina NFSE_API_BASE_URL_HOMOLOGACAO ou NFSE_API_BASE_URL_PRODUCAO.');
    error.statusCode = 501;
    throw error;
  }

  const emitPath = process.env.NFSE_API_EMIT_PATH || '/emit';
  const providerPayload = {
    environment: certRow.environment || 'homologacao',
    provider_name: certRow.provider_name || '',
    company_document: certRow.document_number || '',
    document_type: docRow.doc_type || 'NFS-e',
    preview_text: buildFiscalPreviewText(payload),
    payload,
  };

  try {
    const password = decryptSecret(certRow.certificate_password_encrypted);
    const pfxBuffer = await readStoredCertificate(certRow.certificate_path);
    const httpsAgent = new https.Agent({
      pfx: pfxBuffer,
      passphrase: password,
      rejectUnauthorized: true,
    });

    const url = `${String(apiBaseUrl).replace(/\/$/, '')}${String(emitPath).startsWith('/') ? emitPath : `/${emitPath}`}`;
    const response = await axios.post(url, providerPayload, {
      httpsAgent,
      headers: {
        'Content-Type': 'application/json',
        'X-JG-MOTOS-SOURCE': 'coolify-app',
      },
      timeout: 30000,
      validateStatus: () => true,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    const parsed = typeof response.data === 'string'
      ? safeJsonParse(response.data, { raw: response.data })
      : (response.data || {});

    if (response.status < 200 || response.status >= 300) {
      const msg = extractProviderMessage(parsed) || `Falha ao emitir NFS-e (${response.status}).`;
      const error = new Error(msg);
      error.statusCode = response.status;
      error.providerResponse = parsed;
      throw error;
    }

    return {
      status: parsed.status || 'Autorizada',
      nfse_number: parsed.nfse_number || parsed.numero || '',
      access_key: parsed.access_key || parsed.chave || '',
      protocol: parsed.protocol || parsed.protocolo || '',
      xml_content: parsed.xml_content || parsed.xml || '',
      pdf_url: parsed.pdf_url || parsed.pdf || '',
      provider_response: JSON.stringify(parsed),
      emitted_at: new Date().toISOString(),
    };
  } catch (err) {
    const status = err.response?.status || err.statusCode || 500;
    const data = err.response?.data || err.providerResponse || null;
    const parsedData = typeof data === 'string' ? safeJsonParse(data, { raw: data }) : data;
    const msg = extractProviderMessage(parsedData) || err.message || `Falha ao emitir NFS-e (${status}).`;
    const error = new Error(msg);
    error.statusCode = status;
    error.providerResponse = parsedData;
    throw error;
  }
}

function requireConfiguredCertificate(row) {
  if (!row || !row.is_configured || !row.certificate_path || !row.certificate_password_encrypted) {
    const error = new Error('Nenhum certificado fiscal configurado.');
    error.statusCode = 400;
    throw error;
  }
}

async function testStoredFiscalCertificate(row) {
  requireConfiguredCertificate(row);
  const password = decryptSecret(row.certificate_password_encrypted);
  const buffer = await readStoredCertificate(row.certificate_path);
  const parsed = parsePfxBuffer(buffer, password);
  const update = await pool.query(
    `UPDATE fiscal_certificate_settings
     SET subject_name = $1, issuer_name = $2, document_number = $3,
         valid_from = $4, valid_until = $5, last_tested_at = NOW(), updated_at = NOW(), is_configured = TRUE
     WHERE id = $6
     RETURNING *`,
    [parsed.subject, parsed.issuer, parsed.document, parsed.validFrom, parsed.validUntil, row.id]
  );
  return { row: update.rows[0], parsed };
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
        `INSERT INTO budget_items (budget_id, product_id, description, quantity, unit_price, total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [insertBudget.rows[0].id, item.product_id, item.description, item.quantity, toMoney(item.unit_price), toMoney(item.total)]
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
        `INSERT INTO budget_items (budget_id, product_id, description, quantity, unit_price, total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.params.id, item.product_id, item.description, item.quantity, toMoney(item.unit_price), toMoney(item.total)]
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
    for (const item of (budget.items || [])) {
      await client.query(
        `INSERT INTO service_order_items (order_id, product_id, description, quantity, unit_price, total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [order.rows[0].id, item.product_id || null, item.description, item.quantity, toMoney(item.unit_price), toMoney(item.total)]
      );
    }
    await client.query(`UPDATE budgets SET status = 'Convertido em OS' WHERE id = $1`, [budget.id]);
    await client.query('COMMIT');
    res.json(await getFullServiceOrder(order.rows[0].id));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.get('/api/service-orders', authRequired, async (_req, res) => {
  const result = await pool.query(
    `SELECT so.*, c.name AS client_name, c.document AS client_document, c.phone AS client_phone, c.email AS client_email, c.address AS client_address,
            m.brand, m.model, m.plate
     FROM service_orders so
     LEFT JOIN clients c ON c.id = so.client_id
     LEFT JOIN motorcycles m ON m.id = so.motorcycle_id
     ORDER BY so.id DESC`
  );
  const items = await pool.query('SELECT * FROM service_order_items ORDER BY id ASC');
  const byOrder = items.rows.reduce((acc, item) => {
    acc[item.order_id] = acc[item.order_id] || [];
    acc[item.order_id].push(item);
    return acc;
  }, {});
  res.json(result.rows.map((row) => ({ ...row, items: byOrder[row.id] || [] })));
});

app.post('/api/service-orders', authRequired, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { client_id, motorcycle_id, budget_id, service_date, status, complaint, diagnosis, services_performed, labor_price, parts_total, notes, items } = req.body || {};
    const normalizedItems = normalizeItems(items);
    const partsTotal = normalizedItems.reduce((sum, item) => sum + item.total, 0);
    const number = await nextNumber('service_orders', 'OS');
    const total = Number(labor_price || 0) + Number(partsTotal || parts_total || 0);
    const result = await client.query(
      `INSERT INTO service_orders
       (number, client_id, motorcycle_id, budget_id, service_date, status, complaint, diagnosis, services_performed, labor_price, parts_total, total, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [number, client_id || null, motorcycle_id || null, budget_id || null, service_date || today(), status || 'Aberta', complaint || '', diagnosis || '', services_performed || '', toMoney(labor_price), toMoney(partsTotal), toMoney(total), notes || '']
    );
    for (const item of normalizedItems) {
      await client.query(
        `INSERT INTO service_order_items (order_id, product_id, description, quantity, unit_price, total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [result.rows[0].id, item.product_id, item.description, item.quantity, toMoney(item.unit_price), toMoney(item.total)]
      );
    }
    await client.query('COMMIT');
    res.json(await getFullServiceOrder(result.rows[0].id));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.put('/api/service-orders/:id', authRequired, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { client_id, motorcycle_id, budget_id, service_date, status, complaint, diagnosis, services_performed, labor_price, parts_total, notes, items } = req.body || {};
    const normalizedItems = normalizeItems(items);
    const partsTotal = normalizedItems.reduce((sum, item) => sum + item.total, 0);
    const total = Number(labor_price || 0) + Number(partsTotal || parts_total || 0);
    await client.query(
      `UPDATE service_orders
       SET client_id=$1, motorcycle_id=$2, budget_id=$3, service_date=$4, status=$5, complaint=$6, diagnosis=$7, services_performed=$8, labor_price=$9, parts_total=$10, total=$11, notes=$12
       WHERE id=$13`,
      [client_id || null, motorcycle_id || null, budget_id || null, service_date || today(), status || 'Aberta', complaint || '', diagnosis || '', services_performed || '', toMoney(labor_price), toMoney(partsTotal), toMoney(total), notes || '', req.params.id]
    );
    await client.query('DELETE FROM service_order_items WHERE order_id = $1', [req.params.id]);
    for (const item of normalizedItems) {
      await client.query(
        `INSERT INTO service_order_items (order_id, product_id, description, quantity, unit_price, total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.params.id, item.product_id, item.description, item.quantity, toMoney(item.unit_price), toMoney(item.total)]
      );
    }
    await client.query('COMMIT');
    res.json(await getFullServiceOrder(req.params.id));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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

app.get('/api/fiscal/certificate', authRequired, async (_req, res) => {
  const row = await getFiscalCertificateRow();
  res.json(sanitizeFiscalCertificate(row));
});

app.put('/api/fiscal/certificate', authRequired, async (req, res) => {
  await ensureCertStorage();
  const row = await getFiscalCertificateRow();
  if (!row) return res.status(500).json({ message: 'Configuração fiscal não encontrada.' });

  const { provider_name, environment, certificate_filename, certificate_base64, certificate_password } = req.body || {};
  const cleanProvider = String(provider_name || '').trim();
  const cleanEnvironment = String(environment || row.environment || 'homologacao').trim() || 'homologacao';
  const hasNewFile = Boolean(String(certificate_base64 || '').trim());
  const hasNewPassword = typeof certificate_password === 'string' && certificate_password.length > 0;

  let filePath = row.certificate_path || '';
  let fileName = row.certificate_filename || '';
  let encryptedPassword = row.certificate_password_encrypted || '';
  let parsed = null;

  if (hasNewFile) {
    if (!hasNewPassword) {
      return res.status(400).json({ message: 'Informe a senha do certificado para importar o arquivo.' });
    }

    const raw = normalizeBase64(certificate_base64);
    const buffer = Buffer.from(raw, 'base64');
    parsed = parsePfxBuffer(buffer, certificate_password);
    const saved = await saveCertificateBuffer(certificate_filename || 'certificado.pfx', buffer);
    if (row.certificate_path && row.certificate_path !== saved.fullPath) {
      await deleteStoredCertificate(row.certificate_path);
    }
    filePath = saved.fullPath;
    fileName = certificate_filename || saved.storedName;
    encryptedPassword = encryptSecret(certificate_password);
  } else if (hasNewPassword) {
    if (!row.certificate_path) {
      return res.status(400).json({ message: 'Envie o arquivo .pfx ou .p12 junto da senha na primeira configuração.' });
    }
    const buffer = await readStoredCertificate(row.certificate_path);
    parsed = parsePfxBuffer(buffer, certificate_password);
    encryptedPassword = encryptSecret(certificate_password);
    filePath = row.certificate_path;
    fileName = row.certificate_filename || certificate_filename || '';
  }

  const result = await pool.query(
    `UPDATE fiscal_certificate_settings
     SET provider_name = $1, environment = $2, certificate_filename = $3, certificate_path = $4,
         certificate_password_encrypted = $5, subject_name = $6, issuer_name = $7, document_number = $8,
         valid_from = $9, valid_until = $10, is_configured = $11, updated_at = NOW(),
         last_tested_at = CASE WHEN $12 THEN NOW() ELSE last_tested_at END
     WHERE id = $13
     RETURNING *`,
    [
      cleanProvider,
      cleanEnvironment,
      fileName,
      filePath,
      encryptedPassword,
      parsed?.subject || row.subject_name || '',
      parsed?.issuer || row.issuer_name || '',
      parsed?.document || row.document_number || '',
      parsed?.validFrom || row.valid_from || null,
      parsed?.validUntil || row.valid_until || null,
      Boolean(filePath && encryptedPassword),
      Boolean(parsed),
      row.id,
    ]
  );

  res.json({
    message: parsed ? 'Certificado salvo e validado com sucesso.' : 'Configuração fiscal atualizada com sucesso.',
    certificate: sanitizeFiscalCertificate(result.rows[0]),
  });
});

app.post('/api/fiscal/certificate/test', authRequired, async (_req, res) => {
  const row = await getFiscalCertificateRow();
  const { row: updated, parsed } = await testStoredFiscalCertificate(row);
  res.json({
    ok: true,
    message: 'Certificado lido com sucesso. Arquivo e senha estão funcionando.',
    certificate: sanitizeFiscalCertificate(updated),
    parsed,
  });
});

app.delete('/api/fiscal/certificate', authRequired, async (_req, res) => {
  const row = await getFiscalCertificateRow();
  if (row?.certificate_path) {
    await deleteStoredCertificate(row.certificate_path);
  }

  const result = await pool.query(
    `UPDATE fiscal_certificate_settings
     SET provider_name = '', environment = 'homologacao', certificate_filename = '', certificate_path = '',
         certificate_password_encrypted = '', subject_name = '', issuer_name = '', document_number = '',
         valid_from = NULL, valid_until = NULL, last_tested_at = NULL, is_configured = FALSE, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [row?.id]
  );

  res.json({ ok: true, message: 'Certificado removido do sistema.', certificate: sanitizeFiscalCertificate(result.rows[0]) });
});


app.get('/api/fiscal/nuvemfiscal/test', authRequired, async (_req, res) => {
  try {
    const scope = process.env.NUVEMFISCAL_SCOPE || 'nfse';
    const token = await getNuvemFiscalToken(scope);
    res.json({
      ok: true,
      provider: 'nuvem_fiscal',
      build_fix: 'tottrib-2026-05-11-v4-botao-fixo',
      base_url: nuvemApiBaseUrl(),
      scope,
      company_cnpj: cleanDigits(process.env.NUVEMFISCAL_COMPANY_CNPJ || process.env.COMPANY_CNPJ || '40193367000193'),
      token_obtido: Boolean(token),
      token_preview: token ? `${token.slice(0, 8)}...${token.slice(-6)}` : '',
      message: 'Credenciais OAuth da Nuvem Fiscal funcionando. Agora o próximo teste é a emissão da NFS-e.',
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      ok: false,
      provider: 'nuvem_fiscal',
      message: error.message || 'Falha ao testar Nuvem Fiscal.',
      provider_response: error.providerResponse || null,
    });
  }
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


app.delete('/api/fiscal-documents/:id', authRequired, async (req, res) => {
  await pool.query('DELETE FROM fiscal_documents WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/fiscal-documents/:id/emit', authRequired, async (req, res) => {
  const docResult = await pool.query('SELECT * FROM fiscal_documents WHERE id = $1', [req.params.id]);
  if (docResult.rowCount === 0) return res.status(404).json({ message: 'Documento fiscal não encontrado.' });

  const certRow = await getFiscalCertificateRow();
  await markFiscalDocumentStatus(req.params.id, { status: 'Emitindo...' });

  try {
    const emitted = await emitFiscalDocument(docResult.rows[0], certRow);
    const row = await markFiscalDocumentStatus(req.params.id, emitted);
    res.json({
      message: 'Nota fiscal enviada com sucesso.',
      document: row,
    });
  } catch (error) {
    const current = docResult.rows[0];
    const providerResponse = error.providerResponse ? JSON.stringify(error.providerResponse) : (current.provider_response || '');
    const row = await markFiscalDocumentStatus(req.params.id, {
      status: error.statusCode && error.statusCode < 500 ? 'Rejeitada' : 'Erro na emissão',
      provider_response: providerResponse || JSON.stringify({ message: error.message }),
    });
    res.status(error.statusCode || 500).json({
      message: error.message || 'Falha ao emitir a nota fiscal.',
      document: row,
    });
  }
});

app.post('/api/fiscal-documents/:id/status', authRequired, async (req, res) => {
  const docResult = await pool.query('SELECT * FROM fiscal_documents WHERE id = $1', [req.params.id]);
  if (docResult.rowCount === 0) return res.status(404).json({ message: 'Documento fiscal não encontrado.' });

  if (process.env.NUVEMFISCAL_CLIENT_ID || process.env.NUVEMFISCAL_CLIENTID) {
    try {
      const updated = await consultFiscalDocumentWithNuvem(docResult.rows[0]);
      return res.json({ document: updated || docResult.rows[0] });
    } catch (error) {
      const providerResponse = error.providerResponse ? JSON.stringify(error.providerResponse) : JSON.stringify({ message: error.message });
      const row = await markFiscalDocumentStatus(req.params.id, {
        status: error.statusCode && error.statusCode < 500 ? 'Rejeitada' : 'Erro na consulta',
        provider_response: providerResponse,
      });
      return res.status(error.statusCode || 500).json({
        message: error.message || 'Falha ao consultar a nota fiscal.',
        document: row,
      });
    }
  }

  res.json({ document: docResult.rows[0] });
});

app.get('/api/backup/export', authRequired, async (_req, res) => {
  const tables = ['company_settings', 'users', 'clients', 'motorcycles', 'products', 'budgets', 'budget_items', 'service_orders', 'service_order_items', 'sales', 'sale_items', 'receipts', 'finance_entries', 'fiscal_documents'];
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

  const restoreOrder = ['company_settings', 'users', 'clients', 'motorcycles', 'products', 'budgets', 'budget_items', 'service_orders', 'service_order_items', 'sales', 'sale_items', 'receipts', 'finance_entries', 'fiscal_documents'];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE sale_items, sales, service_order_items, service_orders, budget_items, budgets, receipts, finance_entries, fiscal_documents, motorcycles, products, clients, users, company_settings RESTART IDENTITY CASCADE');
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
  res.status(error.statusCode || 500).json({ message: error.publicMessage || error.message || 'Erro interno no servidor.', detail: error.message });
});

bootstrap()
  .then(async () => {
    await ensureCertStorage();
    app.listen(port, () => {
      console.log(`JG MOTOS API rodando na porta ${port}`);
    });
  })
  .catch((error) => {
    console.error('Falha ao iniciar a API:', error);
    process.exit(1);
  });
