// Crew head-counts and the crew-cost estimate, for any trade.
//
// A daily report records its crew as a list of { type, count } using the
// company's own worker types (builder/helper for a contractor, technician/
// cable installer for an IT firm, ...), and each phase prices those types with
// its own daily rates: crewRates = { technician: 15000, helper: 6000 }.
// This replaces the old fixed builders/helpers columns and costPerBuilder /
// costPerHelper rates, which only made sense on a building site.

// Industry picked at sign-up -> the worker types the company starts with.
// Companies edit the list freely afterwards in Settings.
export const INDUSTRIES = {
  construction: { label: 'Construction', workerTypes: ['builder', 'helper'] },
  mep: { label: 'HVAC, electrical & plumbing', workerTypes: ['technician', 'electrician', 'plumber', 'helper'] },
  it: { label: 'IT & networking', workerTypes: ['technician', 'cable installer', 'helper'] },
  other: { label: 'Other field projects', workerTypes: ['worker', 'helper'] },
}

const key = (t) => String(t ?? '').trim().toLowerCase()

// The crew of a daily report, ignoring empty or malformed entries.
export const crewOf = (update) =>
  Array.isArray(update?.crew)
    ? update.crew.filter(c => c && key(c.type) && Number(c.count) > 0).map(c => ({ type: c.type, count: Number(c.count) }))
    : []

// A phase's daily rates, keyed by lower-cased worker type.
export function ratesOf(phase) {
  const r = phase?.crewRates
  if (!r || typeof r !== 'object' || Array.isArray(r)) return {}
  return Object.fromEntries(Object.entries(r).map(([t, v]) => [key(t), Number(v) || 0]))
}

// Estimated crew cost of one daily report under its phase's rates. Types the
// phase has no rate for cost nothing - the estimate never invents a price.
export function crewCost(update, phase) {
  const rates = ratesOf(phase)
  return crewOf(update).reduce((s, c) => s + c.count * (rates[key(c.type)] ?? 0), 0)
}

// "18 builders · 26 helpers"
export const crewSummary = (crew) =>
  crew.length ? crew.map(c => `${c.count} ${c.type}${c.count === 1 ? '' : 's'}`).join(' · ') : 'no crew recorded'

// Clean rates coming from a request: an object (or its JSON) of type -> whole,
// non-negative amount. Zero rates are dropped. Returns null when nothing is set.
export function cleanRates(raw) {
  let r = raw
  if (typeof r === 'string') { try { r = JSON.parse(r) } catch { return null } }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  const out = {}
  for (const [t, v] of Object.entries(r)) {
    const n = Math.max(0, Math.round(Number(v) || 0))
    if (key(t) && n > 0) out[key(t)] = n
  }
  return Object.keys(out).length ? out : null
}
