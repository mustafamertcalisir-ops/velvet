/**
 * Conversations V1: text only, between two matched members (DEC-053).
 * Not built yet: voice, photos, video, typing indicators, read receipts,
 * reactions, GIFs.
 */
import type { ISODateTime } from '../models';
import { invalid, valid, type Validation } from '../validation/result';

export type Conversation = {
  id: string;
  matchId: string;
  memberIds: [string, string];
  createdAt: ISODateTime;
  /** Closed when the match ends (block). No new messages after this. */
  closedAt: ISODateTime | null;
  /** Per-member "last opened" — used only for the member's own unread mark, never shown to the other. */
  openedAt: Record<string, ISODateTime | null>;
};

export type Message = {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  /** Client idempotency key: a retried send never duplicates a message. */
  clientMessageId: string;
  createdAt: ISODateTime;
};

export const MESSAGE_MAX = 2000;

export type MessageError = 'empty' | 'too_long';

/** Trim, normalise line endings, and keep at most one blank line in a row. */
export function normalizeMessage(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function validateMessage(raw: string): Validation<string, MessageError> {
  const body = normalizeMessage(raw);
  if (!body) return invalid('empty');
  if (body.length > MESSAGE_MAX) return invalid('too_long');
  return valid(body);
}

/** Server rule: a message can be sent only in an open conversation of an active match, with no block. */
export function canSendMessage(input: {
  isParticipant: boolean;
  matchActive: boolean;
  conversationOpen: boolean;
  blocked: boolean;
}): boolean {
  return input.isParticipant && input.matchActive && input.conversationOpen && !input.blocked;
}

// --- Presentation helpers (pure) ------------------------------------------------

export type ThreadMessage = { id: string; fromSelf: boolean; body: string; createdAt: ISODateTime };

export type MessageRun = { fromSelf: boolean; messages: ThreadMessage[] };
export type MessageDay = { day: string; runs: MessageRun[] };

/** Consecutive messages from the same person within this gap read as one run. */
const RUN_GAP_MS = 5 * 60 * 1000;

function localDayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Group a thread into calendar days, and each day into runs by sender. */
export function groupMessages(messages: readonly ThreadMessage[]): MessageDay[] {
  const sorted = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const days: MessageDay[] = [];
  for (const m of sorted) {
    const key = localDayKey(m.createdAt);
    let day = days[days.length - 1];
    if (!day || day.day !== key) {
      day = { day: key, runs: [] };
      days.push(day);
    }
    const run = day.runs[day.runs.length - 1];
    const last = run?.messages[run.messages.length - 1];
    if (
      run &&
      last &&
      run.fromSelf === m.fromSelf &&
      new Date(m.createdAt).getTime() - new Date(last.createdAt).getTime() < RUN_GAP_MS
    ) {
      run.messages.push(m);
    } else {
      day.runs.push({ fromSelf: m.fromSelf, messages: [m] });
    }
  }
  return days;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "Today", "Yesterday", "5 October", or "5 October 2025" for another year. */
export function dayLabel(dayKey: string, now: Date, words: { today: string; yesterday: string }): string {
  const today = localDayKey(now.toISOString());
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (dayKey === today) return words.today;
  if (dayKey === localDayKey(y.toISOString())) return words.yesterday;
  const [year, month, day] = dayKey.split('-').map(Number) as [number, number, number];
  const base = `${day} ${MONTHS[month - 1]}`;
  return year === now.getFullYear() ? base : `${base} ${year}`;
}

/** 24-hour clock, as read in Türkiye: "09:05". */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "5 October" (or with the year when it isn't this year). */
export function shortDate(iso: string, now: Date): string {
  const d = new Date(iso);
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** "Monday, 5 October" — Home's dateline. */
export function dateline(now: Date): string {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return `${days[now.getDay()]}, ${now.getDate()} ${MONTHS[now.getMonth()]}`;
}
