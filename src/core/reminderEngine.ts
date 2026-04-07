import { readDb, writeDb } from "../storage/db";
import { shortId } from "../utils/ids";

export type ReminderCourseStatus = "active" | "paused" | "completed" | "cancelled";
export type ReminderOccurrenceStatus = "scheduled" | "sent" | "taken" | "skipped" | "snoozed" | "missed";

type LegacyReminder = {
  userId: number;
  cardId: string;
  runAt: number;
  sent: boolean;
};

export type ReminderUser = {
  id: number;
  firstName?: string;
  username?: string;
  timezone: string;
  language: string;
  safetyAck: {
    remindersLegalAccepted: boolean;
    acceptedAt: string | null;
  };
  settings: {
    notificationsEnabled: boolean;
    quietHours: {
      enabled: boolean;
      start: string;
      end: string;
    };
  };
};

export type ReminderDraft = {
  userId: number;
  step: string;
  mode: "quick" | "advanced";
  data: {
    drugName?: string;
    normalizedName?: string;
    dosageText?: string | null;
    time?: string;
    frequency?: string;
    durationDays?: number | null;
    isOpenEnded?: boolean;
    notes?: string | null;
    profileLabel?: string | null;
  };
  updatedAt: string;
};

export type ReminderCourse = {
  id: string;
  userId: number;
  status: ReminderCourseStatus;
  drug: {
    rawName: string;
    normalizedName: string;
    catalogId: string | null;
  };
  dosageText: string | null;
  source: {
    createdByUser: true;
    basedOnDoctorInstruction: boolean;
  };
  schedule: {
    type: "times_per_day" | "every_x_hours";
    times: string[];
    intervalHours: number | null;
    timesPerDay: number | null;
  };
  course: {
    startDate: string;
    endDate: string | null;
    durationDays: number | null;
    isOpenEnded: boolean;
  };
  notes: string;
  flags: {
    childProfile: boolean;
    hasInteractionWarning: boolean;
    duplicateWarningShown: boolean;
  };
  generatedUntilDate: string;
  createdAt: string;
  updatedAt: string;
};

export type ReminderOccurrence = {
  id: string;
  courseId: string;
  userId: number;
  scheduledAt: string;
  localTime: string;
  status: ReminderOccurrenceStatus;
  actionTakenAt: string | null;
  snoozedUntil: string | null;
  meta: {
    dayNumber: number;
    totalDays: number | null;
  };
};

export type ReminderHistoryEvent = {
  id: string;
  userId: number;
  courseId: string;
  occurrenceId: string;
  eventType: "taken" | "skipped" | "snoozed" | "sent" | "mark_now";
  createdAt: string;
};

export type CreateReminderCourseInput = {
  userId: number;
  drugName: string;
  dosageText?: string | null;
  mode: "quick" | "advanced";
  time: string;
  frequency: "daily_1" | "daily_2" | "daily_3" | "hours_8" | "hours_12" | `daily_custom_${number}`;
  durationDays?: number | null;
  isOpenEnded?: boolean;
  notes?: string;
  profileLabel?: string | null;
  childProfile?: boolean;
  hasInteractionWarning?: boolean;
  basedOnDoctorInstruction?: boolean;
  forceDuplicate?: boolean;
};

export type CreateReminderCourseResult =
  | { ok: true; course: ReminderCourse }
  | { ok: false; code: "limit_reached" | "invalid_frequency" | "invalid_duration" | "duplicate"; duplicateCourseId?: string };

const MAX_ACTIVE_COURSES = 5;
const MAX_REMINDERS_PER_DAY = 6;
const MAX_SNOOZE_MINUTES = 120;
const DEFAULT_TIMEZONE = "Asia/Tashkent";

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeDrugName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function formatDateYYYYMMDD(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseDateYYYYMMDD(value: string): Date {
  const [y, m, d] = value.split("-").map((part) => Number.parseInt(part, 10));
  return new Date(y, (m || 1) - 1, d || 1, 0, 0, 0, 0);
}

function addDays(base: Date, days: number): Date {
  const next = new Date(base.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function parseHHMM(value: string): { hours: number; minutes: number } | null {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }
  return { hours, minutes };
}

function normalizeHHMM(value: string): string | null {
  const parsed = parseHHMM(value);
  if (!parsed) {
    return null;
  }
  return `${`${parsed.hours}`.padStart(2, "0")}:${`${parsed.minutes}`.padStart(2, "0")}`;
}

function withTime(date: Date, hhmm: string): Date {
  const parsed = parseHHMM(hhmm);
  if (!parsed) {
    return date;
  }
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), parsed.hours, parsed.minutes, 0, 0);
}

function ensureReminderArrays(db: any): void {
  if (!Array.isArray(db.reminders)) db.reminders = [];
  if (!Array.isArray(db.reminderUsers)) db.reminderUsers = [];
  if (!Array.isArray(db.reminderCourses)) db.reminderCourses = [];
  if (!Array.isArray(db.reminderOccurrences)) db.reminderOccurrences = [];
  if (!Array.isArray(db.reminderHistory)) db.reminderHistory = [];
  if (!Array.isArray(db.reminderDrafts)) db.reminderDrafts = [];
}

function getTimesFromFrequency(firstTime: string, frequency: CreateReminderCourseInput["frequency"]): {
  type: "times_per_day" | "every_x_hours";
  times: string[];
  intervalHours: number | null;
  timesPerDay: number | null;
} | null {
  const normalizedFirst = normalizeHHMM(firstTime);
  if (!normalizedFirst) {
    return null;
  }

  const parsedFirst = parseHHMM(normalizedFirst)!;
  const toHHMM = (hoursDelta: number) => {
    const total = (parsedFirst.hours * 60 + parsedFirst.minutes + hoursDelta * 60) % (24 * 60);
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `${`${h}`.padStart(2, "0")}:${`${m}`.padStart(2, "0")}`;
  };

  if (frequency === "daily_1") {
    return { type: "times_per_day", times: [normalizedFirst], intervalHours: null, timesPerDay: 1 };
  }
  if (frequency === "daily_2") {
    return { type: "times_per_day", times: [normalizedFirst, toHHMM(12)], intervalHours: null, timesPerDay: 2 };
  }
  if (frequency === "daily_3") {
    return { type: "times_per_day", times: [normalizedFirst, toHHMM(8), toHHMM(16)], intervalHours: null, timesPerDay: 3 };
  }
  if (frequency === "hours_8") {
    return { type: "every_x_hours", times: [normalizedFirst], intervalHours: 8, timesPerDay: 3 };
  }
  if (frequency === "hours_12") {
    return { type: "every_x_hours", times: [normalizedFirst], intervalHours: 12, timesPerDay: 2 };
  }
  if (frequency.startsWith("daily_custom_")) {
    const count = Number.parseInt(frequency.replace("daily_custom_", ""), 10);
    if (!Number.isInteger(count) || count < 1 || count > MAX_REMINDERS_PER_DAY) {
      return null;
    }
    if (count === 1) {
      return { type: "times_per_day", times: [normalizedFirst], intervalHours: null, timesPerDay: 1 };
    }
    const stepMinutes = Math.floor((24 * 60) / count);
    const times: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const total = (parsedFirst.hours * 60 + parsedFirst.minutes + i * stepMinutes) % (24 * 60);
      const h = Math.floor(total / 60);
      const m = total % 60;
      times.push(`${`${h}`.padStart(2, "0")}:${`${m}`.padStart(2, "0")}`);
    }
    return { type: "times_per_day", times, intervalHours: null, timesPerDay: count };
  }

  return null;
}

function upsertReminderUserInternal(db: any, params: {
  userId: number;
  firstName?: string;
  username?: string;
  timezone?: string;
  language?: string;
}): ReminderUser {
  ensureReminderArrays(db);
  const idx = db.reminderUsers.findIndex((item: ReminderUser) => item.id === params.userId);
  const current = idx >= 0 ? db.reminderUsers[idx] as ReminderUser : null;
  const next: ReminderUser = {
    id: params.userId,
    firstName: params.firstName || current?.firstName,
    username: params.username || current?.username,
    timezone: params.timezone || current?.timezone || DEFAULT_TIMEZONE,
    language: params.language || current?.language || "ru",
    safetyAck: {
      remindersLegalAccepted: current?.safetyAck?.remindersLegalAccepted || false,
      acceptedAt: current?.safetyAck?.acceptedAt || null
    },
    settings: {
      notificationsEnabled: current?.settings?.notificationsEnabled ?? true,
      quietHours: {
        enabled: current?.settings?.quietHours?.enabled ?? false,
        start: current?.settings?.quietHours?.start || "23:00",
        end: current?.settings?.quietHours?.end || "07:00"
      }
    }
  };

  if (idx >= 0) {
    db.reminderUsers[idx] = next;
  } else {
    db.reminderUsers.push(next);
  }

  return next;
}

function getActiveCoursesInternal(db: any, userId: number): ReminderCourse[] {
  ensureReminderArrays(db);
  return db.reminderCourses.filter((course: ReminderCourse) => course.userId === userId && course.status === "active");
}

function getCourseByIdInternal(db: any, userId: number, courseId: string): ReminderCourse | null {
  ensureReminderArrays(db);
  return db.reminderCourses.find((course: ReminderCourse) => course.id === courseId && course.userId === userId) || null;
}

function generateOccurrencesForCourse(db: any, course: ReminderCourse, untilDate: string): number {
  ensureReminderArrays(db);
  const existingKey = new Set<string>(
    db.reminderOccurrences
      .filter((occ: ReminderOccurrence) => occ.courseId === course.id)
      .map((occ: ReminderOccurrence) => `${occ.courseId}:${occ.scheduledAt}`)
  );

  const start = parseDateYYYYMMDD(course.course.startDate);
  const generationStart = parseDateYYYYMMDD(course.generatedUntilDate || course.course.startDate);
  const until = parseDateYYYYMMDD(untilDate);
  const endHard = course.course.isOpenEnded
    ? until
    : parseDateYYYYMMDD(course.course.endDate || untilDate);

  const rangeStart = generationStart < start ? start : generationStart;
  const rangeEnd = endHard < until ? endHard : until;
  if (rangeEnd < rangeStart) {
    return 0;
  }

  const scheduleTimes: string[] = [];
  if (course.schedule.type === "times_per_day") {
    scheduleTimes.push(...course.schedule.times);
  } else {
    const first = course.schedule.times[0] || "08:00";
    const parsedFirst = parseHHMM(first) || { hours: 8, minutes: 0 };
    const interval = course.schedule.intervalHours || 8;
    let minutes = parsedFirst.hours * 60 + parsedFirst.minutes;
    while (minutes < 24 * 60) {
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      scheduleTimes.push(`${`${h}`.padStart(2, "0")}:${`${m}`.padStart(2, "0")}`);
      minutes += interval * 60;
    }
  }

  let created = 0;
  for (let cursor = new Date(rangeStart.getTime()); cursor <= rangeEnd; cursor = addDays(cursor, 1)) {
    const dayNumber = Math.floor((cursor.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    const totalDays = course.course.isOpenEnded ? null : course.course.durationDays;
    for (const hhmm of scheduleTimes) {
      const scheduled = withTime(cursor, hhmm);
      const scheduledIso = scheduled.toISOString();
      const key = `${course.id}:${scheduledIso}`;
      if (existingKey.has(key)) {
        continue;
      }
      db.reminderOccurrences.push({
        id: `occ_${shortId()}`,
        courseId: course.id,
        userId: course.userId,
        scheduledAt: scheduledIso,
        localTime: hhmm,
        status: "scheduled",
        actionTakenAt: null,
        snoozedUntil: null,
        meta: {
          dayNumber,
          totalDays
        }
      } satisfies ReminderOccurrence);
      existingKey.add(key);
      created += 1;
    }
  }

  course.generatedUntilDate = formatDateYYYYMMDD(addDays(rangeEnd, 1));
  course.updatedAt = nowIso();
  return created;
}

function pushHistory(db: any, payload: Omit<ReminderHistoryEvent, "id" | "createdAt"> & { eventType: ReminderHistoryEvent["eventType"] }): void {
  ensureReminderArrays(db);
  db.reminderHistory.push({
    id: `event_${shortId()}`,
    userId: payload.userId,
    courseId: payload.courseId,
    occurrenceId: payload.occurrenceId,
    eventType: payload.eventType,
    createdAt: nowIso()
  } satisfies ReminderHistoryEvent);
}

export function upsertReminderUser(params: {
  userId: number;
  firstName?: string;
  username?: string;
  timezone?: string;
  language?: string;
}): ReminderUser {
  const db = readDb();
  const user = upsertReminderUserInternal(db, params);
  writeDb(db);
  return user;
}

export function hasReminderLegalAck(userId: number): boolean {
  const db = readDb();
  ensureReminderArrays(db);
  const user = db.reminderUsers.find((item: ReminderUser) => item.id === userId) as ReminderUser | undefined;
  return Boolean(user?.safetyAck?.remindersLegalAccepted);
}

export function acceptReminderLegalAck(userId: number): void {
  const db = readDb();
  const user = upsertReminderUserInternal(db, { userId });
  user.safetyAck.remindersLegalAccepted = true;
  user.safetyAck.acceptedAt = nowIso();
  writeDb(db);
}

export function saveReminderDraft(draft: ReminderDraft): void {
  const db = readDb();
  ensureReminderArrays(db);
  const nextDraft = {
    ...draft,
    updatedAt: nowIso()
  } satisfies ReminderDraft;
  const idx = db.reminderDrafts.findIndex((item: ReminderDraft) => item.userId === draft.userId);
  if (idx >= 0) {
    db.reminderDrafts[idx] = nextDraft;
  } else {
    db.reminderDrafts.push(nextDraft);
  }
  writeDb(db);
}

export function getReminderDraft(userId: number): ReminderDraft | null {
  const db = readDb();
  ensureReminderArrays(db);
  return db.reminderDrafts.find((item: ReminderDraft) => item.userId === userId) || null;
}

export function getReminderUser(userId: number): ReminderUser | null {
  const db = readDb();
  ensureReminderArrays(db);
  return db.reminderUsers.find((item: ReminderUser) => item.id === userId) || null;
}

export function setReminderNotificationsEnabled(userId: number, enabled: boolean): ReminderUser {
  const db = readDb();
  const user = upsertReminderUserInternal(db, { userId });
  user.settings.notificationsEnabled = enabled;
  writeDb(db);
  return user;
}

export function setReminderQuietHours(userId: number, config: { enabled: boolean; start?: string; end?: string }): ReminderUser {
  const db = readDb();
  const user = upsertReminderUserInternal(db, { userId });
  user.settings.quietHours.enabled = Boolean(config.enabled);
  if (typeof config.start === "string" && normalizeHHMM(config.start)) {
    user.settings.quietHours.start = normalizeHHMM(config.start)!;
  }
  if (typeof config.end === "string" && normalizeHHMM(config.end)) {
    user.settings.quietHours.end = normalizeHHMM(config.end)!;
  }
  writeDb(db);
  return user;
}

function isWithinQuietHours(now: Date, quiet: { start: string; end: string }): boolean {
  const start = parseHHMM(quiet.start);
  const end = parseHHMM(quiet.end);
  if (!start || !end) {
    return false;
  }
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = start.hours * 60 + start.minutes;
  const endMinutes = end.hours * 60 + end.minutes;
  if (startMinutes === endMinutes) {
    return false;
  }
  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

export function shouldSendReminderNow(userId: number, nowTs: number): boolean {
  const db = readDb();
  ensureReminderArrays(db);
  const user = db.reminderUsers.find((item: ReminderUser) => item.id === userId) as ReminderUser | undefined;
  if (!user) {
    return true;
  }
  if (!user.settings.notificationsEnabled) {
    return false;
  }
  if (!user.settings.quietHours.enabled) {
    return true;
  }
  return !isWithinQuietHours(new Date(nowTs), user.settings.quietHours);
}

export function clearReminderDraft(userId: number): void {
  const db = readDb();
  ensureReminderArrays(db);
  db.reminderDrafts = db.reminderDrafts.filter((item: ReminderDraft) => item.userId !== userId);
  writeDb(db);
}

export function listReminderCourses(userId: number, statuses?: ReminderCourseStatus[]): ReminderCourse[] {
  const db = readDb();
  ensureReminderArrays(db);
  return db.reminderCourses
    .filter((course: ReminderCourse) => course.userId === userId && (!statuses || statuses.includes(course.status)))
    .sort((a: ReminderCourse, b: ReminderCourse) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getReminderCourse(userId: number, courseId: string): ReminderCourse | null {
  const db = readDb();
  return getCourseByIdInternal(db, userId, courseId);
}

export function createReminderCourse(input: CreateReminderCourseInput): CreateReminderCourseResult {
  const db = readDb();
  ensureReminderArrays(db);
  upsertReminderUserInternal(db, { userId: input.userId });

  const activeCourses = getActiveCoursesInternal(db, input.userId);
  if (activeCourses.length >= MAX_ACTIVE_COURSES) {
    return { ok: false, code: "limit_reached" };
  }

  const normalizedDrug = normalizeDrugName(input.drugName);
  const duplicate = activeCourses.find((course) => course.drug.normalizedName === normalizedDrug);
  if (duplicate && !input.forceDuplicate) {
    return { ok: false, code: "duplicate", duplicateCourseId: duplicate.id };
  }

  const schedule = getTimesFromFrequency(input.time, input.frequency);
  if (!schedule) {
    return { ok: false, code: "invalid_frequency" };
  }

  const remindersPerDay = schedule.timesPerDay || (schedule.intervalHours ? Math.floor(24 / schedule.intervalHours) : 0);
  if (remindersPerDay > MAX_REMINDERS_PER_DAY) {
    return { ok: false, code: "invalid_frequency" };
  }

  const isOpenEnded = Boolean(input.isOpenEnded);
  const durationDays = isOpenEnded ? null : input.durationDays ?? 5;
  if (!isOpenEnded && (!durationDays || durationDays < 1 || durationDays > 365)) {
    return { ok: false, code: "invalid_duration" };
  }

  const startDate = formatDateYYYYMMDD(new Date());
  const endDate = isOpenEnded || !durationDays ? null : formatDateYYYYMMDD(addDays(parseDateYYYYMMDD(startDate), durationDays - 1));
  const now = nowIso();

  const course: ReminderCourse = {
    id: `course_${shortId()}`,
    userId: input.userId,
    status: "active",
    drug: {
      rawName: input.drugName.trim(),
      normalizedName: normalizedDrug,
      catalogId: null
    },
    dosageText: input.dosageText?.trim() || null,
    source: {
      createdByUser: true,
      basedOnDoctorInstruction: Boolean(input.basedOnDoctorInstruction)
    },
    schedule,
    course: {
      startDate,
      endDate,
      durationDays,
      isOpenEnded
    },
    notes: [input.profileLabel?.trim(), input.notes?.trim()].filter(Boolean).join(" • "),
    flags: {
      childProfile: Boolean(input.childProfile),
      hasInteractionWarning: Boolean(input.hasInteractionWarning),
      duplicateWarningShown: Boolean(duplicate)
    },
    generatedUntilDate: startDate,
    createdAt: now,
    updatedAt: now
  };

  db.reminderCourses.push(course);

  const seedUntil = isOpenEnded ? formatDateYYYYMMDD(addDays(parseDateYYYYMMDD(startDate), 13)) : (endDate || startDate);
  generateOccurrencesForCourse(db, course, seedUntil);

  writeDb(db);
  return { ok: true, course };
}

export function setReminderCourseStatus(userId: number, courseId: string, status: ReminderCourseStatus): boolean {
  const db = readDb();
  const course = getCourseByIdInternal(db, userId, courseId);
  if (!course) {
    return false;
  }
  course.status = status;
  course.updatedAt = nowIso();
  writeDb(db);
  return true;
}

export function deleteReminderCourse(userId: number, courseId: string): boolean {
  const db = readDb();
  ensureReminderArrays(db);
  const before = db.reminderCourses.length;
  db.reminderCourses = db.reminderCourses.filter((course: ReminderCourse) => !(course.userId === userId && course.id === courseId));
  db.reminderOccurrences = db.reminderOccurrences.filter((occ: ReminderOccurrence) => !(occ.userId === userId && occ.courseId === courseId));
  if (db.reminderCourses.length === before) {
    return false;
  }
  writeDb(db);
  return true;
}

export function listTodayOccurrences(userId: number): ReminderOccurrence[] {
  const db = readDb();
  ensureReminderArrays(db);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 1);

  return db.reminderOccurrences
    .filter((occ: ReminderOccurrence) => {
      if (occ.userId !== userId) return false;
      const ts = new Date(occ.scheduledAt).getTime();
      return ts >= start.getTime() && ts < end.getTime();
    })
    .sort((a: ReminderOccurrence, b: ReminderOccurrence) => (a.scheduledAt < b.scheduledAt ? -1 : 1));
}

export function listCourseOccurrences(userId: number, courseId: string, limit = 20): ReminderOccurrence[] {
  const db = readDb();
  ensureReminderArrays(db);
  return db.reminderOccurrences
    .filter((occ: ReminderOccurrence) => occ.userId === userId && occ.courseId === courseId)
    .sort((a: ReminderOccurrence, b: ReminderOccurrence) => (a.scheduledAt < b.scheduledAt ? -1 : 1))
    .slice(-Math.max(limit, 1));
}

export function markOccurrenceSent(userId: number, courseId: string, occurrenceId: string): boolean {
  const db = readDb();
  ensureReminderArrays(db);
  const occurrence = db.reminderOccurrences.find(
    (item: ReminderOccurrence) => item.id === occurrenceId && item.userId === userId && item.courseId === courseId
  ) as ReminderOccurrence | undefined;
  if (!occurrence) {
    return false;
  }
  if (occurrence.status === "scheduled" || occurrence.status === "snoozed") {
    occurrence.status = "sent";
    occurrence.snoozedUntil = null;
    pushHistory(db, { userId, courseId, occurrenceId, eventType: "sent" });
    writeDb(db);
  }
  return true;
}

export function markOccurrenceTaken(userId: number, courseId: string, occurrenceId: string): boolean {
  const db = readDb();
  ensureReminderArrays(db);
  const occurrence = db.reminderOccurrences.find(
    (item: ReminderOccurrence) => item.id === occurrenceId && item.userId === userId && item.courseId === courseId
  ) as ReminderOccurrence | undefined;
  if (!occurrence) {
    return false;
  }
  occurrence.status = "taken";
  occurrence.actionTakenAt = nowIso();
  occurrence.snoozedUntil = null;
  pushHistory(db, { userId, courseId, occurrenceId, eventType: "taken" });
  writeDb(db);
  return true;
}

export function markOccurrenceSkipped(userId: number, courseId: string, occurrenceId: string): boolean {
  const db = readDb();
  ensureReminderArrays(db);
  const occurrence = db.reminderOccurrences.find(
    (item: ReminderOccurrence) => item.id === occurrenceId && item.userId === userId && item.courseId === courseId
  ) as ReminderOccurrence | undefined;
  if (!occurrence) {
    return false;
  }
  occurrence.status = "skipped";
  occurrence.actionTakenAt = nowIso();
  occurrence.snoozedUntil = null;
  pushHistory(db, { userId, courseId, occurrenceId, eventType: "skipped" });
  writeDb(db);
  return true;
}

export function snoozeOccurrence(userId: number, courseId: string, occurrenceId: string, minutes: number): boolean {
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > MAX_SNOOZE_MINUTES) {
    return false;
  }

  const db = readDb();
  ensureReminderArrays(db);
  const occurrence = db.reminderOccurrences.find(
    (item: ReminderOccurrence) => item.id === occurrenceId && item.userId === userId && item.courseId === courseId
  ) as ReminderOccurrence | undefined;
  if (!occurrence) {
    return false;
  }

  const base = new Date().getTime();
  occurrence.status = "snoozed";
  occurrence.snoozedUntil = new Date(base + minutes * 60 * 1000).toISOString();
  occurrence.actionTakenAt = nowIso();
  pushHistory(db, { userId, courseId, occurrenceId, eventType: "snoozed" });
  writeDb(db);
  return true;
}

export function markNowTaken(userId: number, courseId: string): ReminderOccurrence | null {
  const db = readDb();
  const course = getCourseByIdInternal(db, userId, courseId);
  if (!course) {
    return null;
  }

  const now = new Date();
  const hhmm = `${`${now.getHours()}`.padStart(2, "0")}:${`${now.getMinutes()}`.padStart(2, "0")}`;
  const occurrence: ReminderOccurrence = {
    id: `occ_${shortId()}`,
    courseId,
    userId,
    scheduledAt: now.toISOString(),
    localTime: hhmm,
    status: "taken",
    actionTakenAt: nowIso(),
    snoozedUntil: null,
    meta: {
      dayNumber: 1,
      totalDays: course.course.durationDays
    }
  };

  db.reminderOccurrences.push(occurrence);
  pushHistory(db, { userId, courseId, occurrenceId: occurrence.id, eventType: "mark_now" });
  writeDb(db);
  return occurrence;
}

export function getPendingReminderNotifications(nowTs: number): Array<{ course: ReminderCourse; occurrence: ReminderOccurrence }> {
  const db = readDb();
  ensureReminderArrays(db);

  const now = new Date(nowTs);
  const nowDate = formatDateYYYYMMDD(now);

  for (const course of db.reminderCourses as ReminderCourse[]) {
    if (course.status !== "active") {
      continue;
    }
    const generated = parseDateYYYYMMDD(course.generatedUntilDate || course.course.startDate);
    const threshold = addDays(parseDateYYYYMMDD(nowDate), 2);
    if (generated <= threshold) {
      const until = course.course.isOpenEnded
        ? formatDateYYYYMMDD(addDays(parseDateYYYYMMDD(nowDate), 7))
        : (course.course.endDate || nowDate);
      generateOccurrencesForCourse(db, course, until);
    }
  }

  const due: Array<{ course: ReminderCourse; occurrence: ReminderOccurrence }> = [];
  for (const occurrence of db.reminderOccurrences as ReminderOccurrence[]) {
    const course = db.reminderCourses.find((item: ReminderCourse) => item.id === occurrence.courseId) as ReminderCourse | undefined;
    if (!course || course.status !== "active") {
      continue;
    }

    const scheduledAtMs = new Date(occurrence.scheduledAt).getTime();
    const snoozedUntilMs = occurrence.snoozedUntil ? new Date(occurrence.snoozedUntil).getTime() : null;
    const dueMs = snoozedUntilMs ?? scheduledAtMs;
    if (Number.isNaN(dueMs) || dueMs > nowTs) {
      continue;
    }

    if (occurrence.status === "scheduled" || occurrence.status === "snoozed") {
      due.push({ course, occurrence });
    }
  }

  if (due.length > 0) {
    writeDb(db);
  }

  return due.sort((a, b) => (a.occurrence.scheduledAt < b.occurrence.scheduledAt ? -1 : 1));
}

export function getReminderStats(userId: number): {
  totalCourses: number;
  activeCourses: number;
  takenCount: number;
  skippedCount: number;
  snoozedCount: number;
} {
  const db = readDb();
  ensureReminderArrays(db);
  const courses = db.reminderCourses.filter((course: ReminderCourse) => course.userId === userId);
  const occurrences = db.reminderOccurrences.filter((occ: ReminderOccurrence) => occ.userId === userId);
  return {
    totalCourses: courses.length,
    activeCourses: courses.filter((course: ReminderCourse) => course.status === "active").length,
    takenCount: occurrences.filter((occ: ReminderOccurrence) => occ.status === "taken").length,
    skippedCount: occurrences.filter((occ: ReminderOccurrence) => occ.status === "skipped").length,
    snoozedCount: occurrences.filter((occ: ReminderOccurrence) => occ.status === "snoozed").length
  };
}

export function listReminderHistory(userId: number, limit = 30): ReminderHistoryEvent[] {
  const db = readDb();
  ensureReminderArrays(db);
  return db.reminderHistory
    .filter((item: ReminderHistoryEvent) => item.userId === userId)
    .sort((a: ReminderHistoryEvent, b: ReminderHistoryEvent) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, Math.max(1, limit));
}

export function getCourseProgress(course: ReminderCourse): { dayCurrent: number; dayTotal: number | null } {
  const start = parseDateYYYYMMDD(course.course.startDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const elapsed = Math.floor((today.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  const dayCurrent = Math.max(1, elapsed);
  if (course.course.durationDays && !course.course.isOpenEnded) {
    return {
      dayCurrent: Math.min(dayCurrent, course.course.durationDays),
      dayTotal: course.course.durationDays
    };
  }
  return { dayCurrent, dayTotal: null };
}

// Legacy API (kept for backward compatibility with existing card reminders)
export function addReminder(userId: number, cardId: string, runAt: number) {
  const db = readDb();
  ensureReminderArrays(db);
  db.reminders.push({
    userId,
    cardId,
    runAt,
    sent: false
  } satisfies LegacyReminder);
  writeDb(db);
}

export function getPendingReminders(now: number) {
  const db = readDb();
  ensureReminderArrays(db);
  return db.reminders.filter((r: LegacyReminder) => !r.sent && r.runAt <= now);
}

export function markReminderSent(userId: number, cardId: string) {
  const db = readDb();
  ensureReminderArrays(db);
  const item = db.reminders.find((r: LegacyReminder) => r.userId === userId && r.cardId === cardId && !r.sent);
  if (item) item.sent = true;
  writeDb(db);
}
