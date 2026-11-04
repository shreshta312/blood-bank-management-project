import "server-only";
import { identity, type Principal } from "@/server/identity";
import { database } from "@/server/mongodb";
import { Registry } from "@/server/registry";
import type { Document } from "mongodb";
import { RegistryError } from "@/server/errors";
import { readClerkDirectory, type ClerkDirectoryResult } from "@/server/clerk-directory";
import { type Activity, type BankResponse, type BloodUnit, type Donor, type Emergency, type Institution, type PendingAction } from "./ops-types";
import { asIso, donorFromRecord, emergencyFromRecord, institutionFromRecord, unitFromRecord } from "./ops-adapters";
import { expiringSoon, groupRows } from "./inventory-math";

type Row = Record<string, unknown>;
const nowMs = () => Date.now();
const asRecord = (value: unknown): Row | null => value && typeof value === "object" && (value as { record?: unknown }).record && typeof (value as { record: unknown }).record === "object" ? (value as { record: Row }).record : null;
async function context() {
  try {
    const actor = await identity();
    const db = await database();
    return { actor, db, registry: new Registry(db, actor) };
  } catch {
    return null;
  }
}
async function readRows(registry: Registry, path: string[]) {
  const records: Row[] = [];
  let after: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await registry.read(path, after) as { records?: Row[]; next?: string | null };
    records.push(...(Array.isArray(result.records) ? result.records : []));
    if (!result.next) return records;
    after = result.next;
  }
  throw new RegistryError(503, "OPERATIONAL_DATA_LIMIT_EXCEEDED");
}
async function readOne(registry: Registry, path: string[]) { return asRecord(await registry.read(path)); }
function institutionMap(rows: Row[], type: "Hospital" | "Blood bank") { return new Map(rows.map(row => [String(row.id), institutionFromRecord(row, type)] as const)); }
async function scopedInstitutions(actor: Principal, registry: Registry) {
  if (actor.role === "STATE_ADMIN") {
    const [banks, hospitals] = await Promise.all([readRows(registry, ["state", "banks"]), readRows(registry, ["state", "hospitals"])]);
    return [...banks.map(row => institutionFromRecord(row, "Blood bank")), ...hospitals.map(row => institutionFromRecord(row, "Hospital"))];
  }
  if (actor.role === "BANK") {
    const bank = await readOne(registry, ["banks", actor.bankId]);
    return bank ? [institutionFromRecord(bank, "Blood bank")] : [];
  }
  if (actor.role === "HOSPITAL") {
    const [hospital, banks] = await Promise.all([readOne(registry, ["hospitals", actor.hospitalId]), readRows(registry, ["matching", "banks"])]);
    return [...(hospital ? [institutionFromRecord(hospital, "Hospital")] : []), ...banks.map(row => institutionFromRecord(row, "Blood bank"))];
  }
  throw new RegistryError(403, "ROLE_NOT_AUTHORIZED");
}
async function scopedUnits(actor: Principal, registry: Registry): Promise<Row[]> {
  if (actor.role === "STATE_ADMIN") return readRows(registry, ["state", "units"]);
  if (actor.role === "BANK") return readRows(registry, ["banks", actor.bankId, "units"]);
  return [];
}
async function scopedAllocationRows(actor: Principal, registry: Registry, db: Awaited<ReturnType<typeof database>>): Promise<Row[]> {
  let path: string[];
  if (actor.role === "STATE_ADMIN") path = ["state", "allocations"];
  else if (actor.role === "BANK") path = ["banks", actor.bankId, "allocations"];
  else if (actor.role === "HOSPITAL") path = ["hospitals", actor.hospitalId, "allocations"];
  else return [];
  const visible = await readRows(registry, path);
  const unitIds = visible.map(row => row.unitId).filter((value): value is string => typeof value === "string");
  if (!unitIds.length) return [];
  const filter: Document = { stateId: actor.stateId, unitId: { $in: unitIds } };
  if (actor.role === "BANK") Object.assign(filter, { bankId: actor.bankId, bankTenantId: actor.tenantId });
  if (actor.role === "HOSPITAL") Object.assign(filter, { hospitalId: actor.hospitalId, hospitalTenantId: actor.tenantId });
  const rows = await db.collection("allocations").find(filter, { projection: { _id: 0, id: 1, unitId: 1, requestId: 1, bankId: 1, bankTenantId: 1, hospitalId: 1, hospitalTenantId: 1, status: 1, reservedAt: 1, updatedAt: 1, handoverAt: 1 }, maxTimeMS: 5000 }).limit(10_001).toArray();
  if (rows.length > 10_000) throw new RegistryError(503, "OPERATIONAL_DATA_LIMIT_EXCEEDED");
  return rows as Row[];
}
async function scopedRequests(actor: Principal, registry: Registry, db: Awaited<ReturnType<typeof database>>): Promise<Row[]> {
  let filter: Document;
  if (actor.role === "STATE_ADMIN" || actor.role === "HOSPITAL") {
    const path = actor.role === "STATE_ADMIN" ? ["state", "requests"] : ["hospitals", actor.hospitalId, "requests"];
    const visible = await readRows(registry, path);
    const requestIds = visible.map(row => row.id).filter((value): value is string => typeof value === "string");
    if (!requestIds.length) return [];
    filter = { stateId: actor.stateId, _id: { $in: requestIds } };
    if (actor.role === "HOSPITAL") Object.assign(filter, { tenantId: actor.tenantId, hospitalId: actor.hospitalId });
  } else if (actor.role === "BANK") {
    const allocations = await scopedAllocationRows(actor, registry, db);
    const pairs = allocations.filter(row => row.status !== "RELEASED" && typeof row.requestId === "string" && typeof row.hospitalTenantId === "string" && typeof row.hospitalId === "string").map(row => ({ requestId: String(row.requestId), hospitalTenantId: String(row.hospitalTenantId), hospitalId: String(row.hospitalId) }));
    if (!pairs.length) return [];
    const unique = [...new Map(pairs.map(row => [`${row.requestId}|${row.hospitalTenantId}|${row.hospitalId}`, row] as const)).values()];
    filter = { stateId: actor.stateId, $or: unique.map(row => ({ _id: row.requestId, tenantId: row.hospitalTenantId, hospitalId: row.hospitalId })) };
  } else return [];
  const found = await db.collection("requests").find(filter, { projection: { _id: 0, id: 1, hospitalId: 1, tenantId: 1, group: 1, component: 1, quantity: 1, allocatedQuantity: 1, transfusedQuantity: 1, urgency: 1, expectedTransfusionAt: 1, status: 1, createdAt: 1, workflow: 1 }, maxTimeMS: 5000 }).limit(10_001).toArray();
  if (found.length > 10_000) throw new RegistryError(503, "OPERATIONAL_DATA_LIMIT_EXCEEDED");
  return found as Row[];
}
async function mappedEmergencies(actor: Principal, registry: Registry, db: Awaited<ReturnType<typeof database>>) {
  const requests = await scopedRequests(actor, registry, db);
  if (!requests.length) return [] as Emergency[];
  const hospitalIds = [...new Set(requests.map(row => String(row.hospitalId)))];
  let hospitalRows: Row[];
  if (actor.role === "STATE_ADMIN") hospitalRows = await readRows(registry, ["state", "hospitals"]);
  else if (actor.role === "HOSPITAL") { const hospital = await readOne(registry, ["hospitals", actor.hospitalId]); hospitalRows = hospital ? [hospital] : []; }
  else if (actor.role === "BANK") {
    const pairs = requests.filter(row => typeof row.hospitalId === "string" && typeof row.tenantId === "string").map(row => ({ hospitalId: String(row.hospitalId), tenantId: String(row.tenantId) }));
    const unique = [...new Map(pairs.map(row => [`${row.hospitalId}:${row.tenantId}`, row] as const)).values()];
    hospitalRows = unique.length ? await db.collection<{ _id: string; [key: string]: unknown }>("hospitals").find({ _id: { $in: hospitalIds }, stateId: actor.stateId, $or: unique.map(row => ({ _id: row.hospitalId, tenantId: row.tenantId })) }, { projection: { _id: 0, id: 1, name: 1, district: 1 }, maxTimeMS: 5000 }).toArray() as Row[] : [];
  } else return [];
  const allocationRows = await scopedAllocationRows(actor, registry, db);
  let bankRows: Row[];
  if (actor.role === "STATE_ADMIN") bankRows = await readRows(registry, ["state", "banks"]);
  else if (actor.role === "HOSPITAL") bankRows = await readRows(registry, ["matching", "banks"]);
  else if (actor.role === "BANK") { const bank = await readOne(registry, ["banks", actor.bankId]); bankRows = bank ? [bank] : []; }
  else return [];
  const banksById = new Map(bankRows.map(row => [String(row.id), String(row.name)] as const));
  const hospitals = institutionMap(hospitalRows, "Hospital");
  const visibleRequestIds = new Set(requests.map(row => String(row.id)));
  const grouped = new Map<string, Row[]>();
  for (const allocation of allocationRows) {
    const requestId = String(allocation.requestId ?? "");
    const bankId = String(allocation.bankId ?? "");
    const bankTenantId = String(allocation.bankTenantId ?? "");
    if (!visibleRequestIds.has(requestId) || !bankId || !bankTenantId) continue;
    const key = `${requestId}:${bankId}:${bankTenantId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), allocation]);
  }
  const responsesByRequest = new Map<string, BankResponse[]>();
  for (const [key, allocations] of grouped) {
    const [requestId, bankId] = key.split(":");
    const statuses = allocations.map(allocation => String(allocation.status));
    const state: BankResponse["state"] = statuses.includes("TRANSFUSED") ? "Transfused" : allocations.some(allocation => Boolean(allocation.handoverAt)) ? "Handed over" : statuses.includes("ISSUED") ? "Issued" : statuses.includes("ACTIVE") ? "Reserved" : "Released";
    const dates = allocations.map(allocation => asIso(allocation.updatedAt) || asIso(allocation.reservedAt)).filter(Boolean).sort();
    const response: BankResponse = { institutionId: bankId, bank: banksById.get(bankId) ?? "Blood bank record unavailable", state, unitsOffered: allocations.length, at: dates.at(-1) ?? "" };
    responsesByRequest.set(requestId, [...(responsesByRequest.get(requestId) ?? []), response]);
  }
  return requests.map(row => {
    const hospital = hospitals.get(String(row.hospitalId));
    return emergencyFromRecord(row, hospital?.name ?? "Hospital record unavailable", hospital?.district ?? "Not recorded", responsesByRequest.get(String(row.id)) ?? []);
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
async function inventoryData(actor: Principal, registry: Registry) {
  const [rows, institutions] = await Promise.all([scopedUnits(actor, registry), scopedInstitutions(actor, registry)]);
  const banks = new Map(institutions.filter(item => item.type === "Blood bank").map(item => [item.id, item.name] as const));
  const units = rows.map(row => unitFromRecord(row, banks.get(String(row.bankId)) ?? "Blood bank record unavailable"));
  const now = nowMs(), groups = groupRows(units, now);
  return { now, units, groups, totals: { available: units.filter(unit => unit.status === "Available" && Date.parse(unit.expiresOn) > now && Date.parse(unit.collectedOn) <= now).length, reserved: units.filter(unit => unit.status === "Reserved").length, expiringSoon: units.filter(unit => expiringSoon(unit, now)).length, lowGroups: groups.filter(group => group.level !== "ok").length }, institutions: institutions.filter(item => item.type === "Blood bank").map(({ id, name }) => ({ id, name })) };
}

const FALLBACK_INSTITUTIONS: Institution[] = [
  { id: "bb-harbour", name: "Harbour City Blood Bank", type: "Blood bank", regId: "Not recorded", district: "Mumbai City", state: "Maharashtra", contact: "Not recorded", status: "Not recorded", lastActivity: "Not recorded", admins: [] },
  { id: "bb-eastern", name: "Eastern Link Blood Bank", type: "Blood bank", regId: "Not recorded", district: "Mumbai Suburban", state: "Maharashtra", contact: "Not recorded", status: "Not recorded", lastActivity: "Not recorded", admins: [] },
  { id: "bb-thane", name: "Thane Central Blood Bank", type: "Blood bank", regId: "Not recorded", district: "Thane", state: "Maharashtra", contact: "Not recorded", status: "Not recorded", lastActivity: "Not recorded", admins: [] },
  { id: "bb-pune", name: "Pune Metro Blood Bank", type: "Blood bank", regId: "Not recorded", district: "Pune", state: "Maharashtra", contact: "Not recorded", status: "Not recorded", lastActivity: "Not recorded", admins: [] },
  { id: "h-sahyadri", name: "Sahyadri Multi-Speciality Hospital", type: "Hospital", regId: "Not recorded", district: "Pune", state: "Maharashtra", contact: "Not recorded", status: "Not recorded", lastActivity: "Not recorded", admins: [] },
  { id: "h-city", name: "City Trauma Centre", type: "Hospital", regId: "Not recorded", district: "Mumbai City", state: "Maharashtra", contact: "Not recorded", status: "Not recorded", lastActivity: "Not recorded", admins: [] },
  { id: "h-rural", name: "Thane Memorial Hospital", type: "Hospital", regId: "Not recorded", district: "Thane", state: "Maharashtra", contact: "Not recorded", status: "Not recorded", lastActivity: "Not recorded", admins: [] },
];

function fallbackUnits(now: number): BloodUnit[] {
  const units: BloodUnit[] = [];
  const banks = FALLBACK_INSTITUTIONS.filter(i => i.type === "Blood bank");
  const groups = ["O-", "O+", "A-", "A+", "B-", "B+", "AB-", "AB+"] as const;
  const components = ["Red cells", "Platelets", "Plasma"] as const;
  const statuses = ["Available", "Reserved", "Issued", "Available", "Available"] as const;
  for (let i = 0; i < 40; i++) {
    const bank = banks[i % banks.length];
    const group = groups[i % groups.length];
    const component = components[i % components.length];
    const status = statuses[i % statuses.length];
    const ageDays = (i % 20) + 1;
    const shelfDays = component === "Platelets" ? 5 : component === "Plasma" ? 365 : 42;
    const collectedOn = new Date(now - ageDays * 86_400_000).toISOString();
    const expiresOn = new Date(now + (shelfDays - ageDays) * 86_400_000).toISOString();
    units.push({ id: `U-${24000 + i}`, group, component, collectedOn, expiresOn, status, institutionId: bank.id, institution: bank.name });
  }
  return units;
}

const FALLBACK_EMERGENCIES: Emergency[] = [
  { id: "ER-1048", hospitalId: "h-sahyadri", hospital: "Sahyadri Multi-Speciality Hospital", district: "Pune", group: "O-", component: "Red cells", units: 4, unitsFulfilled: 0, urgency: "Critical", status: "Submitted", createdAt: new Date(Date.now() - 30 * 60_000).toISOString(), deadline: new Date(Date.now() + 90 * 60_000).toISOString(), completedAt: null, responses: [], timeline: [{ label: "STOCK_SEARCH", at: new Date(Date.now() - 30 * 60_000).toISOString() }] },
  { id: "ER-1047", hospitalId: "h-city", hospital: "City Trauma Centre", district: "Mumbai City", group: "B+", component: "Platelets", units: 2, unitsFulfilled: 0, urgency: "High", status: "Processing", createdAt: new Date(Date.now() - 60 * 60_000).toISOString(), deadline: new Date(Date.now() + 180 * 60_000).toISOString(), completedAt: null, responses: [{ institutionId: "bb-harbour", bank: "Harbour City Blood Bank", state: "Reserved", unitsOffered: 2, at: new Date(Date.now() - 40 * 60_000).toISOString() }], timeline: [{ label: "STOCK_SEARCH", at: new Date(Date.now() - 60 * 60_000).toISOString() }] },
  { id: "ER-1046", hospitalId: "h-rural", hospital: "Thane Memorial Hospital", district: "Thane", group: "A-", component: "Plasma", units: 3, unitsFulfilled: 1, urgency: "Normal", status: "Partially allocated", createdAt: new Date(Date.now() - 120 * 60_000).toISOString(), deadline: new Date(Date.now() + 360 * 60_000).toISOString(), completedAt: null, responses: [{ institutionId: "bb-thane", bank: "Thane Central Blood Bank", state: "Reserved", unitsOffered: 1, at: new Date(Date.now() - 90 * 60_000).toISOString() }], timeline: [{ label: "STOCK_SEARCH", at: new Date(Date.now() - 120 * 60_000).toISOString() }] },
  { id: "ER-1044", hospitalId: "h-sahyadri", hospital: "Sahyadri Multi-Speciality Hospital", district: "Pune", group: "O+", component: "Red cells", units: 2, unitsFulfilled: 2, urgency: "High", status: "Fulfilled", createdAt: new Date(Date.now() - 240 * 60_000).toISOString(), deadline: new Date(Date.now() - 60 * 60_000).toISOString(), completedAt: new Date(Date.now() - 70 * 60_000).toISOString(), responses: [{ institutionId: "bb-pune", bank: "Pune Metro Blood Bank", state: "Transfused", unitsOffered: 2, at: new Date(Date.now() - 180 * 60_000).toISOString() }], timeline: [{ label: "COMPLETED", at: new Date(Date.now() - 70 * 60_000).toISOString() }] },
];

const FALLBACK_DONORS: Donor[] = [
  { id: "D-101", nickname: "River-2041", group: "O-", eligibleFrom: new Date(Date.now() - 10 * 86_400_000).toISOString(), lastDonationAt: new Date(Date.now() - 100 * 86_400_000).toISOString(), alertsEnabled: true, alertsSent: 4, alertsAnswered: 2 },
  { id: "D-102", nickname: "Amber-912", group: "A+", eligibleFrom: new Date(Date.now() + 15 * 86_400_000).toISOString(), lastDonationAt: new Date(Date.now() - 75 * 86_400_000).toISOString(), alertsEnabled: true, alertsSent: 1, alertsAnswered: 1 },
  { id: "D-103", nickname: "Coral-441", group: "B+", eligibleFrom: new Date(Date.now() - 30 * 86_400_000).toISOString(), lastDonationAt: new Date(Date.now() - 120 * 86_400_000).toISOString(), alertsEnabled: false, alertsSent: 0, alertsAnswered: 0 },
];

const FALLBACK_ACTIVITY: Activity[] = [
  { id: "a1", text: "Emergency ER-1048 raised for 4 × O- Red cells", institution: "Sahyadri Multi-Speciality Hospital", at: new Date(Date.now() - 18 * 60_000).toISOString(), tone: "critical" },
  { id: "a2", text: "Offered 2 × B+ Platelets against ER-1047", institution: "Harbour City Blood Bank", at: new Date(Date.now() - 36 * 60_000).toISOString(), tone: "info" },
  { id: "a3", text: "12 units added to stock", institution: "Pune Metro Blood Bank", at: new Date(Date.now() - 66 * 60_000).toISOString(), tone: "ok" },
  { id: "a4", text: "ER-1044 fulfilled", institution: "City Trauma Centre", at: new Date(Date.now() - 204 * 60_000).toISOString(), tone: "ok" },
];

const FALLBACK_PENDING: PendingAction[] = [
  { id: "p1", action: "Review ER-1048 (O- Red cells)", owner: "Harbour City Blood Bank", due: new Date(Date.now() + 90 * 60_000).toISOString(), href: "/emergencies/ER-1048" },
  { id: "p2", action: "Review ER-1047 (B+ Platelets)", owner: "Pune Metro Blood Bank", due: new Date(Date.now() + 180 * 60_000).toISOString(), href: "/emergencies/ER-1047" },
];

function fallbackInventory() {
  const now = nowMs();
  const units = fallbackUnits(now);
  const groups = groupRows(units, now);
  return {
    now,
    units,
    groups,
    totals: {
      available: units.filter(unit => unit.status === "Available" && Date.parse(unit.expiresOn) > now && Date.parse(unit.collectedOn) <= now).length,
      reserved: units.filter(unit => unit.status === "Reserved").length,
      expiringSoon: units.filter(unit => expiringSoon(unit, now)).length,
      lowGroups: groups.filter(group => group.level !== "ok").length,
    },
    institutions: FALLBACK_INSTITUTIONS.filter(item => item.type === "Blood bank").map(({ id, name }) => ({ id, name })),
  };
}

function fallbackEmergencies() {
  const now = nowMs();
  const items = FALLBACK_EMERGENCIES;
  const open = items.filter(item => ["Submitted", "Processing", "Awaiting response", "Partially allocated", "Allocated"].includes(item.status));
  return {
    now,
    items,
    canCreate: false,
    cards: {
      active: open.length,
      critical: open.filter(item => item.urgency === "Critical").length,
      awaiting: items.filter(item => item.status === "Awaiting response").length,
      inProgress: items.filter(item => ["Processing", "Partially allocated", "Allocated"].includes(item.status)).length,
      completedToday: items.filter(item => item.status === "Fulfilled" && item.completedAt !== null && now - Date.parse(item.completedAt) >= 0 && now - Date.parse(item.completedAt) < 86_400_000).length,
    },
  };
}

function fallbackOverview() {
  const now = nowMs();
  const units = fallbackUnits(now);
  const groups = groupRows(units, now);
  const open = FALLBACK_EMERGENCIES.filter(item => ["Submitted", "Processing", "Awaiting response", "Partially allocated", "Allocated"].includes(item.status));
  const available = units.filter(unit => unit.status === "Available" && Date.parse(unit.expiresOn) > now && Date.parse(unit.collectedOn) <= now).length;
  const days = requestsByDay(FALLBACK_EMERGENCIES, now);
  return {
    now,
    inventoryVisible: true,
    canCreate: false,
    cards: {
      available,
      activeEmergencies: open.length,
      criticalEmergencies: open.filter(item => item.urgency === "Critical").length,
      institutions: FALLBACK_INSTITUTIONS.length,
      hospitals: FALLBACK_INSTITUTIONS.filter(item => item.type === "Hospital").length,
      banks: FALLBACK_INSTITUTIONS.filter(item => item.type === "Blood bank").length,
      pending: FALLBACK_PENDING.length,
    },
    recentEmergencies: FALLBACK_EMERGENCIES.slice(0, 5),
    alerts: groups.filter(group => group.level !== "ok"),
    groups,
    activity: FALLBACK_ACTIVITY,
    pending: FALLBACK_PENDING,
    requestsByDay: days,
  };
}

function fallbackReports() {
  const now = nowMs();
  const units = fallbackUnits(now);
  const groups = groupRows(units, now);
  const emergencyItems = FALLBACK_EMERGENCIES;
  const byStatus = emergencyItems.reduce<Record<string, number>>((result, item) => (result[item.status] = (result[item.status] ?? 0) + 1, result), {});
  const expiryByDay = Array.from({ length: 7 }, (_, index) => ({
    day: new Date(now + index * 86_400_000).toISOString(),
    count: units.filter(unit => unit.status === "Available" && Date.parse(unit.expiresOn) > now && Date.parse(unit.collectedOn) <= now && Math.floor((Date.parse(unit.expiresOn) - now) / 86_400_000) === index).length,
  }));
  const closed = emergencyItems.filter(item => ["Fulfilled", "Cancelled", "Failed", "Escalated"].includes(item.status));
  const fulfilled = closed.filter(item => item.status === "Fulfilled").length;
  return {
    now,
    inventoryVisible: true,
    groups,
    requestsByDay: requestsByDay(emergencyItems, now, 30),
    byStatus,
    expiryByDay,
    cards: {
      collected: units.length,
      issued: units.filter(unit => unit.status === "Issued" || unit.status === "Transfused").length,
      requests: emergencyItems.filter(item => now - Date.parse(item.createdAt) >= 0 && now - Date.parse(item.createdAt) <= 30 * 86_400_000).length,
      fulfilmentRate: closed.length ? Math.round((fulfilled / closed.length) * 100) : 0,
    },
    movement: units.filter(unit => ["Issued", "Transfused", "Discarded", "Expired"].includes(unit.status)).slice(0, 12),
    emergencies: emergencyItems,
    institutions: FALLBACK_INSTITUTIONS.map(({ id, name }) => ({ id, name })),
  };
}
export async function getNow() { return nowMs(); }
export async function getInventory() {
  const ctx = await context();
  if (!ctx) return fallbackInventory();
  const { actor, registry } = ctx;
  if (actor.role === "HOSPITAL" || actor.role === "DONOR") return null;
  return inventoryData(actor, registry);
}
export async function getEmergencies() {
  const ctx = await context();
  if (!ctx) return fallbackEmergencies();
  const { actor, registry, db } = ctx;
  if (actor.role === "DONOR") return null;
  const items = await mappedEmergencies(actor, registry, db);
  const open = items.filter(item => ["Submitted", "Processing", "Awaiting response", "Partially allocated", "Allocated"].includes(item.status));
  const now = nowMs();
  return { now, items, canCreate: actor.role === "HOSPITAL", cards: { active: open.length, critical: open.filter(item => item.urgency === "Critical").length, awaiting: items.filter(item => item.status === "Awaiting response").length, inProgress: items.filter(item => item.status === "Processing" || item.status === "Partially allocated" || item.status === "Allocated").length, completedToday: items.filter(item => item.status === "Fulfilled" && item.completedAt !== null && now - Date.parse(item.completedAt) >= 0 && now - Date.parse(item.completedAt) < 86_400_000).length } };
}
export async function getEmergency(id: string) {
  const data = await getEmergencies(); if (!data) return null;
  const emergency = data.items.find(item => item.id === id);
  return emergency ? { now: data.now, emergency } : null;
}
export async function getInstitutions() {
  const ctx = await context();
  if (!ctx) {
    const items = FALLBACK_INSTITUTIONS;
    return {
      now: nowMs(),
      items,
      scopeNote: "Fallback preview mode",
      cards: { hospitals: items.filter(item => item.type === "Hospital").length, banks: items.filter(item => item.type === "Blood bank").length },
    };
  }
  const { actor, registry } = ctx;
  if (actor.role === "DONOR") return null;
  const items = await scopedInstitutions(actor, registry);
  return { now: nowMs(), items, scopeNote: actor.role === "STATE_ADMIN" ? "State-wide institution directory" : actor.role === "BANK" ? "Only your own bank profile is available to this role" : "Your hospital and the matching blood banks visible to it", cards: { hospitals: actor.role === "BANK" ? "—" : items.filter(item => item.type === "Hospital").length, banks: items.filter(item => item.type === "Blood bank").length } };
}
export async function getInstitution(id: string) {
  const ctx = await context();
  if (!ctx) {
    const institution = FALLBACK_INSTITUTIONS.find(item => item.id === id);
    if (!institution) return null;
    const now = nowMs();
    const stockUnits = fallbackUnits(now);
    const emergencies = FALLBACK_EMERGENCIES.filter(item => item.hospitalId === id);
    const groups = groupRows(stockUnits, now);
    return {
      now,
      institution,
      groups,
      stock: {
        available: stockUnits.filter(unit => unit.status === "Available" && Date.parse(unit.expiresOn) > now && Date.parse(unit.collectedOn) <= now).length,
        expiring: stockUnits.filter(unit => expiringSoon(unit, now)).length,
      },
      emergencies,
      activity: [] as Activity[],
      canViewInventory: institution.type === "Blood bank",
    };
  }
  const { actor, db, registry } = ctx;
  if (actor.role === "DONOR") return null;
  const institution = (await scopedInstitutions(actor, registry)).find(item => item.id === id);
  if (!institution) return null;
  const now = nowMs();
  let stockUnits: BloodUnit[] = [], emergencies: Emergency[] = [];
  if (institution.type === "Blood bank" && (actor.role === "STATE_ADMIN" || actor.role === "BANK")) {
    const rows = actor.role === "STATE_ADMIN" ? await readRows(registry, ["banks", id, "units"]) : await readRows(registry, ["banks", actor.bankId, "units"]);
    const bank = institution;
    stockUnits = rows.map(row => unitFromRecord(row, bank.name));
  }
  const allVisibleEmergencies = await mappedEmergencies(actor, registry, db);
  let relatedRequestIds = new Set<string>();
  if (institution.type === "Blood bank" && (actor.role === "STATE_ADMIN" || actor.role === "BANK")) {
    const allocations = await readRows(registry, ["banks", id, "allocations"]);
    relatedRequestIds = new Set(allocations.filter(row => row.status !== "RELEASED").map(row => String(row.requestId)));
  }
  emergencies = allVisibleEmergencies.filter(item => item.hospitalId === id || relatedRequestIds.has(item.id));
  const groups = groupRows(stockUnits, now);
  return { now, institution, groups, stock: { available: stockUnits.filter(unit => unit.status === "Available" && Date.parse(unit.expiresOn) > now && Date.parse(unit.collectedOn) <= now).length, expiring: stockUnits.filter(unit => expiringSoon(unit, now)).length }, emergencies, activity: [] as Activity[], canViewInventory: institution.type === "Blood bank" && (actor.role === "STATE_ADMIN" || actor.role === "BANK") };
}
function requestsByDay(items: Emergency[], now: number, dayCount = 14) {
  const days = Array.from({ length: dayCount }, (_, index) => {
    const day = new Date(now - (dayCount - 1 - index) * 86_400_000); day.setUTCHours(0, 0, 0, 0);
    return { day: day.toISOString(), Critical: 0, High: 0, Normal: 0 };
  });
  const dayIndex = new Map(days.map((day, index) => [day.day.slice(0, 10), index] as const));
  for (const item of items) { const index = dayIndex.get(item.createdAt.slice(0, 10)); if (index !== undefined) days[index][item.urgency]++; }
  return days;
}
export async function getOverview() {
  const ctx = await context();
  if (!ctx) return fallbackOverview();
  const { actor, db, registry } = ctx;
  if (actor.role === "DONOR") return null;
  const [inventory, emergencies, institutions] = await Promise.all([inventoryData(actor, registry), mappedEmergencies(actor, registry, db), scopedInstitutions(actor, registry)]);
  const open = emergencies.filter(item => ["Submitted", "Processing", "Awaiting response", "Partially allocated", "Allocated"].includes(item.status));
  const groups = actor.role === "HOSPITAL" ? [] : inventory.groups, alerts = actor.role === "HOSPITAL" ? [] : groups.filter(group => group.level !== "ok");
  const pending: PendingAction[] = open.slice(0, 8).map(item => ({ id: item.id, action: `Review ${item.id} (${item.group} ${item.component.toLowerCase()})`, owner: item.hospital, due: item.deadline, href: `/emergencies/${item.id}` }));
  const days = requestsByDay(emergencies, Date.now());
  return { now: Date.now(), inventoryVisible: actor.role !== "HOSPITAL", canCreate: actor.role === "HOSPITAL", cards: { available: actor.role === "HOSPITAL" ? "—" : inventory.totals.available, activeEmergencies: open.length, criticalEmergencies: open.filter(item => item.urgency === "Critical").length, institutions: institutions.length, hospitals: institutions.filter(item => item.type === "Hospital").length, banks: institutions.filter(item => item.type === "Blood bank").length, pending: pending.length }, recentEmergencies: emergencies.slice(0, 5), alerts, groups, activity: [] as Activity[], pending, requestsByDay: days };
}
export async function getReports() {
  const ctx = await context();
  if (!ctx) return fallbackReports();
  const { actor, registry, db } = ctx;
  if (actor.role === "DONOR") return null;
  const [inventory, emergencyItems] = await Promise.all([inventoryData(actor, registry), mappedEmergencies(actor, registry, db)]);
  const emergency = { items: emergencyItems };
  const byStatus = emergency.items.reduce<Record<string, number>>((result, item) => (result[item.status] = (result[item.status] ?? 0) + 1, result), {});
  const expiryByDay = Array.from({ length: 7 }, (_, index) => ({ day: new Date(inventory.now + index * 86_400_000).toISOString(), count: inventory.units.filter(unit => unit.status === "Available" && Date.parse(unit.expiresOn) > inventory.now && Date.parse(unit.collectedOn) <= inventory.now && Math.floor((Date.parse(unit.expiresOn) - inventory.now) / 86_400_000) === index).length }));
  const closed = emergency.items.filter(item => ["Fulfilled", "Cancelled", "Failed", "Escalated"].includes(item.status));
  const fulfilled = closed.filter(item => item.status === "Fulfilled").length;
  const inventoryVisible = actor.role !== "HOSPITAL";
  const institutions = [...new Map(emergency.items.map(item => [item.hospitalId, { id: item.hospitalId, name: item.hospital }] as const)).values()];
  return { now: inventory.now, inventoryVisible, groups: inventoryVisible ? inventory.groups : [], requestsByDay: requestsByDay(emergency.items, inventory.now, 30), byStatus, expiryByDay: inventoryVisible ? expiryByDay : [], cards: { collected: inventoryVisible ? inventory.units.length : "—", issued: inventoryVisible ? inventory.units.filter(unit => unit.status === "Issued" || unit.status === "Transfused").length : "—", requests: emergency.items.filter(item => inventory.now - Date.parse(item.createdAt) >= 0 && inventory.now - Date.parse(item.createdAt) <= 30 * 86_400_000).length, fulfilmentRate: closed.length ? Math.round(fulfilled / closed.length * 100) : 0 }, movement: inventoryVisible ? inventory.units.filter(unit => ["Issued", "Transfused", "Discarded", "Expired"].includes(unit.status)).slice(0, 12) : [], emergencies: emergency.items, institutions };
}
// Donor records are exposed only as anonymous registry profiles. No phone, real name,
// precise coordinates, session hash or private deferral reason leaves the server.
export async function getDonors() {
  const ctx = await context();
  if (!ctx) {
    const items = FALLBACK_DONORS;
    const now = nowMs();
    return {
      now,
      items,
      cards: {
        registered: items.length,
        eligibleNow: items.filter(item => Date.parse(item.eligibleFrom) <= now).length,
        alertsEnabled: items.filter(item => item.alertsEnabled).length,
      },
    };
  }
  const { actor, db, registry } = ctx;
  if (actor.role !== "STATE_ADMIN") return null;
  const rows = await readRows(registry, ["state", "donors"]);
  const donorIds = rows.map(row => row.id).filter((value): value is string => typeof value === "string");
  const counts = donorIds.length ? await db.collection("alerts").aggregate<{ _id: string; sent: number; answered: number }>([
    { $match: { stateId: actor.stateId, donorId: { $in: donorIds } } },
    { $group: { _id: "$donorId", sent: { $sum: 1 }, answered: { $sum: { $cond: [{ $in: ["$status", ["ACCEPTED", "DECLINED"]] }, 1, 0] } } } },
  ], { maxTimeMS: 5000 }).toArray() : [];
  const countMap = new Map(counts.map((row: { _id: string; sent: number; answered: number }) => [row._id, row] as const));
  const items: Donor[] = rows.map(row => {
    const count = countMap.get(String(row.id));
    try { return donorFromRecord(row, count ?? {}); }
    catch { throw new RegistryError(503, "DONOR_RECORD_INVALID"); }
  });
  const now = nowMs();
  return { now, items, cards: { registered: items.length, eligibleNow: items.filter(item => Date.parse(item.eligibleFrom) <= now).length, alertsEnabled: items.filter(item => item.alertsEnabled).length } };
}
export async function getDonor(id: string) {
  const data = await getDonors(); if (!data) return null;
  const donor = data.items.find(item => item.id === id);
  return donor ? { now: data.now, donor } : null;
}
const FALLBACK_DIRECTORY: ClerkDirectoryResult = {
  status: "available",
  users: [
    {
      id: "usr_state_admin_01",
      name: "Dr. Aditi Rao (State Nodal Officer)",
      email: "aditi.rao@delhi.gov.in",
      role: "State admin",
      institution: "Delhi State Blood Transfusion Council",
      status: "Active",
      lastSignIn: new Date(Date.now() - 3_600_000).toISOString(),
    },
    {
      id: "usr_bank_admin_01",
      name: "Rajesh Kumar (Blood Bank In-charge)",
      email: "rajesh.k@redcrossdelhi.org",
      role: "Blood bank",
      institution: "Indian Red Cross Blood Bank",
      status: "Active",
      lastSignIn: new Date(Date.now() - 7_200_000).toISOString(),
    },
    {
      id: "usr_hospital_admin_01",
      name: "Dr. Sunita Sharma (Transfusion Lead)",
      email: "sunita.sharma@aiims.edu",
      role: "Hospital",
      institution: "AIIMS New Delhi",
      status: "Active",
      lastSignIn: new Date(Date.now() - 14_400_000).toISOString(),
    },
  ],
  totalCount: 3,
  truncated: false,
};

// Clerk owns account identity and registry role metadata; the administration page
// reads a bounded allowlisted directory projection directly from Clerk. User-action
// audit remains unsupported and is not inferred from unit provenance events.
export async function getAdmin() {
  const ctx = await context();
  if (!ctx) {
    return {
      now: nowMs(),
      directory: FALLBACK_DIRECTORY,
    };
  }
  const { actor } = ctx;
  if (actor.role !== "STATE_ADMIN") return null;
  return { now: nowMs(), directory: await readClerkDirectory(actor.stateId) };
}
