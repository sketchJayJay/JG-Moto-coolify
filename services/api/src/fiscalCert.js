const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const forge = require('node-forge');

const CERT_STORAGE_DIR = process.env.CERT_STORAGE_DIR || '/data/certs';
const CERT_SECRET = process.env.CERT_SECRET || process.env.JWT_SECRET || 'jg_motos_cert_secret_change_me';

function certKey() {
  return crypto.createHash('sha256').update(String(CERT_SECRET)).digest();
}

async function ensureCertStorage() {
  await fs.promises.mkdir(CERT_STORAGE_DIR, { recursive: true });
}

function normalizeBase64(input = '') {
  return String(input || '')
    .replace(/^data:[^;]+;base64,/, '')
    .replace(/\s+/g, '');
}

function formatDateOnly(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function attributeLabel(attribute = {}) {
  return attribute.shortName || attribute.name || attribute.type || 'attr';
}

function attributesToString(attributes = []) {
  return attributes
    .map((attribute) => `${attributeLabel(attribute)}=${attribute.value}`)
    .join(', ');
}

function selectLeafCertificate(certificates = []) {
  if (!certificates.length) return null;
  return certificates.find((cert) => {
    const subject = attributesToString(cert.subject?.attributes || []);
    const issuer = attributesToString(cert.issuer?.attributes || []);
    return subject && subject !== issuer;
  }) || certificates[0];
}

function parsePfxBuffer(buffer, password) {
  try {
    const der = forge.util.createBuffer(buffer.toString('binary'));
    const asn1 = forge.asn1.fromDer(der);
    const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, String(password || ''));

    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })?.[forge.pki.oids.certBag] || [];
    const keyBags = [
      ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })?.[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
      ...(p12.getBags({ bagType: forge.pki.oids.keyBag })?.[forge.pki.oids.keyBag] || []),
    ];

    const certificates = certBags.map((bag) => bag.cert).filter(Boolean);
    const certificate = selectLeafCertificate(certificates);

    if (!certificate) {
      throw new Error('Nenhum certificado foi encontrado no arquivo PFX/P12.');
    }

    if (!keyBags.length) {
      throw new Error('O certificado não possui chave privada para assinatura.');
    }

    const subject = attributesToString(certificate.subject?.attributes || []);
    const issuer = attributesToString(certificate.issuer?.attributes || []);
    const subjectMap = Object.fromEntries((certificate.subject?.attributes || []).map((attr) => [attributeLabel(attr), attr.value]));

    return {
      hasPrivateKey: true,
      serialNumber: certificate.serialNumber || '',
      subject,
      issuer,
      commonName: subjectMap.CN || subjectMap.commonName || '',
      document: subjectMap.serialNumber || '',
      validFrom: formatDateOnly(certificate.validity?.notBefore),
      validUntil: formatDateOnly(certificate.validity?.notAfter),
    };
  } catch (error) {
    throw new Error(`Falha ao ler o certificado: ${error.message}`);
  }
}

async function saveCertificateBuffer(filename, buffer) {
  await ensureCertStorage();
  const safeName = path.basename(String(filename || 'certificado.pfx')).replace(/[^a-zA-Z0-9._-]/g, '_');
  const storedName = `${Date.now()}-${safeName}`;
  const fullPath = path.join(CERT_STORAGE_DIR, storedName);
  await fs.promises.writeFile(fullPath, buffer);
  return { storedName, fullPath };
}

async function readStoredCertificate(filePath) {
  return fs.promises.readFile(filePath);
}

async function deleteStoredCertificate(filePath) {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function encryptSecret(value) {
  if (!value) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', certKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptSecret(payload) {
  if (!payload) return '';
  const [iv64, tag64, data64] = String(payload).split(':');
  if (!iv64 || !tag64 || !data64) throw new Error('Senha criptografada inválida.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', certKey(), Buffer.from(iv64, 'base64'));
  decipher.setAuthTag(Buffer.from(tag64, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(data64, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

module.exports = {
  CERT_STORAGE_DIR,
  ensureCertStorage,
  normalizeBase64,
  parsePfxBuffer,
  saveCertificateBuffer,
  readStoredCertificate,
  deleteStoredCertificate,
  encryptSecret,
  decryptSecret,
};
