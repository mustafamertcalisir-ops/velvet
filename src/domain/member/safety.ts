/**
 * Member safety V1: block and report from any viewed profile or conversation
 * (DEC-054).
 *
 * Blocking is silent and total: the blocked member is not told, the match and
 * conversation end, and neither member is introduced to or can open the other
 * again. To the blocked member the profile is simply unavailable — the same
 * response as for any unknown member, so a block cannot be detected.
 *
 * Reports are structured (no free-text channel yet) and go to the membership
 * team. The reported member is not told.
 */
import type { ISODateTime } from '../models';

export const REPORT_REASONS = [
  'NOT_GENUINE',
  'INAPPROPRIATE_PHOTOS',
  'HARASSMENT',
  'SAFETY_CONCERN',
  'UNDER_18',
  'OTHER',
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

export function isReportReason(v: unknown): v is ReportReason {
  return typeof v === 'string' && (REPORT_REASONS as readonly string[]).includes(v);
}

export type ReportContext = 'profile' | 'conversation';

export type Block = {
  id: string;
  blockerId: string;
  blockedId: string;
  createdAt: ISODateTime;
};

export type Report = {
  id: string;
  reporterId: string;
  reportedId: string;
  reason: ReportReason;
  context: ReportContext;
  conversationId: string | null;
  /** Moderation state — internal. */
  status: 'open' | 'reviewed';
  createdAt: ISODateTime;
};

export function isBlockedBetween(blocks: readonly Pick<Block, 'blockerId' | 'blockedId'>[], a: string, b: string): boolean {
  return blocks.some((x) => (x.blockerId === a && x.blockedId === b) || (x.blockerId === b && x.blockedId === a));
}

/** Everyone blocked by, or blocking, this member. */
export function blockedSet(blocks: readonly Pick<Block, 'blockerId' | 'blockedId'>[], memberId: string): Set<string> {
  const out = new Set<string>();
  for (const b of blocks) {
    if (b.blockerId === memberId) out.add(b.blockedId);
    if (b.blockedId === memberId) out.add(b.blockerId);
  }
  return out;
}
