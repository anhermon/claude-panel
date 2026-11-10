// Structural validation of the work-asset schemas generated from web/kit/assets/work-schema.js.
import { Invalid, isPlain } from './blocks/common'
export type VizSchema = {
  type: string; optional?: boolean; min?: number; max?: number; integer?: boolean; exclusiveMin?: boolean
  requiredOneOf?: string[]; values?: string[]; fields?: Record<string, VizSchema>; item?: VizSchema
}
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T/
const URL_PROTOCOLS = ['http:', 'https:']
export function validateVizData(value: unknown, schema: VizSchema, path: string): void {
  if (value === undefined && schema.optional) return
  const fail = (what: string): never => { throw new Invalid(`${path} must be ${what}`) }
  if (schema.type === 'object' || schema.type === 'map') {
    if (!isPlain(value)) fail('an object')
    const obj = value as Record<string, unknown>
    if (schema.type === 'map') {
      for (const [key, child] of Object.entries(obj)) validateVizData(child, schema.item!, `${path}.${key}`)
    } else {
      if (schema.requiredOneOf && !schema.requiredOneOf.some(key => obj[key] !== undefined)) throw new Invalid(`${path} needs ${schema.requiredOneOf.join(' or ')}`)
      const fields = schema.fields!
      for (const key of Object.keys(obj)) if (!Object.hasOwn(fields, key)) throw new Invalid(`${path}.${key} is not a known field (allowed: ${Object.keys(fields).join(', ')})`)
      for (const [key, child] of Object.entries(fields)) validateVizData(obj[key], child, `${path}.${key}`)
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) fail('an array')
    const items = value as unknown[]
    if (items.length < schema.min! || items.length > schema.max!) fail(`an array of ${schema.min} to ${schema.max} items`)
    items.forEach((v, i) => validateVizData(v, schema.item!, `${path}[${i}]`))
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail('a finite number')
    const num = value as number
    if (num < (schema.min ?? -Infinity) || num > (schema.max ?? Infinity)) fail(`a number from ${schema.min} to ${schema.max}`)
    if (schema.exclusiveMin && num <= schema.min!) fail(`a number above ${schema.min}`)
    if (schema.integer && !Number.isInteger(num)) fail('an integer')
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') fail('true or false')
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || !value.trim() || value.length > schema.max!) fail(`a non-empty string of at most ${schema.max} characters`)
  } else if (schema.type === 'enum') {
    if (typeof value !== 'string' || !schema.values!.includes(value)) fail(`one of ${schema.values!.join('|')}`)
  } else if (schema.type === 'url') {
    try { if (typeof value === 'string' && URL_PROTOCOLS.includes(new URL(value).protocol)) return } catch { /* field error below */ }
    fail('an http or https URL')
  } else if (schema.type === 'date') {
    if (typeof value === 'number' && Number.isFinite(value) && Number.isFinite(new Date(value).getTime())) return
    if (typeof value === 'string' && ISO_DATE_TIME.test(value) && Number.isFinite(Date.parse(value))) return
    fail('epoch milliseconds or an ISO date-time')
  }
}
