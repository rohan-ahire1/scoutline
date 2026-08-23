export function isValidDomain(value) {
  const s = String(value || '').trim().replace(/^https?:\/\//i, '').replace(/\/$/, '').toLowerCase()
  if (s.length < 3 || s.length > 253) return false
  if (s.includes(' ') || s.includes('@')) return false
  const re = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
  if (!re.test(s)) return false
  if (s.includes('..')) return false
  return true
}

export function isEmail(value) {
  const str = String(value || '').trim()
  if (str.length > 254) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str)
}

export function isPhone(value) {
  const str = String(value || '').trim()
  if (str === 'Not collected') return true
  if (str.length < 7 || str.length > 40) return false
  return /^[\d\s+()\-./]{7,40}$/.test(str)
}

export function normalizeDomainKey(value) {
  return String(value || '').trim().replace(/^https?:\/\//i, '').replace(/\/$/, '').toLowerCase()
}

export function validateRequired(value, field) {
  if (value == null) return { ok: false, errors: [{ field, message: `${field} is required` }] }
  if (typeof value === 'string' && !value.trim()) return { ok: false, errors: [{ field, message: `${field} is required` }] }
  if (Array.isArray(value) && value.length === 0) return { ok: false, errors: [{ field, message: `${field} is required` }] }
  return { ok: true, errors: [] }
}

export function validateUrl(value, field) {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, errors: [{ field, message: `${field} is required` }] }
  if (!isValidDomain(value)) return { ok: false, errors: [{ field, message: `${field} must be a valid domain (e.g. example.com)` }] }
  return { ok: true, errors: [] }
}

export function validateEnum(value, field, allowed) {
  const set = allowed instanceof Set ? allowed : new Set(allowed)
  if (!set.has(value)) return { ok: false, errors: [{ field, message: `${field} must be one of ${[...set].join(', ')}` }] }
  return { ok: true, errors: [] }
}

export function validateNumberRange(value, field, min, max, opts = {}) {
  const num = Number(value)
  const { integer = false } = opts
  if (!Number.isFinite(num)) return { ok: false, errors: [{ field, message: `${field} must be a number` }] }
  if (integer && !Number.isInteger(num)) return { ok: false, errors: [{ field, message: `${field} must be an integer` }] }
  if (num < min || num > max) return { ok: false, errors: [{ field, message: `${field} must be between ${min} and ${max}` }] }
  return { ok: true, errors: [] }
}

export function validateString(value, field, { min = 0, max = Infinity, allowEmpty = false } = {}) {
  if (typeof value !== 'string') return { ok: false, errors: [{ field, message: `${field} must be a string` }] }
  const len = value.trim().length
  if (!allowEmpty && len === 0) return { ok: false, errors: [{ field, message: `${field} must be a non-empty string` }] }
  if (len < min) return { ok: false, errors: [{ field, message: `${field} must be at least ${min} characters` }] }
  if (len > max) return { ok: false, errors: [{ field, message: `${field} must be at most ${max} characters` }] }
  return { ok: true, errors: [] }
}

export function validateBoolean(value, field) {
  if (typeof value !== 'boolean') return { ok: false, errors: [{ field, message: `${field} must be boolean` }] }
  return { ok: true, errors: [] }
}

export function validateArray(value, field, { min = 0, max = Infinity } = {}) {
  if (!Array.isArray(value)) return { ok: false, errors: [{ field, message: `${field} must be an array` }] }
  if (value.length < min) return { ok: false, errors: [{ field, message: `${field} must contain at least ${min} item(s)` }] }
  if (value.length > max) return { ok: false, errors: [{ field, message: `${field} must contain at most ${max} item(s)` }] }
  return { ok: true, errors: [] }
}

export function validateIdParam(param, field = 'id') {
  if (typeof param !== 'string' || !param.trim() || param.length > 120) return { ok: false, errors: [{ field, message: `${field} is required` }] }
  if (/\.\./.test(param) || param.includes('/')) return { ok: false, errors: [{ field, message: `${field} contains invalid characters` }] }
  return { ok: true, errors: [] }
}

export function combineValidations(...results) {
  const errors = results.flatMap((r) => (r && r.errors ? r.errors : []))
  return { ok: errors.length === 0, errors, details: errors.length ? Object.fromEntries(errors.map((e) => [e.field, e.message])) : undefined, detailsArray: errors }
}

export function toDetailsObject(detailsArray) {
  if (!detailsArray || !detailsArray.length) return undefined
  return Object.fromEntries(detailsArray.map((e) => [e.field, e.message]))
}

export function formatValidationError(detailsArray, message = 'Validation failed') {
  return { error: message, code: 'VALIDATION_ERROR', details: detailsArray }
}
